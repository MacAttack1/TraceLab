package main

// The setup wizard: a small web page shown in a WebView2 window (like Trace Lab itself), served by
// this installer on 127.0.0.1. It asks where to install, where to keep data, where boardviews and
// schematics live, and whether to download a free offline AI model, then installs and downloads.

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tracelab/internal/localai"
	"tracelab/internal/osutil"
)

//go:embed wizard
var wizardFS embed.FS

type choices struct {
	InstallDir    string `json:"install_dir"`
	Desktop       bool   `json:"desktop"`
	OpenWith      bool   `json:"open_with"`
	ReadingsMode  string `json:"readings_mode"`
	ReadingsDir   string `json:"readings_dir"`
	BoardsDir     string `json:"boards_dir"`
	SchematicsDir string `json:"schematics_dir"`
	AutoSchematic bool   `json:"auto_schematic"`
	Model         string `json:"model"` // "" or "none" = no offline AI
	Engine        string `json:"engine"`
	ModelsDir     string `json:"models_dir"`
	UseLocal      bool   `json:"use_local"`
}

type stepState struct {
	Label  string `json:"label"`
	State  string `json:"state"` // todo | doing | done | skipped | error
	Detail string `json:"detail,omitempty"`
}

type wizardRun struct {
	mu       sync.Mutex
	steps    []stepState
	started  bool
	done     bool
	err      string
	ai       *localai.Manager
	aiPaused bool
	ch       choices
	finish   chan bool // true = launch Trace Lab
}

func (r *wizardRun) set(i int, state, detail string) {
	r.mu.Lock()
	r.steps[i].State, r.steps[i].Detail = state, detail
	r.mu.Unlock()
}

func appConfigPath() string {
	d, err := os.UserConfigDir()
	if err != nil || d == "" {
		d = "."
	}
	return filepath.Join(d, appID, "config.json")
}

func defaultModelsDir() string {
	base, err := os.UserCacheDir()
	if err != nil || base == "" {
		base, _ = os.UserConfigDir()
	}
	return filepath.Join(base, appID, "models")
}

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

func readAppConfig() map[string]any {
	m := map[string]any{}
	if b, err := os.ReadFile(appConfigPath()); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	return m
}

// writeAppConfig merges the wizard's choices into Trace Lab's settings, keeping everything else.
func writeAppConfig(c choices, aiReady bool) error {
	m := readAppConfig()
	m["readings_mode"], m["readings_dir"] = c.ReadingsMode, c.ReadingsDir
	m["boards_dir"], m["schematics_dir"], m["auto_schematic"] = c.BoardsDir, c.SchematicsDir, c.AutoSchematic
	if c.ModelsDir != "" && !strings.EqualFold(filepath.Clean(c.ModelsDir), filepath.Clean(defaultModelsDir())) {
		m["models_dir"] = c.ModelsDir
	} else {
		delete(m, "models_dir")
	}
	if c.Model != "" && c.Model != "none" {
		m["local_model"], m["local_engine"] = c.Model, c.Engine
		if c.UseLocal {
			m["provider"], m["model"] = "local", c.Model
		}
	}
	_ = os.MkdirAll(filepath.Dir(appConfigPath()), 0o700)
	b, _ := json.MarshalIndent(m, "", "  ")
	tmp := appConfigPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, appConfigPath())
}

