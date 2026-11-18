//go:build !windows

package osutil

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// PickFolder has no native dialog off Windows; the UI falls back to typing a path.
func PickFolder(title, start string) (string, error) {
	if p := os.Getenv("TRACELAB_FAKE_PICK"); p != "" { // test hook
		return p, nil
	}
	return "", errors.New("folder picker is only available on Windows")
}

// DetectHardware reads /proc on Linux. TRACELAB_FAKE_HW (JSON) overrides it for tests.
func DetectHardware() Hardware {
	if s := os.Getenv("TRACELAB_FAKE_HW"); s != "" {
		var h Hardware
		if json.Unmarshal([]byte(s), &h) == nil {
			for i := range h.GPUs {
				if h.GPUs[i].Vendor == "" {
					h.GPUs[i].Vendor = vendorOf(h.GPUs[i].Name)
				}
				if !h.GPUs[i].Integrated {
					h.GPUs[i].Integrated = isIntegrated(h.GPUs[i].Name, h.GPUs[i].VRAM)
				}
			}
			return h
		}
	}
	h := Hardware{Cores: runtime.NumCPU()}
	if f, err := os.Open("/proc/meminfo"); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if strings.HasPrefix(sc.Text(), "MemTotal:") {
				fs := strings.Fields(sc.Text())
				if len(fs) >= 2 {
					kb, _ := strconv.ParseUint(fs[1], 10, 64)
					h.RAM = kb * 1024
				}
			}
		}
		f.Close()
	}
	if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(l, "model name") {
				if i := strings.Index(l, ":"); i > 0 {
					h.CPU = strings.TrimSpace(l[i+1:])
					break
				}
			}
		}
	}
	return h
}

func FreeSpace(path string) uint64 {
	for p := path; p != ""; {
		var st syscall.Statfs_t
		if syscall.Statfs(p, &st) == nil {
			return st.Bavail * uint64(st.Bsize)
		}
		i := strings.LastIndex(strings.TrimRight(p, "/"), "/")
		if i < 0 {
			break
		}
		if i == 0 {
			p = "/"
			if path == "/" {
				break
			}
			continue
		}
		p = p[:i]
	}
	return 0
}

func HideWindow(c *exec.Cmd) {}

func Reveal(path string) { _ = exec.Command("xdg-open", path).Start() }
