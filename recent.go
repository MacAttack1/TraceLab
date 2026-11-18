package main

// Recently opened files. The page opens files through the browser (file picker or drag and drop),
// which never reveals their paths, so each opened file is copied into %APPDATA%\TraceLab\recent and
// reopened from there. Files opened from Explorer ("Open with Trace Lab") are remembered by path.
// The last board + schematic pair is kept so Trace Lab can offer to pick up where you left off.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type recentFile struct {
	Name string `json:"name"`
	Path string `json:"-"`
	Size int64  `json:"size"`
}

type recentEntry struct {
	ID     string       `json:"id"`
	Kind   string       `json:"kind"` // board | schematic
	Files  []recentFile `json:"files"`
	Opened int64        `json:"opened"` // unix ms
	Info   string       `json:"info,omitempty"`
}

type recentDisk struct {
	Items []recentEntry       `json:"items"`
	Paths map[string][]string `json:"paths"` // id -> file paths (kept out of the API)
	Last  struct {
		Board     string `json:"board"`
		Schematic string `json:"schematic"`
	} `json:"last"`
}

const maxRecent = 10

var recents = struct {
	sync.Mutex
	d recentDisk
}{}

func recentDir() string { return filepath.Join(dataDir(), "recent") }
func recentDB() string  { return filepath.Join(dataDir(), "recent.json") }

func loadRecents() {
	recents.Lock()
	defer recents.Unlock()
	b, err := os.ReadFile(recentDB())
	if err == nil {
		_ = json.Unmarshal(b, &recents.d)
	}
	if recents.d.Paths == nil {
		recents.d.Paths = map[string][]string{}
	}
}

func saveRecents() {
	b, _ := json.MarshalIndent(recents.d, "", " ")
	tmp := recentDB() + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, recentDB())
	}
}

// live reports whether every file of an entry still exists.
func recentLive(id string) bool {
	ps := recents.d.Paths[id]
	if len(ps) == 0 {
		return false
	}
	for _, p := range ps {
		if _, err := os.Stat(p); err != nil {
			return false
		}
	}
	return true
}

// prune drops entries past the limit and deletes cached copies nothing refers to.
func pruneRecents() {
	sort.SliceStable(recents.d.Items, func(i, j int) bool { return recents.d.Items[i].Opened > recents.d.Items[j].Opened })
	if len(recents.d.Items) > maxRecent {
		for _, e := range recents.d.Items[maxRecent:] {
			if e.ID != recents.d.Last.Board && e.ID != recents.d.Last.Schematic {
				delete(recents.d.Paths, e.ID)
			}
		}
		keep := recents.d.Items[:maxRecent]
		for _, id := range []string{recents.d.Last.Board, recents.d.Last.Schematic} {
			found := false
			for _, e := range keep {
				found = found || e.ID == id
			}
			if !found {
				for _, e := range recents.d.Items[maxRecent:] {
					if e.ID == id {
						keep = append(keep, e)
					}
				}
			}
		}
		recents.d.Items = keep
	}
	used := map[string]bool{}
	for _, ps := range recents.d.Paths {
		for _, p := range ps {
			used[strings.ToLower(p)] = true
		}
	}
	ents, _ := os.ReadDir(recentDir())
	for _, e := range ents {
		p := filepath.Join(recentDir(), e.Name())
		if !used[strings.ToLower(p)] {
			_ = os.Remove(p)
		}
	}
}