func wjson(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func werr(w http.ResponseWriter, code int, msg string) {
	wjson(w, code, map[string]any{"error": map[string]string{"message": msg}})
}

// serveWizard starts the wizard server and returns its URL. finish receives the user's choice to
// launch Trace Lab when they click Finish (or false if they close it).
func serveWizard(port string, plat platform) (string, *wizardRun, error) {
	tb := make([]byte, 16)
	_, _ = rand.Read(tb)
	tok := hex.EncodeToString(tb)
	run := &wizardRun{finish: make(chan bool, 1)}
	sub, _ := fs.Sub(wizardFS, "wizard")
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name == "" {
			name = "index.html"
		}
		b, err := fs.ReadFile(sub, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if name == "index.html" {
			b = []byte(strings.ReplaceAll(string(b), "{{TOKEN}}", tok))
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
		} else if strings.HasSuffix(name, ".js") {
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		}
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(b)
	})
	mux.HandleFunc("/api/info", func(w http.ResponseWriter, r *http.Request) {
		cfg := readAppConfig()
		str := func(k string) string { s, _ := cfg[k].(string); return s }
		auto := true
		if v, ok := cfg["auto_schematic"].(bool); ok {
			auto = v
		}
		prov := str("provider")
		hasCloud := false
		if keys, ok := cfg["keys"].(map[string]any); ok && len(keys) > 0 {
			hasCloud = true
		}
		md := str("models_dir")
		if md == "" {
			md = defaultModelsDir()
		}
		wjson(w, 200, map[string]any{
			"version": appVersion, "previous": plat.installedVersion(), "install_dir": plat.installDir(), "config_dir": filepath.Dir(appConfigPath()),
			"readings_mode": str("readings_mode"), "readings_dir": str("readings_dir"), "onedrive": oneDriveRoot(),
			"boards_dir": str("boards_dir"), "schematics_dir": str("schematics_dir"), "auto_schematic": auto,
			"models_dir": md, "local_model": str("local_model"), "local_engine": str("local_engine"), "provider": prov, "has_cloud": hasCloud && prov != "local",
			"desktop": plat.hasDesktopShortcut() || plat.installedVersion() == "", "platform_note": plat.note(),
		})
	})
	var advMu sync.Mutex
	var sizes map[string]int64
	sizesStarted := false
	mux.HandleFunc("/api/ai", func(w http.ResponseWriter, r *http.Request) {
		dir := r.URL.Query().Get("dir")
		if dir == "" {
			dir = defaultModelsDir()
		}
		advMu.Lock()
		if !sizesStarted {
			sizesStarted = true
			go func() {
				s := localai.Sizes(contextTimeout(20 * time.Second))
				advMu.Lock()
				sizes = s
				advMu.Unlock()
			}()
		}
		sz := sizes
		advMu.Unlock()
		m := localai.NewManager(dir)
		models, _ := m.Installed()
		wjson(w, 200, map[string]any{"advice": localai.Advise(osutil.DetectHardware()), "sizes": sz, "installed": models, "free": osutil.FreeSpace(dir), "dir": dir})
	})
	mux.HandleFunc("/api/free", func(w http.ResponseWriter, r *http.Request) {
		wjson(w, 200, map[string]any{"free": osutil.FreeSpace(r.URL.Query().Get("path"))})
	})
	mux.HandleFunc("/api/pick", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Title, Start string }
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&q)
		p, err := osutil.PickFolder(q.Title, q.Start)
		if err != nil {
			werr(w, 501, err.Error())
			return
		}
		wjson(w, 200, map[string]string{"path": p})
	})
	mux.HandleFunc("/api/install", func(w http.ResponseWriter, r *http.Request) {
		var c choices
		if r.Method != http.MethodPost || json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&c) != nil {
			werr(w, 400, "bad request")
			return
		}
		if msg := validate(&c); msg != "" {
			werr(w, 400, msg)
			return
		}
		run.mu.Lock()
		if run.started {
			run.mu.Unlock()
			werr(w, 409, "Already installing.")
			return
		}
		run.started, run.ch = true, c
		run.steps = []stepState{{Label: "Install Trace Lab", State: "todo"}, {Label: "Shortcuts and file types", State: "todo"}, {Label: "Save your settings", State: "todo"}}
		withAI := c.Model != "" && c.Model != "none"
		if withAI {
			run.steps = append(run.steps, stepState{Label: "Download the offline AI", State: "todo"})
			run.ai = localai.NewManager(c.ModelsDir)
		}
		run.mu.Unlock()
		go doInstall(run, plat, withAI)
		wjson(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/progress", func(w http.ResponseWriter, r *http.Request) {
		run.mu.Lock()
		out := map[string]any{"steps": append([]stepState(nil), run.steps...), "done": run.done, "error": run.err, "paused": run.aiPaused}
		ai := run.ai
		run.mu.Unlock()
		if ai != nil {
			out["ai"] = ai.Progress()
		}
		wjson(w, 200, out)
	})
	mux.HandleFunc("/api/later", func(w http.ResponseWriter, r *http.Request) { // finish the AI download in Trace Lab
		run.mu.Lock()
		run.aiPaused = true
		ai := run.ai
		run.mu.Unlock()
		if ai != nil {
			ai.Cancel()
		}
		wjson(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/finish", func(w http.ResponseWriter, r *http.Request) {
		launch := r.URL.Query().Get("launch") == "1"
		run.mu.Lock()
		ch := run.ch
		ok := run.done && run.err == ""
		ai := run.ai
		run.mu.Unlock()
		if ai != nil {
			ai.Cancel()
		}
		wjson(w, 200, map[string]bool{"ok": true})
		go func() {
			time.Sleep(150 * time.Millisecond)
			if launch && ok {
				plat.launch(ch.InstallDir)
			}
			select {
			case run.finish <- launch:
			default:
			}
		}()
	})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Header.Get("X-TL-Token") != tok {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
	ln, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		return "", nil, err
	}
	go func() { _ = (&http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}).Serve(ln) }()
	return fmt.Sprintf("http://%s/", ln.Addr().String()), run, nil
}

