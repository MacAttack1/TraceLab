// Trace Lab: boardview + schematic viewer with an AI repair assistant.
// The UI is a local web app served on 127.0.0.1 and shown in a WebView2 window on Windows.
package main

import (
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed all:web
var webFS embed.FS

const appName = "Trace Lab"
const appID = "TraceLab" // folder, registry and user-agent name

// Set at build time: -ldflags "-X main.appVersion=1.2.0 -X main.defaultUpdateRepo=owner/repo"
var appVersion = "1.1.0"
var defaultUpdateRepo = ""
var justUpdated bool

type Config struct {
	APIKey string `json:"api_key"`
	Model  string `json:"model"`
	FZKey  string `json:"fz_key"`
	XZZKey string `json:"xzz_key"`
	CAEKey string `json:"cae_key"`
	// Updates
	UpdateRepo  string `json:"update_repo"`
	GitHubToken string `json:"github_token"`
	AutoUpdate  *bool  `json:"auto_update"`
}

func effectiveRepo() string {
	if r := strings.TrimSpace(cfg.UpdateRepo); r != "" {
		return r
	}
	return defaultUpdateRepo
}

var (
	cfgMu   sync.Mutex
	cfg     Config
	cfgPath string
	token   string
	startup []startupFile
)

type startupFile struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
	path string
}

func dataDir() string {
	d, err := os.UserConfigDir()
	if err != nil || d == "" {
		d = "."
	}
	p := filepath.Join(d, appID)
	_ = os.MkdirAll(p, 0o700)
	return p
}

func loadConfig() {
	cfgPath = filepath.Join(dataDir(), "config.json")
	b, err := os.ReadFile(cfgPath)
	if err != nil { // carry settings over from the BoardSleuth preview build
		if d, e := os.UserConfigDir(); e == nil {
			b, err = os.ReadFile(filepath.Join(d, "BoardSleuth", "config.json"))
		}
	}
	if err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	if cfg.Model == "" {
		cfg.Model = "claude-sonnet-5-5"
	}
	if k := os.Getenv("ANTHROPIC_API_KEY"); cfg.APIKey == "" && k != "" {
		cfg.APIKey = k
	}
}

func saveConfig() error {
	b, _ := json.MarshalIndent(cfg, "", "  ")
	tmp := cfgPath + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, cfgPath)
}

func publicConfig() map[string]any {
	auto := cfg.AutoUpdate == nil || *cfg.AutoUpdate
	return map[string]any{"hasKey": cfg.APIKey != "", "model": cfg.Model, "fz_key": cfg.FZKey, "xzz_key": cfg.XZZKey, "cae_key": cfg.CAEKey,
		"version": appVersion, "update_repo": effectiveRepo(), "default_repo": defaultUpdateRepo, "hasGitHubToken": cfg.GitHubToken != "",
		"auto_update": auto, "just_updated": justUpdated, "can_self_update": canSelfUpdate}
}

// collectStartup turns command-line paths (e.g. "Open with Trace Lab") into files the UI fetches on load.
// A boardview pulls in a same-named PDF from its folder, like FlexBV does.
func collectStartup(args []string) {
	seen := map[string]bool{}
	add := func(p, kind string) {
		abs, err := filepath.Abs(p)
		if err != nil || seen[strings.ToLower(abs)] {
			return
		}
		if st, err := os.Stat(abs); err != nil || st.IsDir() {
			return
		}
		seen[strings.ToLower(abs)] = true
		startup = append(startup, startupFile{ID: len(startup), Name: filepath.Base(abs), Kind: kind, path: abs})
	}
	hasPDF := false
	for _, a := range args {
		if a == "--updated" {
			justUpdated = true
		}
		if strings.HasPrefix(a, "-") {
			continue
		}
		if strings.EqualFold(filepath.Ext(a), ".pdf") {
			add(a, "schematic")
			hasPDF = true
		}
	}
	for _, a := range args {
		if strings.HasPrefix(a, "-") || strings.EqualFold(filepath.Ext(a), ".pdf") {
			continue
		}
		ext := strings.ToLower(filepath.Ext(a))
		add(a, "board")
		dir := filepath.Dir(a)
		if ext == ".asc" || ext == ".bom" {
			for _, n := range []string{"format.asc", "pins.asc", "nails.asc", "parts.asc"} {
				if m := findInsensitive(dir, n); m != "" {
					add(m, "board")
				}
			}
		}
		if !hasPDF {
			base := strings.TrimSuffix(filepath.Base(a), filepath.Ext(a))
			if m := findInsensitive(dir, base+".pdf"); m != "" {
				add(m, "schematic")
				hasPDF = true
			}
		}
	}
}

func findInsensitive(dir, name string) string {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, e := range ents {
		if !e.IsDir() && strings.EqualFold(e.Name(), name) {
			return filepath.Join(dir, e.Name())
		}
	}
	return ""
}

var mimeTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
	".wasm": "application/wasm", ".bcmap": "application/octet-stream", ".pfb": "application/octet-stream", ".ttf": "font/ttf",
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func apiErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"type": "error", "error": map[string]string{"type": "tracelab_error", "message": msg}})
}

