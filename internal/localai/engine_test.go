package localai

import "testing"

func TestPickAssets(t *testing.T) {
	a := func(n ...string) []ghAsset {
		var out []ghAsset
		for _, x := range n {
			out = append(out, ghAsset{Name: x})
		}
		return out
	}
	srcOnly := a("v1.0.0 source code.zip", "nightly-tag.txt")
	b := a("llama-b9326-bin-win-cpu-x64.zip", "llama-b9326-bin-win-cpu-arm64.zip", "llama-b9326-bin-win-vulkan-x64.zip", "llama-b9326-bin-win-cuda-12.4-x64.zip",
		"llama-b9326-bin-win-cuda-13.5-x64.zip", "cudart-llama-bin-win-cuda-12.4-x64.zip", "cudart-llama-bin-win-cuda-13.5-x64.zip", "llama-b9326-bin-win-hip-radeon-x64.zip",
		"llama-b9326-bin-ubuntu-vulkan-x64.zip", "llama-b9326-bin-macos-arm64.zip")
	if got := pickAssets(srcOnly, "vulkan", "win"); got != nil {
		t.Fatalf("source-only release should have no engine, got %v", got[0].Name)
	}
	names := func(x []*ghAsset) []string {
		var o []string
		for _, y := range x {
			o = append(o, y.Name)
		}
		return o
	}
	for v, want := range map[string][]string{
		"vulkan": {"llama-b9326-bin-win-vulkan-x64.zip"},
		"cpu":    {"llama-b9326-bin-win-cpu-x64.zip"},
		"cuda":   {"llama-b9326-bin-win-cuda-13.5-x64.zip", "cudart-llama-bin-win-cuda-13.5-x64.zip"},
	} {
		got := names(pickAssets(b, v, "win"))
		if len(got) != len(want) || got[0] != want[0] || (len(want) > 1 && got[1] != want[1]) {
			t.Errorf("%s: got %v want %v", v, got, want)
		}
	}
	if got := names(pickAssets(a("llama-v1.2.0-bin-win-vulkan-x64.zip"), "vulkan", "win")); len(got) != 1 {
		t.Errorf("v-tagged names should match too: %v", got)
	}
}
