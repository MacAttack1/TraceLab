package main

// Readings database. Per-board measurements the user logs — diode mode, voltage, resistance to
// ground, a known-good / fault label and a note — persisted so faults and known-good values carry
// across sessions and boards. The assistant reads the current board's readings and can search all
// boards for a net name.
//
// Storage is a single JSON file. By default it lives in %APPDATA%\TraceLab; the user can move it to
// OneDrive or any other synced folder (Google Drive, Dropbox) so it's backed up in the cloud and shared
// between PCs. Every write re-reads the file and merges by timestamp first, so edits made on another
// PC and synced in aren't lost.

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

type Reading struct {
	Status  string `json:"status,omitempty"` // "good" | "bad" | ""
	Diode   string `json:"diode,omitempty"`
	Volts   string `json:"volts,omitempty"`
	Ohms    string `json:"ohms,omitempty"`
	Note    string `json:"note,omitempty"`
	Updated int64  `json:"updated,omitempty"` // unix ms
	Deleted bool   `json:"deleted,omitempty"` // tombstone so a delete survives a merge with a synced copy
}

func (r Reading) empty() bool {
	return r.Status == "" && r.Diode == "" && r.Volts == "" && r.Ohms == "" && r.Note == ""
}

type boards = map[string]map[string]Reading

type readingsStore struct {
	mu     sync.Mutex
	path   string
	Boards boards
}

var readings = &readingsStore{}

// oneDriveRoot finds the user's OneDrive folder (personal or work) from the variables Windows sets.
func oneDriveRoot() string {
	for _, v := range []string{"OneDrive", "OneDriveConsumer", "OneDriveCommercial"} {
		if p := os.Getenv(v); p != "" {
			if st, err := os.Stat(p); err == nil && st.IsDir() {
				return p
			}
		}
	}
	return ""
}

// readingsDirFor resolves where the database lives for a storage mode.
func readingsDirFor(mode, custom string) (string, error) {
	switch mode {
	case "onedrive":
		r := oneDriveRoot()
		if r == "" {
			return "", errors.New("OneDrive isn't set up on this PC")
		}
		return filepath.Join(r, "Trace Lab"), nil
	case "custom":
		c := strings.TrimSpace(custom)
		if c == "" {
			return "", errors.New("enter a folder for the database")
		}
		if !filepath.IsAbs(c) {
			return "", errors.New("use a full folder path, e.g. G:\\My Drive\\Trace Lab")
		}
		return c, nil
	}
	return dataDir(), nil
}

func currentReadingsPath() string {
	dir, err := readingsDirFor(cfg.ReadingsMode, cfg.ReadingsDir)
	if err != nil {
		dir = dataDir()
	}
	return filepath.Join(dir, "readings.json")
}

func readBoardsFile(path string) (boards, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return boards{}, nil
		}
		return nil, err
	}
	var data struct {
		Boards boards `json:"boards"`
	}
	if err := json.Unmarshal(b, &data); err != nil {
		return nil, fmt.Errorf("the database file is damaged: %v", err)
	}
	if data.Boards == nil {
		data.Boards = boards{}
	}
	return data.Boards, nil
}

// merge folds src into dst, keeping the newer record for each board/net.
func merge(dst, src boards) {
	for b, nets := range src {
		if dst[b] == nil {
			dst[b] = map[string]Reading{}
		}
		for n, r := range nets {
			if cur, ok := dst[b][n]; !ok || r.Updated > cur.Updated {
				dst[b][n] = r
			}
		}
	}
}

// sync loads the file at the current location and merges it into memory (picks up changes synced
// from another PC). Caller holds s.mu.
func (s *readingsStore) sync() error {
	p := currentReadingsPath()
	if s.Boards == nil || s.path != p {
		s.Boards = boards{}
		s.path = p
	}
	disk, err := readBoardsFile(p)
	if err != nil {
		return err
	}
	merge(s.Boards, disk)
	return nil
}