func newServer(addr string) http.Handler {
	sub, _ := fs.Sub(webFS, "web")
	mux := http.NewServeMux()

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		b, err := fs.ReadFile(sub, p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if p == "index.html" {
			b = bytes.Replace(b, []byte("{{TOKEN}}"), []byte(token), 1)
			w.Header().Set("Cache-Control", "no-store")
		}
		ct := mimeTypes[strings.ToLower(filepath.Ext(p))]
		if ct == "" {
			ct = "application/octet-stream"
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(b)
	})

	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		cfgMu.Lock()
		defer cfgMu.Unlock()
		if r.Method == http.MethodPost {
			var in struct {
				APIKey   *string `json:"api_key"`
				ClearKey bool    `json:"clear_key"`
				Model    *string `json:"model"`
				FZKey    *string `json:"fz_key"`
				XZZKey   *string `json:"xzz_key"`
				CAEKey   *string `json:"cae_key"`
				Repo     *string `json:"update_repo"`
				GHToken  *string `json:"github_token"`
				ClearGH  bool    `json:"clear_github_token"`
				Auto     *bool   `json:"auto_update"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in); err != nil {
				apiErr(w, 400, "Settings couldn't be read.")
				return
			}
			if in.APIKey != nil && strings.TrimSpace(*in.APIKey) != "" {
				cfg.APIKey = strings.TrimSpace(*in.APIKey)
			}
			if in.ClearKey {
				cfg.APIKey = ""
			}
			if in.Model != nil && *in.Model != "" {
				cfg.Model = *in.Model
			}
			if in.FZKey != nil {
				cfg.FZKey = *in.FZKey
			}
			if in.XZZKey != nil {
				cfg.XZZKey = *in.XZZKey
			}
			if in.CAEKey != nil {
				cfg.CAEKey = *in.CAEKey
			}
			if in.Repo != nil {
				r := normalizeRepo(*in.Repo)
				if r == defaultUpdateRepo {
					r = ""
				}
				cfg.UpdateRepo = r
			}
			if in.GHToken != nil && strings.TrimSpace(*in.GHToken) != "" {
				cfg.GitHubToken = strings.TrimSpace(*in.GHToken)
			}
			if in.ClearGH {
				cfg.GitHubToken = ""
			}
			if in.Auto != nil {
				v := *in.Auto
				cfg.AutoUpdate = &v
			}
			if err := saveConfig(); err != nil {
				apiErr(w, 500, "Settings couldn't be saved: "+err.Error())
				return
			}
		}
		writeJSON(w, 200, publicConfig())
	})

	mux.HandleFunc("/api/startup", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"files": startup})
	})

	mux.HandleFunc("/api/file", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(r.URL.Query().Get("id"))
		if err != nil || id < 0 || id >= len(startup) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeFile(w, r, startup[id].path)
	})

	registerUpdateRoutes(mux)

	// Open release pages and docs in the user's browser instead of a popup WebView.
	mux.HandleFunc("/api/open", func(w http.ResponseWriter, r *http.Request) {
		u := r.URL.Query().Get("url")
		if r.Method != http.MethodPost || !(strings.HasPrefix(u, "https://github.com/") || strings.HasPrefix(u, "https://console.anthropic.com/")) {
			apiErr(w, 400, "That link can't be opened.")
			return
		}
		openBrowser(u)
		writeJSON(w, 200, map[string]bool{"ok": true})
	})

	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, DialContext: (&net.Dialer{Timeout: 20 * time.Second}).DialContext, TLSHandshakeTimeout: 20 * time.Second, ResponseHeaderTimeout: 180 * time.Second}}
	apiBase := os.Getenv("TRACELAB_API_BASE")
	if apiBase == "" {
		apiBase = "https://api.anthropic.com"
	}
	mux.HandleFunc("/api/messages", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			apiErr(w, 405, "POST only")
			return
		}
		cfgMu.Lock()
		key := cfg.APIKey
		cfgMu.Unlock()
		if key == "" {
			apiErr(w, 428, "No Anthropic API key is set. Add one in Settings.")
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
		if err != nil {
			apiErr(w, 400, "Request body couldn't be read.")
			return
		}
		req, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, apiBase+"/v1/messages", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", "2023-06-01")
		req.Header.Set("User-Agent", appID+"/"+appVersion)
		resp, err := client.Do(req)
		if err != nil {
			apiErr(w, 502, err.Error())
			return
		}
		defer resp.Body.Close()
		for _, h := range []string{"Content-Type", "Request-Id", "Retry-After"} {
			if v := resp.Header.Get(h); v != "" {
				w.Header().Set(h, v)
			}
		}
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(resp.StatusCode)
		fl, _ := w.(http.Flusher)
		buf := make([]byte, 16<<10)
		for {
			n, rerr := resp.Body.Read(buf)
			if n > 0 {
				if _, werr := w.Write(buf[:n]); werr != nil {
					return
				}
				if fl != nil {
					fl.Flush()
				}
			}
			if rerr != nil {
				return
			}
		}
	})

	// Guard: only this machine, only our page. Rejects DNS-rebinding hosts and cross-site API calls.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if host != addr && host != strings.Replace(addr, "127.0.0.1", "localhost", 1) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Header.Get("X-TL-Token") != token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	if lf, err := os.OpenFile(filepath.Join(dataDir(), "tracelab.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err == nil {
		log.SetOutput(lf)
	}
	loadConfig()
	tb := make([]byte, 16)
	_, _ = rand.Read(tb)
	token = hex.EncodeToString(tb)
	collectStartup(os.Args[1:])

	port := os.Getenv("TRACELAB_PORT")
	if port == "" {
		port = "0"
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		fatal("Trace Lab couldn't start its local server: " + err.Error())
	}
	addr := ln.Addr().String()
	srv := &http.Server{Handler: newServer(addr), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	url := fmt.Sprintf("http://%s/", addr)
	log.Println("serving", url)
	runWindow(url)
}
