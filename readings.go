package main

// Readings database. Per-board measurements the user logs — diode mode, voltage, resistance to
// ground, a good/bad label and a note — persisted so faults and known-good values carry across
// sessions and boards. The assistant reads the current board's readings and can search all boards
// for a net name, so a known-good value measured once helps diagnose the same rail later.

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
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
	Updated int64  `json:"updated,omitempty"`
}

func (r Reading) empty() bool {
	return r.Status == "" && r.Diode == "" && r.Volts == "" && r.Ohms == "" && r.Note == ""
}

type readingsStore struct {
	mu     sync.Mutex
	loaded bool
	path   string
	Boards map[string]map[string]Reading `json:"boards"`
}

var readings = &readingsStore{Boards: map[string]map[string]Reading{}}

func (s *readingsStore) load() {
	if s.loaded {
		return
	}
	s.loaded = true
	s.path = filepath.Join(dataDir(), "readings.json")
	if b, err := os.ReadFile(s.path); err == nil {
		var data struct {
			Boards map[string]map[string]Reading `json:"boards"`
		}
		if json.Unmarshal(b, &data) == nil && data.Boards != nil {
			s.Boards = data.Boards
		}
	}
}

func (s *readingsStore) save() {
	b, _ := json.MarshalIndent(map[string]any{"boards": s.Boards}, "", " ")
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

func registerReadingRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/readings", func(w http.ResponseWriter, r *http.Request) {
		readings.mu.Lock()
		defer readings.mu.Unlock()
		readings.load()
		switch r.Method {
		case http.MethodGet:
			board := r.URL.Query().Get("board")
			out := readings.Boards[board]
			if out == nil {
				out = map[string]Reading{}
			}
			writeJSON(w, 200, out)
		case http.MethodPost:
			var in struct {
				Board  string `json:"board"`
				Net    string `json:"net"`
				Status string `json:"status"`
				Diode  string `json:"diode"`
				Volts  string `json:"volts"`
				Ohms   string `json:"ohms"`
				Note   string `json:"note"`
			}
			if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in) != nil || in.Board == "" || in.Net == "" {
				apiErr(w, 400, "A reading needs a board and a net.")
				return
			}
			if in.Status != "good" && in.Status != "bad" {
				in.Status = ""
			}
			rd := Reading{Status: in.Status, Diode: strings.TrimSpace(in.Diode), Volts: strings.TrimSpace(in.Volts),
				Ohms: strings.TrimSpace(in.Ohms), Note: strings.TrimSpace(in.Note), Updated: time.Now().Unix()}
			if readings.Boards[in.Board] == nil {
				readings.Boards[in.Board] = map[string]Reading{}
			}
			if rd.empty() {
				delete(readings.Boards[in.Board], in.Net)
			} else {
				readings.Boards[in.Board][in.Net] = rd
			}
			readings.save()
			writeJSON(w, 200, rd)
		default:
			apiErr(w, 405, "GET or POST only")
		}
	})

	// Cross-board lookup by net name, to compare against known-good or known-bad values elsewhere.
	mux.HandleFunc("/api/readings/search", func(w http.ResponseWriter, r *http.Request) {
		readings.mu.Lock()
		defer readings.mu.Unlock()
		readings.load()
		q := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("net")))
		status := r.URL.Query().Get("status")
		exclude := r.URL.Query().Get("exclude")
		type hit struct {
			Board string `json:"board"`
			Net   string `json:"net"`
			Reading
		}
		var out []hit
		for board, nets := range readings.Boards {
			for net, rd := range nets {
				if status != "" && rd.Status != status {
					continue
				}
				if q != "" && !strings.Contains(strings.ToUpper(net), q) {
					continue
				}
				if exclude != "" && board == exclude && q != "" && strings.EqualFold(net, q) {
					continue // skip the exact net on the board being worked on; its own panel already shows it
				}
				out = append(out, hit{Board: board, Net: net, Reading: rd})
			}
		}
		sort.Slice(out, func(i, j int) bool {
			if (out[i].Board == exclude) != (out[j].Board == exclude) {
				return out[i].Board == exclude
			}
			return out[i].Updated > out[j].Updated
		})
		if len(out) > 60 {
			out = out[:60]
		}
		writeJSON(w, 200, out)
	})
}
