package localai

import (
	"os"
	"path/filepath"
	"testing"
)

func sparse(t *testing.T, p string, size int64) {
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	_ = f.Truncate(size)
	f.Close()
}

func TestScanExternalAndRecover(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	lm := filepath.Join(home, ".lmstudio", "models")
	sparse(t, filepath.Join(lm, "lmstudio-community", "gemma-3-12b-it-GGUF", "gemma-3-12b-it-Q4_K_M.gguf"), 300<<20)
	sparse(t, filepath.Join(lm, "lmstudio-community", "gemma-3-12b-it-GGUF", "mmproj-model-f16.gguf"), 50<<20)
	sparse(t, filepath.Join(lm, "x", "tiny.gguf"), 1<<20) // too small to be a chat model
	ol := filepath.Join(home, ".ollama", "models")
	sparse(t, filepath.Join(ol, "blobs", "sha256-aaa"), 400<<20)
	sparse(t, filepath.Join(ol, "blobs", "sha256-bbb"), 60<<20)
	_ = os.MkdirAll(filepath.Join(ol, "manifests", "registry.ollama.ai", "library", "qwen3"), 0o755)
	_ = os.WriteFile(filepath.Join(ol, "manifests", "registry.ollama.ai", "library", "qwen3", "8b"), []byte(`{"layers":[{"mediaType":"application/vnd.ollama.image.model","digest":"sha256:aaa","size":419430400},{"mediaType":"application/vnd.ollama.image.projector","digest":"sha256:bbb","size":62914560}]}`), 0o644)
	extra := t.TempDir()
	sparse(t, filepath.Join(extra, "my-model-Q5_K_M.gguf"), 200<<20)

	m := NewManager(filepath.Join(home, "tl-models"))
	m.ExtraDirs = []string{extra}
	got := ScanExternal(m.ExtraDirs)
	by := map[string]External{}
	for _, e := range got {
		by[e.Source] = e
	}
	if len(got) != 3 {
		t.Fatalf("want 3 models, got %+v", got)
	}
	if e := by["LM Studio"]; e.Vision == "" || e.Name != "lmstudio-community/gemma-3-12b-it-GGUF · gemma-3-12b-it-Q4_K_M" {
		t.Errorf("lm studio: %+v", e)
	}
	if e := by["Ollama"]; e.Name != "qwen3:8b" || e.Vision == "" {
		t.Errorf("ollama: %+v", e)
	}
	if mi, ok := m.ModelInstalled(by["Folder"].ID); !ok || mi.Model != by["Folder"].Path {
		t.Errorf("external id not usable: %+v %v", mi, ok)
	}
	// Trace Lab's own folder with the files but no model.json
	d := filepath.Join(m.Dir, "models", "gemma4-e4b")
	sparse(t, filepath.Join(d, "gemma-4-E4B-it-Q4_0.gguf"), 300<<20)
	sparse(t, filepath.Join(d, "mmproj-gemma-4-E4B-it-Q8_0.gguf"), 60<<20)
	sparse(t, filepath.Join(d, "mtp-gemma-4-E4B-it-Q4_0.gguf"), 60<<20)
	if mi, ok := m.ModelInstalled("gemma4-e4b"); !ok || mi.Model != "gemma-4-E4B-it-Q4_0.gguf" || mi.Vision != "mmproj-gemma-4-E4B-it-Q8_0.gguf" {
		t.Errorf("recover: %+v %v", mi, ok)
	}
	// engine folder whose manifest points somewhere else
	ed := filepath.Join(m.Dir, "engine", "vulkan", "bin")
	sparse(t, filepath.Join(ed, serverExe()), 10)
	_ = writeJSON(filepath.Join(m.Dir, "engine", "vulkan", "engine.json"), engineInfo{Variant: "vulkan", Exe: `D:\old\place\llama-server.exe`})
	if e, ok := m.EngineInstalled("vulkan"); !ok || e.Exe != filepath.Join(ed, serverExe()) {
		t.Errorf("engine fallback: %+v %v", e, ok)
	}
}
