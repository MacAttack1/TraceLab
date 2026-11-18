package localai

// Models already on the PC: GGUF files from LM Studio, Ollama's model store, or any folder the user
// adds. llama-server runs them directly, so there's no need to download them again.

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// External is a model file found outside Trace Lab's catalog.
type External struct {
	ID     string `json:"id"` // "ext:" + hash of the path
	Name   string `json:"name"`
	Source string `json:"source"` // LM Studio | Ollama | Folder
	Path   string `json:"path"`
	Vision string `json:"vision,omitempty"` // image reader (mmproj) next to it, if any
	Bytes  int64  `json:"bytes"`
}

var extCache = struct {
	sync.Mutex
	at   time.Time
	key  string
	list []External
}{}

// ForgetScan drops the cached scan so the next call looks again.
func ForgetScan() { extCache.Lock(); extCache.list = nil; extCache.Unlock() }

func extID(p string) string {
	h := sha1.Sum([]byte(strings.ToLower(filepath.Clean(p))))
	return "ext:" + hex.EncodeToString(h[:6])
}

// KnownModelDirs lists the folders other local-AI apps keep GGUF models in.
func KnownModelDirs() []struct{ Dir, Source string } {
	home, _ := os.UserHomeDir()
	var out []struct{ Dir, Source string }
	add := func(d, s string) {
		if d == "" {
			return
		}
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			out = append(out, struct{ Dir, Source string }{d, s})
		}
	}
	add(os.Getenv("LMSTUDIO_MODELS"), "LM Studio")
	add(filepath.Join(home, ".lmstudio", "models"), "LM Studio")
	add(filepath.Join(home, ".cache", "lm-studio", "models"), "LM Studio")
	if d := os.Getenv("OLLAMA_MODELS"); d != "" {
		add(d, "Ollama")
	} else {
		add(filepath.Join(home, ".ollama", "models"), "Ollama")
	}
	return out
}

// ScanExternal finds usable models in the known app folders plus extra folders. Cached briefly.
func ScanExternal(extra []string) []External {
	key := strings.Join(extra, "|")
	extCache.Lock()
	if extCache.key == key && time.Since(extCache.at) < 30*time.Second && extCache.list != nil {
		l := extCache.list
		extCache.Unlock()
		return l
	}
	extCache.Unlock()
	var out []External
	seen := map[string]bool{}
	addOne := func(e External) {
		k := strings.ToLower(filepath.Clean(e.Path))
		if !seen[k] {
			seen[k] = true
			out = append(out, e)
		}
	}
	for _, d := range KnownModelDirs() {
		if d.Source == "Ollama" {
			for _, e := range scanOllama(d.Dir) {
				addOne(e)
			}
		} else {
			for _, e := range scanGGUF(d.Dir, d.Source) {
				addOne(e)
			}
		}
	}
	for _, d := range extra {
		if strings.TrimSpace(d) == "" {
			continue
		}
		if _, err := os.Stat(filepath.Join(d, "manifests")); err == nil {
			for _, e := range scanOllama(d) {
				addOne(e)
			}
			continue
		}
		for _, e := range scanGGUF(d, "Folder") {
			addOne(e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Source+out[i].Name < out[j].Source+out[j].Name })
	extCache.Lock()
	extCache.at, extCache.key, extCache.list = time.Now(), key, out
	extCache.Unlock()
	return out
}

func scanGGUF(root, source string) []External {
	var out []External
	visionIn := map[string]string{}
	var models []string
	base := filepath.Clean(root)
	_ = filepath.WalkDir(base, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if strings.Count(strings.TrimPrefix(p, base), string(os.PathSeparator)) > 5 || (p != base && strings.HasPrefix(d.Name(), ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		n := strings.ToLower(d.Name())
		if !strings.HasSuffix(n, ".gguf") {
			return nil
		}
		if strings.Contains(n, "mmproj") {
			visionIn[filepath.Dir(p)] = p
			return nil
		}
		if isAuxFile(n) || strings.Contains(n, "-of-0") && !strings.Contains(n, "00001-of-") { // later shards of a split model
			return nil
		}
		if info, err := d.Info(); err == nil && info.Size() >= 100<<20 {
			models = append(models, p)
		}
		return nil
	})
	for _, p := range models {
		info, _ := os.Stat(p)
		name := strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
		if rel, err := filepath.Rel(base, filepath.Dir(p)); err == nil && rel != "." {
			name = filepath.ToSlash(rel) + " · " + name
		}
		out = append(out, External{ID: extID(p), Name: name, Source: source, Path: p, Vision: visionIn[filepath.Dir(p)], Bytes: info.Size()})
	}
	return out
}

// scanOllama reads Ollama's manifests: each model's weights and image projector are GGUF blobs.
func scanOllama(root string) []External {
	var out []External
	man := filepath.Join(root, "manifests")
	_ = filepath.WalkDir(man, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil || len(b) > 1<<20 {
			return nil
		}
		var m struct {
			Layers []struct {
				MediaType string `json:"mediaType"`
				Digest    string `json:"digest"`
				Size      int64  `json:"size"`
			} `json:"layers"`
		}
		if json.Unmarshal(b, &m) != nil {
			return nil
		}
		blob := func(dg string) string { return filepath.Join(root, "blobs", strings.Replace(dg, ":", "-", 1)) }
		var e External
		for _, l := range m.Layers {
			switch l.MediaType {
			case "application/vnd.ollama.image.model":
				e.Path, e.Bytes = blob(l.Digest), l.Size
			case "application/vnd.ollama.image.projector":
				e.Vision = blob(l.Digest)
			}
		}
		if e.Path == "" || e.Bytes < 100<<20 {
			return nil
		}
		if _, err := os.Stat(e.Path); err != nil {
			return nil
		}
		if e.Vision != "" {
			if _, err := os.Stat(e.Vision); err != nil {
				e.Vision = ""
			}
		}
		rel, _ := filepath.Rel(man, p)
		parts := strings.Split(filepath.ToSlash(rel), "/") // registry/namespace/model/tag
		if len(parts) >= 2 {
			name := parts[len(parts)-2] + ":" + parts[len(parts)-1]
			if len(parts) >= 3 && parts[len(parts)-3] != "library" {
				name = parts[len(parts)-3] + "/" + name
			}
			e.Name = name
		}
		e.Source, e.ID = "Ollama", extID(e.Path)
		out = append(out, e)
		return nil
	})
	return out
}

// FindExternal looks up an external model by id.
func (m *Manager) FindExternal(id string) (External, bool) {
	for _, e := range ScanExternal(m.ExtraDirs) {
		if e.ID == id {
			return e, true
		}
	}
	return External{}, false
}
