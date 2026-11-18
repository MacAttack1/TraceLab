//go:build windows

package osutil

import (
	"errors"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	shell32           = windows.NewLazySystemDLL("shell32.dll")
	ole32             = windows.NewLazySystemDLL("ole32.dll")
	user32            = windows.NewLazySystemDLL("user32.dll")
	kernel32          = windows.NewLazySystemDLL("kernel32.dll")
	pSHBrowse         = shell32.NewProc("SHBrowseForFolderW")
	pSHGetPath        = shell32.NewProc("SHGetPathFromIDListW")
	pCoTaskMemFree    = ole32.NewProc("CoTaskMemFree")
	pCoInit           = ole32.NewProc("CoInitializeEx")
	pCoUninit         = ole32.NewProc("CoUninitialize")
	pSendMessage      = user32.NewProc("SendMessageW")
	pGetForeground    = user32.NewProc("GetForegroundWindow")
	pGlobalMemStatus  = kernel32.NewProc("GlobalMemoryStatusEx")
	pGetDiskFreeSpace = kernel32.NewProc("GetDiskFreeSpaceExW")
)

type browseInfo struct {
	Owner       uintptr
	Root        uintptr
	DisplayName *uint16
	Title       *uint16
	Flags       uint32
	Callback    uintptr
	LParam      uintptr
	Image       int32
}

var browseCB = syscall.NewCallback(func(hwnd, msg, lp, data uintptr) uintptr {
	if msg == 1 && data != 0 { // BFFM_INITIALIZED: preselect the starting folder
		pSendMessage.Call(hwnd, 0x0400+103, 1, data) // BFFM_SETSELECTIONW
	}
	return 0
})

// PickFolder shows the Windows folder picker and returns the chosen folder ("" if cancelled).
func PickFolder(title, start string) (string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	pCoInit.Call(0, 0x2) // COINIT_APARTMENTTHREADED, needed for the new-style dialog
	defer pCoUninit.Call()
	t, _ := syscall.UTF16PtrFromString(title)
	name := make([]uint16, 260)
	var startPtr uintptr
	if start != "" {
		s, _ := syscall.UTF16PtrFromString(start)
		startPtr = uintptr(unsafe.Pointer(s))
	}
	owner, _, _ := pGetForeground.Call()
	bi := browseInfo{Owner: owner, DisplayName: &name[0], Title: t, Flags: 0x1 | 0x10 | 0x40, Callback: browseCB, LParam: startPtr} // RETURNONLYFSDIRS | EDITBOX | NEWDIALOGSTYLE
	pidl, _, _ := pSHBrowse.Call(uintptr(unsafe.Pointer(&bi)))
	if pidl == 0 {
		return "", nil
	}
	defer pCoTaskMemFree.Call(pidl)
	buf := make([]uint16, 1024)
	if ok, _, _ := pSHGetPath.Call(pidl, uintptr(unsafe.Pointer(&buf[0]))); ok == 0 {
		return "", errors.New("that location isn't a folder on disk")
	}
	return syscall.UTF16ToString(buf), nil
}

type memStatus struct {
	Length, MemoryLoad                                    uint32
	TotalPhys, AvailPhys, TotalPage, AvailPage, TotalVirt uint64
	AvailVirt, AvailExtended                              uint64
}

// DetectHardware reads the CPU, memory and graphics adapters (with their real VRAM, which
// WMI caps at 4 GB) from the registry.
func DetectHardware() Hardware {
	h := Hardware{Cores: runtime.NumCPU()}
	ms := memStatus{Length: uint32(unsafe.Sizeof(memStatus{}))}
	if r, _, _ := pGlobalMemStatus.Call(uintptr(unsafe.Pointer(&ms))); r != 0 {
		h.RAM = ms.TotalPhys
	}
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\CentralProcessor\0`, registry.QUERY_VALUE); err == nil {
		h.CPU, _, _ = k.GetStringValue("ProcessorNameString")
		h.CPU = strings.TrimSpace(h.CPU)
		k.Close()
	}
	const cls = `SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}`
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, cls, registry.ENUMERATE_SUB_KEYS); err == nil {
		subs, _ := k.ReadSubKeyNames(0)
		k.Close()
		seen := map[string]bool{}
		for _, s := range subs {
			if len(s) != 4 {
				continue
			}
			sk, err := registry.OpenKey(registry.LOCAL_MACHINE, cls+`\`+s, registry.QUERY_VALUE)
			if err != nil {
				continue
			}
			name, _, _ := sk.GetStringValue("DriverDesc")
			var vram uint64
			if v, _, err := sk.GetIntegerValue("HardwareInformation.qwMemorySize"); err == nil {
				vram = v
			} else if b, _, err := sk.GetBinaryValue("HardwareInformation.MemorySize"); err == nil && len(b) >= 4 {
				vram = uint64(b[0]) | uint64(b[1])<<8 | uint64(b[2])<<16 | uint64(b[3])<<24
			} else if v, _, err := sk.GetIntegerValue("HardwareInformation.MemorySize"); err == nil {
				vram = v
			}
			sk.Close()
			if name == "" || seen[name] || strings.Contains(strings.ToLower(name), "basic display") || strings.Contains(strings.ToLower(name), "remote") {
				continue
			}
			seen[name] = true
			h.GPUs = append(h.GPUs, GPU{Name: name, Vendor: vendorOf(name), VRAM: vram, Integrated: isIntegrated(name, vram)})
		}
	}
	return h
}

// FreeSpace returns the free bytes available to this user on the drive holding path.
func FreeSpace(path string) uint64 {
	for p := path; p != ""; {
		u, _ := syscall.UTF16PtrFromString(p)
		var free uint64
		if r, _, _ := pGetDiskFreeSpace.Call(uintptr(unsafe.Pointer(u)), uintptr(unsafe.Pointer(&free)), 0, 0); r != 0 {
			return free
		}
		i := strings.LastIndexAny(strings.TrimRight(p, `\/`), `\/`)
		if i <= 0 {
			break
		}
		p = p[:i+1]
	}
	return 0
}

// HideWindow stops a console child process from flashing a window.
func HideWindow(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}

// Reveal opens Explorer with the file or folder selected.
func Reveal(path string) { _ = exec.Command("explorer.exe", "/select,", path).Start() }