func (s *readingsStore) save() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(map[string]any{"app": appName, "version": 1, "boards": s.Boards}, "", " ")
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// relocate moves the database to a new storage location, merging with anything already there.
func (s *readingsStore) relocate(oldPath string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	newPath := currentReadingsPath()
	if strings.EqualFold(oldPath, newPath) {
		return nil
	}
	all := boards{}
	if old, err := readBoardsFile(oldPath); err == nil {
		merge(all, old)
	}
	merge(all, s.Boards)
	if there, err := readBoardsFile(newPath); err == nil {
		merge(all, there)
	} else {
		return err
	}
	s.Boards, s.path = all, newPath
	return s.save()
}

// migrateOnStart brings readings from the default local file into the chosen location when the
// setup wizard picked OneDrive or another folder (the app only moves them itself from Settings).
func (s *readingsStore) migrateOnStart() {
	local := filepath.Join(dataDir(), "readings.json")
	if strings.EqualFold(local, currentReadingsPath()) {
		return
	}
	if _, err := os.Stat(local); err != nil {
		return
	}
	if err := s.relocate(local); err == nil {
		_ = os.Rename(local, local+".moved")
	}
}

func liveCount(nets map[string]Reading) int {
	n := 0
	for _, r := range nets {
		if !r.Deleted {
			n++
		}
	}
	return n
}

type flatReading struct {
	Board string `json:"board"`
	Net   string `json:"net"`
	Reading
}