func contextTimeout(d time.Duration) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	go func() { <-ctx.Done(); cancel() }()
	return ctx
}

func validate(c *choices) string {
	c.InstallDir = strings.TrimSpace(c.InstallDir)
	if c.InstallDir == "" || !filepath.IsAbs(c.InstallDir) {
		return "Choose a full folder path to install Trace Lab into."
	}
	switch c.ReadingsMode {
	case "onedrive":
		if oneDriveRoot() == "" {
			return "OneDrive isn't set up on this PC."
		}
		c.ReadingsDir = ""
	case "custom":
		c.ReadingsDir = strings.TrimSpace(c.ReadingsDir)
		if !filepath.IsAbs(c.ReadingsDir) {
			return "Choose a full folder path for the readings database."
		}
		if err := os.MkdirAll(c.ReadingsDir, 0o700); err != nil {
			return "The readings database can't go there: " + err.Error()
		}
	default:
		c.ReadingsMode, c.ReadingsDir = "local", ""
	}
	for _, d := range []*string{&c.BoardsDir, &c.SchematicsDir} {
		*d = strings.TrimSpace(*d)
		if *d != "" {
			if st, err := os.Stat(*d); err != nil || !st.IsDir() {
				return "This folder doesn't exist: " + *d
			}
		}
	}
	if c.Model != "" && c.Model != "none" {
		if localai.ModelByID(c.Model) == nil {
			return "Unknown AI model."
		}
		c.ModelsDir = strings.TrimSpace(c.ModelsDir)
		if c.ModelsDir == "" {
			c.ModelsDir = defaultModelsDir()
		}
		if !filepath.IsAbs(c.ModelsDir) {
			return "Choose a full folder path for the AI models."
		}
		if err := os.MkdirAll(c.ModelsDir, 0o755); err != nil {
			return "AI models can't be stored there: " + err.Error()
		}
	}
	return ""
}

func doInstall(run *wizardRun, plat platform, withAI bool) {
	c := run.ch
	fail := func(i int, err error) {
		run.set(i, "error", err.Error())
		run.mu.Lock()
		run.err, run.done = err.Error(), true
		run.mu.Unlock()
	}
	run.set(0, "doing", c.InstallDir)
	if err := plat.copyFiles(c.InstallDir); err != nil {
		fail(0, err)
		return
	}
	run.set(0, "done", c.InstallDir)
	run.set(1, "doing", "")
	if err := plat.integrate(c.InstallDir, c.Desktop, c.OpenWith); err != nil {
		run.set(1, "done", "Shortcut problem: "+err.Error())
	} else {
		run.set(1, "done", "")
	}
	run.set(2, "doing", "")
	if err := writeAppConfig(c, false); err != nil {
		fail(2, fmt.Errorf("couldn't save settings: %v", err))
		return
	}
	run.set(2, "done", filepath.Dir(appConfigPath()))
	if withAI {
		run.set(3, "doing", "")
		if err := run.ai.Download(c.Model, c.Engine); err != nil {
			run.set(3, "error", err.Error())
		} else {
		wait:
			for {
				time.Sleep(300 * time.Millisecond)
				p := run.ai.Progress()
				if !p.Running {
					run.mu.Lock()
					paused := run.aiPaused
					run.mu.Unlock()
					switch {
					case p.Finished:
						run.set(3, "done", "Ready")
					case paused:
						run.set(3, "skipped", "Trace Lab will finish it in the background when you open it.")
					default:
						run.set(3, "error", p.Error+" You can retry from Trace Lab → Settings → Offline AI.")
					}
					break wait
				}
			}
		}
	}
	run.mu.Lock()
	run.done = true
	run.mu.Unlock()
}

// platform is what differs between the real Windows install and the dev/test build.
type platform interface {
	installDir() string
	installedVersion() string
	hasDesktopShortcut() bool
	copyFiles(dir string) error
	integrate(dir string, desktop, openWith bool) error
	launch(dir string)
	note() string
}
