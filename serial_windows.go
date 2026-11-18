//go:build windows

package main

// Serial (COM) ports on Windows: USB-serial meters and supplies (CH340, CP210x, FTDI, CDC-ACM) show up
// as COMx. Opened with CreateFile and configured with SetCommState; reads return after ~40 ms so the
// caller can frame replies by terminator or idle time.

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

type winSerial struct{ h windows.Handle }

func openSerial(name string, baud int) (rawPort, error) {
	if baud <= 0 {
		baud = 9600
	}
	path := name
	if !strings.HasPrefix(path, `\\.\`) {
		path = `\\.\` + name // needed for COM10 and above
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return nil, fmt.Errorf("%s is in use by another program (close the instrument's own software and try again)", name)
		}
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return nil, fmt.Errorf("%s isn't there: check the USB cable and the driver (Device Manager → Ports)", name)
		}
		return nil, fmt.Errorf("couldn't open %s: %v", name, err)
	}
	var dcb windows.DCB
	dcb.DCBlength = uint32(unsafe.Sizeof(dcb))
	if err := windows.GetCommState(h, &dcb); err != nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("%s: %v", name, err)
	}
	dcb.BaudRate = uint32(baud)
	dcb.ByteSize = 8
	dcb.Parity = 0   // none
	dcb.StopBits = 0 // one
	// fBinary=1, fDtrControl=ENABLE(1<<4), fRtsControl=ENABLE(1<<12). Many USB meters power their
	// optocoupler from DTR/RTS, so keep both asserted.
	dcb.Flags = 1 | (1 << 4) | (1 << 12)
	if err := windows.SetCommState(h, &dcb); err != nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("%s doesn't accept %d baud: %v", name, baud, err)
	}
	to := windows.CommTimeouts{ReadIntervalTimeout: 0xFFFFFFFF, ReadTotalTimeoutMultiplier: 0xFFFFFFFF, ReadTotalTimeoutConstant: 40, WriteTotalTimeoutConstant: 2000}
	if err := windows.SetCommTimeouts(h, &to); err != nil {
		windows.CloseHandle(h)
		return nil, err
	}
	_ = windows.PurgeComm(h, windows.PURGE_RXCLEAR|windows.PURGE_TXCLEAR)
	return &winSerial{h: h}, nil
}

func (s *winSerial) Read(b []byte) (int, error) {
	var n uint32
	if err := windows.ReadFile(s.h, b, &n, nil); err != nil {
		return int(n), err
	}
	return int(n), nil
}

func (s *winSerial) Write(b []byte) (int, error) {
	var n uint32
	err := windows.WriteFile(s.h, b, &n, nil)
	return int(n), err
}

func (s *winSerial) Close() error { return windows.CloseHandle(s.h) }

var comRe = regexp.MustCompile(`\((COM\d+)\)`)

// listSerialPorts returns COM ports with their Device Manager names, e.g. "USB-SERIAL CH340 (COM5)".
func listSerialPorts() []portInfo {
	seen := map[string]string{}
	ports := windows.GUID{Data1: 0x4D36E978, Data2: 0xE325, Data3: 0x11CE, Data4: [8]byte{0xBF, 0xC1, 0x08, 0x00, 0x2B, 0xE1, 0x03, 0x18}}
	if set, err := windows.SetupDiGetClassDevsEx(&ports, "", 0, windows.DIGCF_PRESENT, 0, ""); err == nil {
		for i := 0; ; i++ {
			d, err := set.EnumDeviceInfo(i)
			if err != nil {
				break
			}
			v, err := set.DeviceRegistryProperty(d, windows.SPDRP_FRIENDLYNAME)
			if err != nil {
				continue
			}
			if s, ok := v.(string); ok {
				if m := comRe.FindStringSubmatch(s); m != nil {
					seen[strings.ToUpper(m[1])] = s
				}
			}
		}
		set.Close()
	}
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, `HARDWARE\DEVICEMAP\SERIALCOMM`, registry.QUERY_VALUE); err == nil {
		names, _ := k.ReadValueNames(0)
		for _, n := range names {
			if v, _, err := k.GetStringValue(n); err == nil {
				v = strings.ToUpper(v)
				if _, ok := seen[v]; !ok {
					seen[v] = v
				}
			}
		}
		k.Close()
	}
	var out []portInfo
	for p, d := range seen {
		out = append(out, portInfo{Port: p, Desc: d})
	}
	sort.Slice(out, func(i, j int) bool { return comNum(out[i].Port) < comNum(out[j].Port) })
	return out
}

func comNum(s string) int {
	n := 0
	fmt.Sscanf(strings.TrimPrefix(strings.ToUpper(s), "COM"), "%d", &n)
	return n
}
