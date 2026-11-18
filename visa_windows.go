//go:build windows

package main

// USB (USBTMC) and other VISA instruments, through whatever VISA library is installed: NI-VISA,
// Keysight IO Libraries, R&S VISA, or the NI-VISA runtime that Rigol's UltraSigma and Siglent's
// EasyScope install. Windows has no built-in USBTMC driver, so VISA is how scopes and bench supplies
// on a plain USB cable are reached. Loaded lazily: without VISA the option just reports "not installed".

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	viAttrTmoValue  = 0x3FFF001A
	viSuccessMaxCnt = 0x3FFF0006
	viErrorTmo      = -1073807339 // 0xBFFF0015
	viErrorRsrcNFnd = -1073807343 // 0xBFFF0011
)

var (
	visaOnce sync.Once
	visaDLL  *windows.LazyDLL
	visaRM   uint32
	visaErr  error
	visaProc = map[string]*windows.LazyProc{}
)

func visaLoad() error {
	visaOnce.Do(func() {
		for _, n := range []string{"visa64.dll", "visa32.dll"} {
			d := windows.NewLazySystemDLL(n)
			if d.Load() == nil {
				visaDLL = d
				break
			}
		}
		if visaDLL == nil {
			visaErr = errors.New("no VISA library is installed. Install NI-VISA (free from ni.com) or Keysight IO Libraries to use USB scopes and supplies, or connect the instrument over the network instead")
			return
		}
		for _, f := range []string{"viOpenDefaultRM", "viFindRsrc", "viFindNext", "viOpen", "viClose", "viRead", "viWrite", "viSetAttribute"} {
			visaProc[f] = visaDLL.NewProc(f)
		}
		var rm uint32
		if st := visaCall("viOpenDefaultRM", uintptr(unsafe.Pointer(&rm))); st < 0 {
			visaErr = fmt.Errorf("VISA didn't start (status %#x)", uint32(st))
			return
		}
		visaRM = rm
	})
	return visaErr
}

func visaCall(name string, args ...uintptr) int32 {
	r, _, _ := visaProc[name].Call(args...)
	return int32(uint32(r))
}

func cstr(s string) *byte { b, _ := syscall.BytePtrFromString(s); return b }

func visaAvailable() bool { return visaLoad() == nil }

// listVISA returns VISA resources such as "USB0::0x1AB1::0x04CE::DS1ZA1234::INSTR".
func listVISA() ([]portInfo, error) {
	if err := visaLoad(); err != nil {
		return nil, err
	}
	var list, cnt uint32
	desc := make([]byte, 512)
	st := visaCall("viFindRsrc", uintptr(visaRM), uintptr(unsafe.Pointer(cstr("?*INSTR"))), uintptr(unsafe.Pointer(&list)), uintptr(unsafe.Pointer(&cnt)), uintptr(unsafe.Pointer(&desc[0])))
	if st == viErrorRsrcNFnd {
		return nil, nil
	}
	if st < 0 {
		return nil, fmt.Errorf("VISA search failed (status %#x)", uint32(st))
	}
	var out []portInfo
	add := func() {
		s := strings.TrimRight(string(desc), "\x00")
		if i := strings.IndexByte(s, 0); i >= 0 {
			s = s[:i]
		}
		if s != "" && !strings.HasPrefix(strings.ToUpper(s), "ASRL") { // COM ports are listed separately
			out = append(out, portInfo{Port: s, Desc: visaDesc(s)})
		}
	}
	add()
	for i := uint32(1); i < cnt; i++ {
		for j := range desc {
			desc[j] = 0
		}
		if visaCall("viFindNext", uintptr(list), uintptr(unsafe.Pointer(&desc[0]))) < 0 {
			break
		}
		add()
	}
	visaCall("viClose", uintptr(list))
	return out, nil
}

var usbVendors = map[string]string{"0X1AB1": "Rigol", "0XF4EC": "Siglent", "0XF4ED": "Siglent", "0X0957": "Keysight", "0X2A8D": "Keysight", "0X0699": "Tektronix", "0X5345": "Owon", "0X0AAD": "R&S", "0X2184": "GW Instek", "0X05FF": "LeCroy"}

func visaDesc(r string) string {
	p := strings.Split(strings.ToUpper(r), "::")
	if len(p) >= 4 && strings.HasPrefix(p[0], "USB") {
		if v := usbVendors[p[1]]; v != "" {
			return v + " USB instrument · " + p[3]
		}
	}
	if strings.HasPrefix(p[0], "TCPIP") {
		return "Network instrument · " + p[1]
	}
	return r
}

type visaPort struct {
	vi  uint32
	buf []byte
}

func openVISA(rsrc string) (rawPort, error) {
	if err := visaLoad(); err != nil {
		return nil, err
	}
	var vi uint32
	if st := visaCall("viOpen", uintptr(visaRM), uintptr(unsafe.Pointer(cstr(rsrc))), 0, 2000, uintptr(unsafe.Pointer(&vi))); st < 0 {
		return nil, fmt.Errorf("couldn't open %s through VISA (status %#x). Is another program connected to it?", rsrc, uint32(st))
	}
	visaCall("viSetAttribute", uintptr(vi), viAttrTmoValue, 150)
	return &visaPort{vi: vi}, nil
}

// Read returns 0, nil when nothing arrives within the VISA timeout, matching the other ports.
func (v *visaPort) Read(b []byte) (int, error) {
	var n uint32
	st := visaCall("viRead", uintptr(v.vi), uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)), uintptr(unsafe.Pointer(&n)))
	if st == viErrorTmo {
		return int(n), nil
	}
	if st < 0 {
		return int(n), fmt.Errorf("VISA read failed (status %#x)", uint32(st))
	}
	return int(n), nil
}

func (v *visaPort) Write(b []byte) (int, error) {
	var n uint32
	if len(b) == 0 {
		return 0, nil
	}
	if st := visaCall("viWrite", uintptr(v.vi), uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)), uintptr(unsafe.Pointer(&n))); st < 0 {
		return int(n), fmt.Errorf("VISA write failed (status %#x)", uint32(st))
	}
	return int(n), nil
}

func (v *visaPort) Close() error { visaCall("viClose", uintptr(v.vi)); return nil }
