package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tracelab/internal/localai"
	"tracelab/internal/osutil"
)

// modelsDir is where offline AI engines and models live: the user's choice, else
// %LOCALAPPDATA%\TraceLab\models (kept out of the roaming profile; models are many GB).
func modelsDir() string {
	if d := strings.TrimSpace(cfg.ModelsDir); d != "" {
		return d
	}
	base, err := os.UserCacheDir()
	if err != nil || base == "" {
		base = dataDir()
	}
	return filepath.Join(base, appID, "models")
}

var localAI = localai.NewManager("")

var hwCache = struct {
	sync.Mutex
	hw    *osutil.Hardware
	sizes map[string]int64
	at    time.Time
}{}

func hardware() osutil.Hardware {
	hwCache.Lock()
	defer hwCache.Unlock()
	if hwCache.hw == nil {
		h := osutil.DetectHardware()
		hwCache.hw = &h
	}
	return *hwCache.hw
}

// modelSizes asks Hugging Face for the real download sizes once, in the background.
func modelSizes() map[string]int64 {
	hwCache.Lock()
	defer hwCache.Unlock()
	if hwCache.sizes == nil && time.Since(hwCache.at) > time.Minute {
		hwCache.at = time.Now()
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			s := localai.Sizes(ctx)
			if len(s) > 0 {
				hwCache.Lock()
				hwCache.sizes = s
				hwCache.Unlock()
			}
		}()
	}
	return hwCache.sizes
}

func registerLocalAIRoutes(mux *http.ServeMux) {
	cfgMu.Lock()
	localAI.Dir = modelsDir()
	cfgMu.Unlock()

	mux.HandleFunc("/api/localai", func(w http.ResponseWriter, r *http.Request) {
		cfgMu.Lock()
		localAI.Dir = modelsDir()
		sel, eng := cfg.LocalModel, cfg.LocalEngine
		cfgMu.Unlock()
		models, engines := localAI.Installed()
		writeJSON(w, 200, map[string]any{
			"advice": localai.Advise(hardware()), "sizes": modelSizes(), "installed": models, "engines_installed": engines,
			"progress": localAI.Progress(), "server": localAI.Status(), "dir": localAI.Dir, "free": osutil.FreeSpace(localAI.Dir),
			"selected": sel, "engine": eng,
		})
	})

	mux.HandleFunc("/api/localai/download", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Model, Engine string }
		if r.Method != http.MethodPost || readJSON(r, &q) != nil {
			apiErr(w, 400, "Choose a model.")
			return
		}
		if err := localAI.Download(q.Model, q.Engine); err != nil {
			apiErr(w, 409, err.Error())
			return
		}
		writeJSON(w, 200, localAI.Progress())
	})

	mux.HandleFunc("/api/localai/cancel", func(w http.ResponseWriter, r *http.Request) {
		localAI.Cancel()
		writeJSON(w, 200, map[string]bool{"ok": true})
	})

	mux.HandleFunc("/api/localai/remove", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("model")
		if localai.ModelByID(id) == nil {
			apiErr(w, 400, "Unknown model.")
			return
		}
		if err := localAI.Remove(id); err != nil {
			apiErr(w, 500, "Couldn't delete it: "+err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})

	// use makes an installed model the assistant's AI service.
	mux.HandleFunc("/api/localai/use", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Model, Engine string }
		if r.Method != http.MethodPost || readJSON(r, &q) != nil || localai.ModelByID(q.Model) == nil {
			apiErr(w, 400, "Choose a model.")
			return
		}
		cfgMu.Lock()
		cfg.Provider, cfg.Model, cfg.LocalModel = "local", q.Model, q.Model
		if q.Engine != "" {
			cfg.LocalEngine = q.Engine
		}
		err := saveConfig()
		out := publicConfig()
		cfgMu.Unlock()
		if err != nil {
			apiErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, out)
	})

	// start loads the selected model in the background; the page polls /api/localai for "running".
	mux.HandleFunc("/api/localai/start", func(w http.ResponseWriter, r *http.Request) {
		cfgMu.Lock()
		mdl, eng := cfg.LocalModel, cfg.LocalEngine
		cfgMu.Unlock()
		if mdl == "" {
			apiErr(w, 428, "Choose an offline model in Settings → Offline AI first.")
			return
		}
		if err := localAI.Ready(mdl); err != nil {
			apiErr(w, 428, err.Error())
			return
		}
		if st := localAI.Status(); st.State == "running" && st.Model == mdl {
			writeJSON(w, 200, st)
			return
		}
		go func() { _, _ = localAI.Ensure(mdl, eng, 0) }()
		time.Sleep(150 * time.Millisecond)
		writeJSON(w, 200, localAI.Status())
	})

	mux.HandleFunc("/api/localai/stop", func(w http.ResponseWriter, r *http.Request) {
		localAI.Stop()
		writeJSON(w, 200, localAI.Status())
	})

	// dir moves where models are kept (existing downloads stay where they are).
	mux.HandleFunc("/api/localai/dir", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Dir string }
		if r.Method != http.MethodPost || readJSON(r, &q) != nil {
			apiErr(w, 400, "Choose a folder.")
			return
		}
		d := strings.TrimSpace(q.Dir)
		if d != "" {
			if !filepath.IsAbs(d) {
				apiErr(w, 400, "Use a full folder path.")
				return
			}
			if err := os.MkdirAll(d, 0o755); err != nil {
				apiErr(w, 400, "Can't use that folder: "+err.Error())
				return
			}
		}
		if localAI.Progress().Running {
			apiErr(w, 409, "Wait for the download to finish or pause it first.")
			return
		}
		localAI.Stop()
		cfgMu.Lock()
		cfg.ModelsDir = d
		localAI.Dir = modelsDir()
		_ = saveConfig()
		cfgMu.Unlock()
		writeJSON(w, 200, map[string]any{"dir": localAI.Dir, "free": osutil.FreeSpace(localAI.Dir)})
	})

	mux.HandleFunc("/api/localai/reveal", func(w http.ResponseWriter, r *http.Request) {
		_ = os.MkdirAll(localAI.Dir, 0o755)
		osutil.Reveal(localAI.Dir)
		writeJSON(w, 200, map[string]bool{"ok": true})
	})

	mux.HandleFunc("/api/pickfolder", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Title, Start string }
		_ = readJSON(r, &q)
		p, err := osutil.PickFolder(q.Title, q.Start)
		if err != nil {
			apiErr(w, 501, err.Error())
			return
		}
		writeJSON(w, 200, map[string]string{"path": p})
	})
}
