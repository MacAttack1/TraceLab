//go:build linux

package main

// Serial ports on Linux (/dev/ttyUSB*, /dev/ttyACM*): raw 8N1 with VMIN=0/VTIME=1 so reads return
// within 100 ms. Trace Lab ships for Windows; this keeps the instrument code runnable and testable.

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unsafe"
)

type unixSerial struct{ f *os.File }

var bauds = map[int]uint32{1200: syscall.B1200, 2400: syscall.B2400, 4800: syscall.B4800, 9600: syscall.B9600, 19200: syscall.B19200,
	38400: syscall.B38400, 57600: syscall.B57600, 115200: syscall.B115200, 230400: syscall.B230400, 460800: syscall.B460800, 921600: syscall.B921600}

func openSerial(name string, baud int) (rawPort, error) {
	if baud <= 0 {
		baud = 9600
	}
	sp, ok := bauds[baud]
	if !ok {
		return nil, fmt.Errorf("unsupported baud rate %d", baud)
	}
	f, err := os.OpenFile(name, syscall.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, fmt.Errorf("couldn't open %s: %v", name, err)
	}
	var t syscall.Termios
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), syscall.TCGETS, uintptr(unsafe.Pointer(&t))); e != 0 {
		f.Close()
		return nil, fmt.Errorf("%s isn't a serial port: %v", name, e)
	}
	t.Iflag = 0
	t.Oflag = 0
	t.Lflag = 0
	t.Cflag = syscall.CS8 | syscall.CREAD | syscall.CLOCAL | sp
	t.Ispeed, t.Ospeed = sp, sp
	t.Cc[syscall.VMIN] = 0
	t.Cc[syscall.VTIME] = 1
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), syscall.TCSETS, uintptr(unsafe.Pointer(&t))); e != 0 {
		f.Close()
		return nil, fmt.Errorf("%s: %v", name, e)
	}
	return &unixSerial{f: f}, nil
}

func (s *unixSerial) Read(b []byte) (int, error) {
	n, err := s.f.Read(b)
	if n == 0 && err != nil && strings.Contains(err.Error(), "EOF") {
		return 0, nil // VTIME expired with nothing to read
	}
	return n, err
}
func (s *unixSerial) Write(b []byte) (int, error) { return s.f.Write(b) }
func (s *unixSerial) Close() error                { return s.f.Close() }

func listSerialPorts() []portInfo {
	var out []portInfo
	for _, pat := range []string{"/dev/ttyUSB*", "/dev/ttyACM*"} {
		m, _ := filepath.Glob(pat)
		for _, p := range m {
			out = append(out, portInfo{Port: p, Desc: p})
		}
	}
	for _, p := range strings.Split(os.Getenv("TRACELAB_EXTRA_PORTS"), ",") { // test hook
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, portInfo{Port: p, Desc: "Test port " + filepath.Base(p)})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out
}
