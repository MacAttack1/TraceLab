package localai

import (
	"testing"

	"tracelab/internal/osutil"
)

func TestAdvise(t *testing.T) {
	G := uint64(1 << 30)
	cases := []struct {
		name string
		hw   osutil.Hardware
		rec  string
		eng  string
	}{
		{"no gpu 8GB", osutil.Hardware{RAM: 8 * G}, "gemma4-e2b", "cpu"},
		{"no gpu 16GB", osutil.Hardware{RAM: 16 * G}, "gemma4-e4b", "cpu"},
		{"igpu 16GB", osutil.Hardware{RAM: 16 * G, GPUs: []osutil.GPU{{Name: "AMD Radeon(TM) Graphics", Vendor: "amd", VRAM: 512 << 20, Integrated: true}}}, "gemma4-e4b", "vulkan"},
		{"rtx 4060 8GB", osutil.Hardware{RAM: 32 * G, GPUs: []osutil.GPU{{Name: "NVIDIA GeForce RTX 4060", Vendor: "nvidia", VRAM: 8 * G}}}, "gemma4-e4b", "vulkan"},
		{"rx 7800 16GB", osutil.Hardware{RAM: 32 * G, GPUs: []osutil.GPU{{Name: "AMD Radeon RX 7800 XT", Vendor: "amd", VRAM: 16 * G}}}, "gemma4-26b", "vulkan"},
		{"rtx 4090 24GB", osutil.Hardware{RAM: 64 * G, GPUs: []osutil.GPU{{Name: "NVIDIA GeForce RTX 4090", Vendor: "nvidia", VRAM: 24 * G}}}, "gemma4-31b", "vulkan"},
	}
	for _, c := range cases {
		a := Advise(c.hw)
		if a.Recommended != c.rec || a.Engine != c.eng {
			t.Errorf("%s: got %s/%s want %s/%s (%+v)", c.name, a.Recommended, a.Engine, c.rec, c.eng, a.Fits)
		}
	}
}

func TestIntegratedNames(t *testing.T) {
	for name, want := range map[string]bool{"Intel(R) Arc(TM) Graphics": true, "Intel(R) Arc(TM) A770 Graphics": false, "Intel(R) UHD Graphics 620": true,
		"AMD Radeon(TM) Graphics": true, "AMD Radeon RX 7900 XTX": false, "NVIDIA GeForce RTX 3060 Laptop GPU": false} {
		if got := osutil.IsIntegratedName(name); got != want {
			t.Errorf("%s: integrated=%v want %v", name, got, want)
		}
	}
}