func (s *readingsStore) flat() []flatReading {
	var out []flatReading
	for b, nets := range s.Boards {
		for n, r := range nets {
			if !r.Deleted {
				out = append(out, flatReading{b, n, r})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Updated > out[j].Updated })
	return out
}

func storageInfo() map[string]any {
	mode := cfg.ReadingsMode
	if mode == "" {
		mode = "local"
	}
	return map[string]any{"mode": mode, "path": currentReadingsPath(), "onedrive": oneDriveRoot()}
}

func revealInFolder(path string) {
	switch runtime.GOOS {
	case "windows":
		_ = exec.Command("explorer.exe", "/select,", path).Start()
	case "darwin":
		_ = exec.Command("open", "-R", path).Start()
	default:
		_ = exec.Command("xdg-open", filepath.Dir(path)).Start()
	}
}

func registerReadingRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/readings", func(w http.ResponseWriter, r *http.Request) {
		readings.mu.Lock()
		defer readings.mu.Unlock()
		if err := readings.sync(); err != nil {
			apiErr(w, 500, "Couldn't open the readings database at "+readings.path+": "+err.Error())
			return
		}
		switch r.Method {
		case http.MethodGet:
			out := map[string]Reading{}
			for n, rd := range readings.Boards[r.URL.Query().Get("board")] {
				if !rd.Deleted {
					out[n] = rd
				}
			}
			writeJSON(w, 200, out)
		case http.MethodPost:
			var in struct {
				Board, Net, Status, Diode, Volts, Ohms, Note string
			}
			if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in) != nil || strings.TrimSpace(in.Board) == "" || strings.TrimSpace(in.Net) == "" {
				apiErr(w, 400, "A reading needs a board and a net.")
				return
			}
			if in.Status != "good" && in.Status != "bad" {
				in.Status = ""
			}
			rd := Reading{Status: in.Status, Diode: strings.TrimSpace(in.Diode), Volts: strings.TrimSpace(in.Volts),
				Ohms: strings.TrimSpace(in.Ohms), Note: strings.TrimSpace(in.Note), Updated: time.Now().UnixMilli()}
			if readings.Boards[in.Board] == nil {
				readings.Boards[in.Board] = map[string]Reading{}
			}
			if rd.empty() {
				rd = Reading{Deleted: true, Updated: rd.Updated}
			}
			readings.Boards[in.Board][in.Net] = rd
			if err := readings.save(); err != nil {
				apiErr(w, 500, "The reading wasn't saved: "+err.Error())
				return
			}
			writeJSON(w, 200, map[string]any{"saved": rd, "path": readings.path, "deleted": rd.Deleted, "total": len(readings.flat())})
		case http.MethodDelete:
			b, n := r.URL.Query().Get("board"), r.URL.Query().Get("net")
			if readings.Boards[b] != nil {
				readings.Boards[b][n] = Reading{Deleted: true, Updated: time.Now().UnixMilli()}
				if err := readings.save(); err != nil {
					apiErr(w, 500, "Couldn't delete: "+err.Error())
					return
				}
			}
			writeJSON(w, 200, map[string]bool{"ok": true})
		default:
			apiErr(w, 405, "GET, POST or DELETE")
		}
	})

	// Whole database, newest first, for the database browser.
	mux.HandleFunc("/api/readings/all", func(w http.ResponseWriter, r *http.Request) {
		readings.mu.Lock()
		defer readings.mu.Unlock()
		if err := readings.sync(); err != nil {
			apiErr(w, 500, err.Error())
			return
		}
		nb := 0
		for _, nets := range readings.Boards {
			if liveCount(nets) > 0 {
				nb++
			}
		}
		writeJSON(w, 200, map[string]any{"readings": readings.flat(), "boards": nb, "storage": storageInfo()})
	})

	// Cross-board lookup by net name, to compare against known-good or known-bad values elsewhere.
	mux.HandleFunc("/api/readings/search", func(w http.ResponseWriter, r *http.Request) {
		readings.mu.Lock()
		defer readings.mu.Unlock()
		if err := readings.sync(); err != nil {
			apiErr(w, 500, err.Error())
			return
		}
		q := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("net")))
		status, exclude := r.URL.Query().Get("status"), r.URL.Query().Get("exclude")
		var out []flatReading
		for _, h := range readings.flat() {
			if status != "" && h.Status != status {
				continue
			}
			if q != "" && !strings.Contains(strings.ToUpper(h.Net), q) {
				continue
			}
			if exclude != "" && h.Board == exclude && q != "" && strings.EqualFold(h.Net, q) {
				continue
			}
			out = append(out, h)
		}
		if len(out) > 60 {
			out = out[:60]
		}
		writeJSON(w, 200, out)
	})

	// Export to CSV next to the database and show it in Explorer.
	mux.HandleFunc("/api/readings/export", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			apiErr(w, 405, "POST only")
			return
		}
		readings.mu.Lock()
		defer readings.mu.Unlock()
		if err := readings.sync(); err != nil {
			apiErr(w, 500, err.Error())
			return
		}
		out := filepath.Join(filepath.Dir(readings.path), "readings-export-"+time.Now().Format("2006-01-02-1504")+".csv")
		f, err := os.Create(out)
		if err != nil {
			apiErr(w, 500, "Couldn't write the export: "+err.Error())
			return
		}
		cw := csv.NewWriter(f)
		_ = cw.Write([]string{"board", "net", "status", "diode_v", "volts", "ohms_to_gnd", "note", "updated"})
		for _, h := range readings.flat() {
			_ = cw.Write([]string{h.Board, h.Net, h.Status, h.Diode, h.Volts, h.Ohms, h.Note, time.UnixMilli(h.Updated).Format("2006-01-02 15:04")})
		}
		cw.Flush()
		_ = f.Close()
		revealInFolder(out)
		writeJSON(w, 200, map[string]string{"path": out})
	})

	mux.HandleFunc("/api/readings/reveal", func(w http.ResponseWriter, r *http.Request) {
		readings.mu.Lock()
		p := currentReadingsPath()
		readings.mu.Unlock()
		if _, err := os.Stat(p); err != nil {
			p = filepath.Dir(p)
		}
		revealInFolder(p)
		writeJSON(w, 200, map[string]string{"path": p})
	})
}
