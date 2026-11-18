package main

// Library: browse the boardview and schematic folders the user chose, open files straight from
// them, and find the schematic that belongs to a boardview by matching model numbers in the names
// (e.g. "X580VD_REV2.0.fz" ↔ "ASUS X580VD rev 2.0 schematic.pdf", "820-00165.brd" ↔ "820-00165-A.pdf").

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var boardExtSet = map[string]bool{".brd": true, ".bdv": true, ".fz": true, ".cae": true, ".asc": true, ".bvr": true, ".bvr3": true, ".cad": true, ".cst": true, ".pcb": true,
	".kicad_pcb": true, ".pcbdoc": true, ".ipc": true, ".356": true, ".d356": true, ".bv": true, ".gr": true, ".tvw": true, ".f2b": true, ".bom": true, ".txt": false}

type libFile struct {
	Name string `json:"name"`
	Rel  string `json:"rel"`
	Dir  string `json:"dir"`
	Size int64  `json:"size"`
	Mod  int64  `json:"mod"`
}

var libCache = struct {
	sync.Mutex
	m map[string]libScan
}{m: map[string]libScan{}}

type libScan struct {
	at    time.Time
	files []libFile
	trunc bool
}

func scanDir(root string, want func(ext string) bool) ([]libFile, bool) {
	key := root + "|" + strconv.FormatBool(want(".pdf"))
	libCache.Lock()
	if c, ok := libCache.m[key]; ok && time.Since(c.at) < 20*time.Second {
		libCache.Unlock()
		return c.files, c.trunc
	}
	libCache.Unlock()
	var out []libFile
	trunc := false
	base := filepath.Clean(root)
	_ = filepath.WalkDir(base, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if p != base && (strings.HasPrefix(d.Name(), ".") || strings.Count(strings.TrimPrefix(p, base), string(os.PathSeparator)) > 8) {
				return filepath.SkipDir
			}
			return nil
		}
		if !want(strings.ToLower(filepath.Ext(d.Name()))) {
			return nil
		}
		if len(out) >= 50000 {
			trunc = true
			return filepath.SkipAll
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(base, p)
		out = append(out, libFile{Name: d.Name(), Rel: filepath.ToSlash(rel), Dir: filepath.ToSlash(filepath.Dir(rel)), Size: info.Size(), Mod: info.ModTime().UnixMilli()})
		return nil
	})
	libCache.Lock()
	libCache.m[key] = libScan{at: time.Now(), files: out, trunc: trunc}
	libCache.Unlock()
	return out, trunc
}

func libRoot(kind string) string {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	if kind == "schematic" {
		if cfg.SchematicsDir != "" {
			return cfg.SchematicsDir
		}
		return cfg.BoardsDir // many people keep both together
	}
	return cfg.BoardsDir
}

func wantKind(kind string) func(string) bool {
	if kind == "schematic" {
		return func(e string) bool { return e == ".pdf" }
	}
	return func(e string) bool { return boardExtSet[e] }
}

var tokRe = regexp.MustCompile(`[a-z0-9]+`)

// nameTokens pulls the identifying parts out of a file name: model numbers and board codes.
func nameTokens(name string) (toks []string, compact string) {
	n := strings.ToLower(strings.TrimSuffix(name, filepath.Ext(name)))
	all := tokRe.FindAllString(n, -1)
	stop := map[string]bool{"rev": true, "schematic": true, "schematics": true, "boardview": true, "board": true, "mb": true, "main": true, "pdf": true, "the": true, "and": true, "for": true, "mainboard": true, "motherboard": true, "final": true, "new": true, "copy": true}
	for i, t := range all {
		if stop[t] || len(t) < 3 {
			continue
		}
		toks = append(toks, t)
		if i+1 < len(all) && len(all[i+1]) >= 3 && hasDigit(t+all[i+1]) { // "820","00165" → "82000165"
			toks = append(toks, t+all[i+1])
		}
	}
	return toks, strings.Join(all, "")
}

func hasDigit(s string) bool {
	for _, c := range s {
		if c >= '0' && c <= '9' {
			return true
		}
	}
	return false
}

type libMatch struct {
	libFile
	Score int `json:"score"`
}

func matchSchematics(board string, files []libFile) []libMatch {
	bt, _ := nameTokens(board)
	var out []libMatch
	for _, f := range files {
		_, fc := nameTokens(f.Name)
		_, dc := nameTokens(strings.ReplaceAll(f.Dir, "/", " "))
		score := 0
		for _, t := range bt {
			if strings.Contains(fc, t) || strings.Contains(dc, t) {
				w := len(t)
				if hasDigit(t) {
					w *= 2 // model numbers matter most
				}
				score += w
			}
		}
		if score > 0 {
			out = append(out, libMatch{f, score})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].Mod > out[j].Mod
	})
	if len(out) > 8 {
		out = out[:8]
	}
	return out
}

func registerLibraryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/library", func(w http.ResponseWriter, r *http.Request) {
		kind := r.URL.Query().Get("kind")
		root := libRoot(kind)
		if root == "" {
			writeJSON(w, 200, map[string]any{"root": "", "files": []libFile{}})
			return
		}
		if st, err := os.Stat(root); err != nil || !st.IsDir() {
			apiErr(w, 404, "The folder isn't there any more: "+root)
			return
		}
		if r.URL.Query().Get("refresh") == "1" {
			libCache.Lock()
			libCache.m = map[string]libScan{}
			libCache.Unlock()
		}
		files, trunc := scanDir(root, wantKind(kind))
		q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
		var out []libFile
		for _, f := range files {
			if q == "" || strings.Contains(strings.ToLower(f.Rel), q) {
				out = append(out, f)
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Mod > out[j].Mod })
		total := len(out)
		if len(out) > 400 {
			out = out[:400]
		}
		writeJSON(w, 200, map[string]any{"root": root, "files": out, "total": total, "truncated": trunc})
	})

	mux.HandleFunc("/api/library/file", func(w http.ResponseWriter, r *http.Request) {
		root := libRoot(r.URL.Query().Get("kind"))
		rel := filepath.FromSlash(r.URL.Query().Get("rel"))
		if root == "" || rel == "" {
			http.NotFound(w, r)
			return
		}
		p := filepath.Join(root, rel)
		if !strings.HasPrefix(filepath.Clean(p), filepath.Clean(root)+string(os.PathSeparator)) {
			http.Error(w, "outside the library", http.StatusForbidden)
			return
		}
		f, err := os.Open(p)
		if err != nil {
			apiErr(w, 404, "That file isn't there any more.")
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = io.Copy(w, f)
	})

	// match finds schematics whose names share the boardview's model number.
	mux.HandleFunc("/api/library/match", func(w http.ResponseWriter, r *http.Request) {
		root := libRoot("schematic")
		if root == "" {
			writeJSON(w, 200, map[string]any{"matches": []libMatch{}})
			return
		}
		files, _ := scanDir(root, wantKind("schematic"))
		writeJSON(w, 200, map[string]any{"matches": matchSchematics(r.URL.Query().Get("name"), files)})
	})
}
