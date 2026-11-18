// Package osutil holds the small OS-specific helpers shared by Trace Lab and its installer:
// the native folder picker, free disk space and hardware detection.
package osutil

// GPU is one graphics adapter. VRAM is its dedicated memory in bytes (0 when unknown).
// Integrated graphics report little dedicated memory and use system RAM instead.
type GPU struct {
	Name       string `json:"name"`
	Vendor     string `json:"vendor"` // nvidia | amd | intel | other
	VRAM       uint64 `json:"vram"`
	Integrated bool   `json:"integrated"`
}

type Hardware struct {
	CPU   string `json:"cpu"`
	Cores int    `json:"cores"`
	RAM   uint64 `json:"ram"` // bytes
	GPUs  []GPU  `json:"gpus"`
}

// BestGPU returns the adapter with the most dedicated memory, preferring discrete cards.
func (h Hardware) BestGPU() *GPU {
	var best *GPU
	for i := range h.GPUs {
		g := &h.GPUs[i]
		if best == nil || (best.Integrated && !g.Integrated) || (best.Integrated == g.Integrated && g.VRAM > best.VRAM) {
			best = g
		}
	}
	return best
}

func vendorOf(name string) string {
	n := lower(name)
	switch {
	case contains(n, "nvidia") || contains(n, "geforce") || contains(n, "quadro") || contains(n, "rtx"):
		return "nvidia"
	case contains(n, "amd") || contains(n, "radeon"):
		return "amd"
	case contains(n, "intel") || contains(n, " arc"):
		return "intel"
	}
	return "other"
}

func isIntegrated(name string, vram uint64) bool {
	n := lower(name)
	if contains(n, "microsoft basic") || contains(n, "remote display") {
		return true
	}
	if contains(n, "arc a") || contains(n, "arc b") || contains(n, "arc(tm) a") || contains(n, "arc(tm) b") || contains(n, "geforce") || contains(n, "rtx") || contains(n, "radeon rx") || contains(n, "radeon pro") {
		return false
	}
	if contains(n, "uhd") || contains(n, "iris") || contains(n, "intel(r) graphics") || contains(n, "arc graphics") || contains(n, "arc(tm) graphics") || contains(n, "radeon(tm) graphics") || contains(n, "radeon graphics") || contains(n, "vega") || contains(n, "radeon 7") || contains(n, "radeon 8") {
		return true
	}
	return vram > 0 && vram < 2<<30
}

func lower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// IsIntegratedName reports whether an adapter name looks like integrated graphics (for tests and the UI).
func IsIntegratedName(name string) bool { return isIntegrated(name, 0) }
