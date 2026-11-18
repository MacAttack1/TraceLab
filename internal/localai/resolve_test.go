package localai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Real file list of ggml-org/gemma-4-E4B-it-GGUF (Nov 2026).
var realE4B = []map[string]any{
	{"type": "file", "path": ".gitattributes", "size": 2600}, {"type": "file", "path": "README.md", "size": 648}, {"type": "file", "path": "convert.log", "size": 708000},
	{"type": "file", "path": "gemma-4-E4B-it-BF16.gguf", "size": 134, "lfs": map[string]any{"oid": "a", "size": 15100000000}},
	{"type": "file", "path": "gemma-4-E4B-it-Q4_0.gguf", "size": 134, "lfs": map[string]any{"oid": "b", "size": 4590000000}},
	{"type": "file", "path": "gemma-4-E4B-it-Q8_0.gguf", "size": 134, "lfs": map[string]any{"oid": "c", "size": 8030000000}},
	{"type": "file", "path": "mmproj-gemma-4-E4B-it-BF16.gguf", "size": 134, "lfs": map[string]any{"oid": "d", "size": 992000000}},
	{"type": "file", "path": "mmproj-gemma-4-E4B-it-Q8_0.gguf", "size": 134, "lfs": map[string]any{"oid": "e", "size": 560000000}},
	{"type": "file", "path": "mtp-gemma-4-E4B-it-BF16.gguf", "size": 134, "lfs": map[string]any{"oid": "f", "size": 172000000}},
	{"type": "file", "path": "mtp-gemma-4-E4B-it-Q4_0.gguf", "size": 134, "lfs": map[string]any{"oid": "g", "size": 59700000}},
	{"type": "file", "path": "mtp-gemma-4-E4B-it-Q8_0.gguf", "size": 134, "lfs": map[string]any{"oid": "h", "size": 98700000}},
}

func TestResolveRealGemma4Files(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(realE4B) }))
	defer srv.Close()
	t.Setenv("TRACELAB_HF_BASE", srv.URL)
	m, v, err := ResolveFiles(context.Background(), *ModelByID("gemma4-e4b"))
	if err != nil {
		t.Fatal(err)
	}
	if m.Path != "gemma-4-E4B-it-Q4_0.gguf" || v.Path != "mmproj-gemma-4-E4B-it-Q8_0.gguf" {
		t.Fatalf("picked %s + %s", m.Path, v.Path)
	}
}

func TestWrongPickIsNotInstalled(t *testing.T) {
	dir := t.TempDir()
	m := NewManager(dir)
	md := filepath.Join(dir, "models", "gemma4-e4b")
	_ = os.MkdirAll(md, 0o755)
	_ = os.WriteFile(filepath.Join(md, "mtp-gemma-4-E4B-it-Q4_0.gguf"), []byte("x"), 0o644)
	_ = writeJSON(filepath.Join(md, "model.json"), modelInfo{ID: "gemma4-e4b", Model: "mtp-gemma-4-E4B-it-Q4_0.gguf"})
	if _, ok := m.ModelInstalled("gemma4-e4b"); ok {
		t.Fatal("an mtp- file must not count as an installed model")
	}
}

func TestExplain(t *testing.T) {
	log := "load_model: loading\n0.01.312.820 E llama_model_load: error loading model: unknown model architecture: 'gemma4'\n0.01.312.831 E srv server_run_i: exiting due to model loading error\n"
	if got := explain(log); got == "" || !contains(got, "unknown model architecture") || !contains(got, "older than this model") {
		t.Fatalf("explain: %q", got)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 || indexOf(s, sub) >= 0)
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