func registerRecentRoutes(mux *http.ServeMux) {
	loadRecents()

	mux.HandleFunc("/api/recent", func(w http.ResponseWriter, r *http.Request) {
		recents.Lock()
		defer recents.Unlock()
		if r.Method == http.MethodDelete {
			recents.d = recentDisk{Paths: map[string][]string{}}
			saveRecents()
			pruneRecents()
		}
		var items []recentEntry
		for _, e := range recents.d.Items {
			if recentLive(e.ID) {
				items = append(items, e)
			}
		}
		last := map[string]string{}
		if recentLive(recents.d.Last.Board) {
			last["board"] = recents.d.Last.Board
		}
		if recentLive(recents.d.Last.Schematic) {
			last["schematic"] = recents.d.Last.Schematic
		}
		writeJSON(w, 200, map[string]any{"items": items, "last": last})
	})

	// add records an opened board or schematic. multipart/form-data: kind, info, files (one or more),
	// or startup=<id,id> for files Trace Lab was launched with (remembered by path, not copied).
	mux.HandleFunc("/api/recent/add", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			apiErr(w, 405, "POST only")
			return
		}
		if t := r.URL.Query().Get("touch"); t != "" { // reopened from the recent list: just move it to the top
			recents.Lock()
			defer recents.Unlock()
			for i := range recents.d.Items {
				if recents.d.Items[i].ID == t {
					recents.d.Items[i].Opened = time.Now().UnixMilli()
					e := recents.d.Items[i]
					pruneRecents()
					saveRecents()
					writeJSON(w, 200, e)
					return
				}
			}
			apiErr(w, 404, "Not in the recent list.")
			return
		}
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			apiErr(w, 400, "Couldn't read the file: "+err.Error())
			return
		}
		kind := r.FormValue("kind")
		if kind != "board" && kind != "schematic" {
			apiErr(w, 400, "kind must be board or schematic")
			return
		}
		var files []recentFile
		var paths []string
		h := sha256.New()
		if s := r.FormValue("startup"); s != "" {
			for _, x := range strings.Split(s, ",") {
				i, err := strconv.Atoi(x)
				if err != nil || i < 0 || i >= len(startup) {
					continue
				}
				st, err := os.Stat(startup[i].path)
				if err != nil {
					continue
				}
				files = append(files, recentFile{Name: startup[i].Name, Size: st.Size()})
				paths = append(paths, startup[i].path)
				h.Write([]byte(strings.ToLower(startup[i].path)))
			}
		} else if r.MultipartForm != nil {
			_ = os.MkdirAll(recentDir(), 0o700)
			for _, fh := range r.MultipartForm.File["files"] {
				src, err := fh.Open()
				if err != nil {
					continue
				}
				fh2 := sha256.New()
				tmp, err := os.CreateTemp(recentDir(), "up-*")
				if err != nil {
					src.Close()
					apiErr(w, 500, err.Error())
					return
				}
				n, err := io.Copy(io.MultiWriter(tmp, fh2), src)
				src.Close()
				tmp.Close()
				if err != nil {
					os.Remove(tmp.Name())
					continue
				}
				sum := hex.EncodeToString(fh2.Sum(nil))[:16]
				ext := filepath.Ext(fh.Filename)
				dst := filepath.Join(recentDir(), sum+strings.ToLower(ext))
				if _, err := os.Stat(dst); err == nil {
					os.Remove(tmp.Name())
				} else if err := os.Rename(tmp.Name(), dst); err != nil {
					os.Remove(tmp.Name())
					continue
				}
				files = append(files, recentFile{Name: filepath.Base(fh.Filename), Size: n})
				paths = append(paths, dst)
				h.Write([]byte(sum + fh.Filename))
			}
		}
		if len(files) == 0 {
			apiErr(w, 400, "No files to remember.")
			return
		}
		id := kind[:1] + hex.EncodeToString(h.Sum(nil))[:15]
		recents.Lock()
		defer recents.Unlock()
		var keep []recentEntry
		for _, e := range recents.d.Items {
			// the same file opened again replaces its older entry
			same := e.ID == id || (e.Kind == kind && len(e.Files) == len(files) && e.Files[0].Name == files[0].Name && e.Files[0].Size == files[0].Size)
			if same {
				if e.ID != id {
					delete(recents.d.Paths, e.ID)
				}
				continue
			}
			keep = append(keep, e)
		}
		e := recentEntry{ID: id, Kind: kind, Files: files, Opened: time.Now().UnixMilli(), Info: r.FormValue("info")}
		recents.d.Items = append([]recentEntry{e}, keep...)
		recents.d.Paths[id] = paths
		pruneRecents()
		saveRecents()
		writeJSON(w, 200, e)
	})

	// session records which board and schematic are open together (either may be empty).
	mux.HandleFunc("/api/recent/session", func(w http.ResponseWriter, r *http.Request) {
		recents.Lock()
		defer recents.Unlock()
		q := r.URL.Query()
		recents.d.Last.Board, recents.d.Last.Schematic = q.Get("board"), q.Get("schematic")
		saveRecents()
		writeJSON(w, 200, map[string]bool{"ok": true})
	})

	mux.HandleFunc("/api/recent/file", func(w http.ResponseWriter, r *http.Request) {
		recents.Lock()
		ps := recents.d.Paths[r.URL.Query().Get("id")]
		recents.Unlock()
		i, err := strconv.Atoi(r.URL.Query().Get("i"))
		if err != nil || i < 0 || i >= len(ps) {
			http.NotFound(w, r)
			return
		}
		f, err := os.Open(ps[i])
		if err != nil {
			apiErr(w, 404, "That file isn't there any more.")
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = io.Copy(w, f)
	})
}
