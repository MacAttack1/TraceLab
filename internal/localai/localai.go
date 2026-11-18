// Package localai runs a free AI model on the user's own PC for Trace Lab's repair assistant.
//
// The engine is llama.cpp's llama-server (MIT licence), downloaded from its GitHub releases in the
// build that suits the PC: Vulkan (any NVIDIA, AMD or Intel graphics), CUDA (NVIDIA, fastest) or CPU.
// Models are Google's Gemma 4 family in GGUF form from the ggml-org Hugging Face organisation: every
// size reads images (schematic pages, scope screens) and supports tool calling, which the assistant
// needs. Downloads resume after an interruption and are checked against their published SHA-256.
// The server speaks the OpenAI Chat Completions API on 127.0.0.1, so the assistant talks to it like
// any other provider. Nothing leaves the PC once the files are downloaded.
package localai

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"tracelab/internal/osutil"
)

const gb = float64(1 << 30)

// Model is one choice offered to the user, with plain-language trade-offs.
type Model struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Repo     string   `json:"repo"`
	Quant    string   `json:"quant"`
	Params   string   `json:"params"`
	ApproxGB float64  `json:"approx_gb"` // download size, model + vision file
	NeedGB   float64  `json:"need_gb"`   // memory while running with a 16k context
	MoE      bool     `json:"moe"`       // mixture of experts: few active parameters, tolerates RAM offload
	Summary  string   `json:"summary"`
	Best     string   `json:"best"`
	Pros     []string `json:"pros"`
	Cons     []string `json:"cons"`
}

var Catalog = []Model{
	{ID: "gemma4-e2b", Name: "Gemma 4 E2B · Compact", Repo: "ggml-org/gemma-4-E2B-it-GGUF", Quant: "Q4_0", Params: "2B effective", ApproxGB: 3.5, NeedGB: 4.5,
		Summary: "The smallest and quickest. Runs on almost any PC, even without a graphics card.",
		Best:    "Older or thin laptops, PCs with 8 GB of RAM, or when you want instant answers.",
		Pros:    []string{"Starts fast and answers fast", "Works on CPU only", "Smallest download"},
		Cons:    []string{"Loses track more often on long, multi-step diagnoses", "Weaker at reading dense schematics"}},
	{ID: "gemma4-e4b", Name: "Gemma 4 E4B · Balanced", Repo: "ggml-org/gemma-4-E4B-it-GGUF", Quant: "Q4_0", Params: "4B effective", ApproxGB: 5.5, NeedGB: 6.5,
		Summary: "The best all-rounder for most repair benches.",
		Best:    "Any graphics card with 6 GB or more, or a laptop with 16 GB of RAM.",
		Pros:    []string{"Fast on most graphics cards", "Follows guided diagnosis well for common faults", "Reads schematic pages and scope screens"},
		Cons:    []string{"Can miss subtle details in complex power sequencing"}},
	{ID: "gemma4-26b", Name: "Gemma 4 26B-A4B · Smart and quick", Repo: "ggml-org/gemma-4-26B-A4B-it-GGUF", Quant: "Q4_0", Params: "26B (4B active)", ApproxGB: 17, NeedGB: 18.5, MoE: true,
		Summary: "Close to top quality while staying quick. It's a \"mixture of experts\" model that uses only about 4B of its 26B parameters for each word, so it stays usable even when part of it has to run from system RAM.",
		Best:    "Graphics cards with 12 to 16 GB, or PCs with 32 GB of RAM or more.",
		Pros:    []string{"Much better at tracing enable chains and multi-step fault-finding", "Still fast when it doesn't fully fit in graphics memory"},
		Cons:    []string{"Large download", "Needs plenty of memory"}},
	{ID: "gemma4-31b", Name: "Gemma 4 31B · Best quality", Repo: "ggml-org/gemma-4-31B-it-GGUF", Quant: "Q4_0", Params: "31B", ApproxGB: 20, NeedGB: 21.5,
		Summary: "The strongest model that runs offline. Best at reasoning through complex power sequencing and dense schematics.",
		Best:    "A 24 GB graphics card (RTX 3090, 4090 or 5090, Radeon RX 7900 XTX).",
		Pros:    []string{"Highest-quality diagnosis offline", "Best schematic reading"},
		Cons:    []string{"Slow unless it fits entirely in graphics memory", "Largest download"}},
}

func ModelByID(id string) *Model {
	for i := range Catalog {
		if Catalog[i].ID == id {
			return &Catalog[i]
		}
	}
	return nil
}

// Fit describes how well a model will run on this PC.
type Fit struct {
	ID     string `json:"id"`
	Level  string `json:"level"` // great | ok | slow | too_big
	Label  string `json:"label"`
	Detail string `json:"detail"`
}

type Engine struct {
	ID    string `json:"id"` // vulkan | cuda | cpu
	Name  string `json:"name"`
	About string `json:"about"`
}

var Engines = []Engine{
	{ID: "vulkan", Name: "Graphics card (Vulkan)", About: "Uses any NVIDIA, AMD or Intel graphics, including integrated graphics. Falls back to the CPU if needed."},
	{ID: "cuda", Name: "NVIDIA (CUDA)", About: "Fastest on NVIDIA cards. A bigger download (about 600 MB more)."},
	{ID: "cpu", Name: "Processor only", About: "No graphics card used. Slowest; best with the Compact model."},
}

// Advice is what the setup screens show: the PC's hardware, how each model fits, and a recommendation.
type Advice struct {
	Hardware    osutil.Hardware `json:"hardware"`
	Summary     string          `json:"summary"`
	Fits        []Fit           `json:"fits"`
	Recommended string          `json:"recommended"`
	Engine      string          `json:"engine"`
	Engines     []Engine        `json:"engines"`
	Models      []Model         `json:"models"`
}

func fmtGB(b uint64) string { return fmt.Sprintf("%.0f GB", float64(b)/gb) }

func Advise(h osutil.Hardware) Advice {
	a := Advice{Hardware: h, Engines: Engines, Models: Catalog}
	g := h.BestGPU()
	ram := float64(h.RAM) / gb
	vram := 0.0
	if g != nil && !g.Integrated {
		vram = float64(g.VRAM) / gb
	}
	igpu := g != nil && g.Integrated
	switch {
	case g != nil && !g.Integrated:
		a.Summary = fmt.Sprintf("%s with %s of graphics memory, %s of RAM.", g.Name, fmtGB(g.VRAM), fmtGB(h.RAM))
	case igpu:
		a.Summary = fmt.Sprintf("%s (integrated graphics, shares system memory), %s of RAM.", g.Name, fmtGB(h.RAM))
	default:
		a.Summary = fmt.Sprintf("No graphics card found. %s of RAM, %s.", fmtGB(h.RAM), strings.TrimSpace(h.CPU+" CPU"))
	}
	a.Engine = "vulkan"
	if g == nil {
		a.Engine = "cpu"
	}
	for _, m := range Catalog {
		f := Fit{ID: m.ID}
		switch {
		case vram > 0 && m.NeedGB <= vram*0.92:
			f.Level, f.Label, f.Detail = "great", "Runs great", "Fits entirely in your graphics card's memory, so answers come quickly."
		case vram > 0 && m.MoE && m.NeedGB <= vram+ram*0.5:
			f.Level, f.Label, f.Detail = "ok", "Runs well", "Splits between your graphics card and system RAM; the mixture-of-experts design keeps it quick."
		case vram > 0 && m.NeedGB <= vram+ram*0.5:
			f.Level, f.Label, f.Detail = "slow", "Slow here", "Doesn't fit in your graphics memory, so part of it runs from system RAM. Expect a few words per second."
		case igpu && m.NeedGB <= ram*0.55:
			if m.NeedGB <= 8 || m.MoE {
				f.Level, f.Label, f.Detail = "ok", "Runs OK", "Runs on your integrated graphics using system memory. Usable speed."
			} else {
				f.Level, f.Label, f.Detail = "slow", "Slow here", "Runs on integrated graphics from system memory; large models are slow this way."
			}
		case g == nil && m.NeedGB <= ram*0.55:
			if m.NeedGB <= 7 {
				f.Level, f.Label, f.Detail = "ok", "Runs OK", "Runs on your processor. Usable for a small model."
			} else {
				f.Level, f.Label, f.Detail = "slow", "Slow here", "Runs on your processor only; expect slow answers."
			}
		default:
			f.Level, f.Label, f.Detail = "too_big", "Too big for this PC", fmt.Sprintf("Needs about %.0f GB of memory; this PC doesn't have enough free.", m.NeedGB)
		}
		a.Fits = append(a.Fits, f)
	}
	// Biggest model that runs fully in graphics memory; a mixture-of-experts model also counts when
	// a decent card (12 GB+) holds most of it. Otherwise the biggest that runs at a usable speed.
	for i := len(a.Fits) - 1; i >= 0 && a.Recommended == ""; i-- {
		if f := a.Fits[i]; f.Level == "great" || (f.Level == "ok" && Catalog[i].MoE && vram >= 12) {
			a.Recommended = f.ID
		}
	}
	for i := len(a.Fits) - 1; i >= 0 && a.Recommended == ""; i-- {
		if a.Fits[i].Level == "ok" {
			a.Recommended = a.Fits[i].ID
		}
	}
	if a.Recommended == "" {
		a.Recommended = Catalog[0].ID
	}
	return a
}

// ---- downloads ----

type Progress struct {
	Running  bool    `json:"running"`
	Phase    string  `json:"phase"` // engine | model | vision | verify | done
	Label    string  `json:"label"`
	Done     int64   `json:"done"`
	Total    int64   `json:"total"`
	Rate     float64 `json:"rate"` // bytes/s
	Error    string  `json:"error,omitempty"`
	Finished bool    `json:"finished"`
	Model    string  `json:"model,omitempty"`
	Engine   string  `json:"engine,omitempty"`
	Step     int     `json:"step"`
	Steps    int     `json:"steps"`
}

type Manager struct {
	Dir       string   // where engines and models are kept
	ExtraDirs []string // more folders to look for GGUF models in (besides LM Studio and Ollama)

	mu     sync.Mutex
	prog   Progress
	cancel context.CancelFunc
	srv    *server
}

func NewManager(dir string) *Manager { return &Manager{Dir: dir} }

var client = &http.Client{Timeout: 0, Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 60 * time.Second}}

func ghAPI() string {
	if b := os.Getenv("TRACELAB_GITHUB_API"); b != "" {
		return strings.TrimRight(b, "/")
	}
	return "https://api.github.com"
}

func hfBase() string {
	if b := os.Getenv("TRACELAB_HF_BASE"); b != "" {
		return strings.TrimRight(b, "/")
	}
	return "https://huggingface.co"
}

func (m *Manager) set(f func(p *Progress)) { m.mu.Lock(); f(&m.prog); m.mu.Unlock() }

func (m *Manager) Progress() Progress { m.mu.Lock(); defer m.mu.Unlock(); return m.prog }

type engineInfo struct {
	Variant string `json:"variant"`
	Tag     string `json:"tag"`
	Exe     string `json:"exe"`
}

type modelInfo struct {
	ID      string `json:"id"`
	Repo    string `json:"repo"`
	Model   string `json:"model"`
	Vision  string `json:"vision"`
	Bytes   int64  `json:"bytes"`
	Fetched int64  `json:"fetched"`
}

func (m *Manager) engineDir(v string) string { return filepath.Join(m.Dir, "engine", v) }
func (m *Manager) modelDir(id string) string { return filepath.Join(m.Dir, "models", id) }

func readJSON(p string, v any) bool {
	b, err := os.ReadFile(p)
	return err == nil && json.Unmarshal(b, v) == nil
}

func writeJSON(p string, v any) error {
	b, _ := json.MarshalIndent(v, "", " ")
	return os.WriteFile(p, b, 0o644)
}

// EngineInstalled reports the installed engine build for a variant.
func (m *Manager) EngineInstalled(v string) (engineInfo, bool) {
	var e engineInfo
	if readJSON(filepath.Join(m.engineDir(v), "engine.json"), &e) {
		if _, err := os.Stat(e.Exe); err == nil {
			return e, true
		}
	}
	// The folder moved (or the manifest is missing): find llama-server in the engine folder itself.
	if exe := findFile(m.engineDir(v), serverExe()); exe != "" {
		e.Variant, e.Exe = v, exe
		_ = writeJSON(filepath.Join(m.engineDir(v), "engine.json"), e)
		return e, true
	}
	return e, false
}

// isAuxFile spots GGUF files that ship beside a model but can't be loaded as one.
func isAuxFile(name string) bool {
	n := strings.ToLower(filepath.Base(name))
	for _, p := range []string{"mtp-", "mtp_", "draft", "dflash", "imatrix", "eagle"} {
		if strings.HasPrefix(n, p) || strings.Contains(n, "-"+p) {
			return true
		}
	}
	return false
}

func (m *Manager) ModelInstalled(id string) (modelInfo, bool) {
	var mi modelInfo
	if strings.HasPrefix(id, "ext:") { // a model file from LM Studio, Ollama or a folder of the user's
		e, ok := m.FindExternal(id)
		if !ok {
			return mi, false
		}
		return modelInfo{ID: id, Model: e.Path, Vision: e.Vision, Bytes: e.Bytes}, true
	}
	if !readJSON(filepath.Join(m.modelDir(id), "model.json"), &mi) {
		// Files are there but the manifest isn't (an interrupted earlier download, an older version, or
		// files copied in by hand): recognise a complete model file and write the manifest again.
		if r, ok := m.recoverModel(id); ok {
			return r, true
		}
		return mi, false
	}
	if isAuxFile(mi.Model) { // fetched by Trace Lab 1.5.0/1.5.1 by mistake: download the real model
		return mi, false
	}
	if _, err := os.Stat(filepath.Join(m.modelDir(id), mi.Model)); err != nil {
		return mi, false
	}
	return mi, true
}

func (m *Manager) recoverModel(id string) (modelInfo, bool) {
	dir := m.modelDir(id)
	ents, err := os.ReadDir(dir)
	if err != nil {
		return modelInfo{}, false
	}
	var model, vision string
	var bytes int64
	for _, e := range ents {
		n := strings.ToLower(e.Name())
		if e.IsDir() || !strings.HasSuffix(n, ".gguf") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		switch {
		case strings.Contains(n, "mmproj"):
			if vision == "" || strings.Contains(n, "q8_0") {
				vision = e.Name()
			}
		case isAuxFile(n):
		case info.Size() >= 100<<20 && info.Size() > bytes:
			model, bytes = e.Name(), info.Size()
		}
	}
	if model == "" {
		return modelInfo{}, false
	}
	mi := modelInfo{ID: id, Model: model, Vision: vision, Bytes: bytes, Fetched: time.Now().Unix()}
	if mod := ModelByID(id); mod != nil {
		mi.Repo = mod.Repo
	}
	_ = writeJSON(filepath.Join(dir, "model.json"), mi)
	return mi, true
}

type InstalledModel struct {
	ID    string `json:"id"`
	Bytes int64  `json:"bytes"`
}

func (m *Manager) Installed() (models []InstalledModel, engines []string) {
	for _, c := range Catalog {
		if mi, ok := m.ModelInstalled(c.ID); ok {
			models = append(models, InstalledModel{ID: c.ID, Bytes: mi.Bytes})
		}
	}
	for _, e := range Engines {
		if _, ok := m.EngineInstalled(e.ID); ok {
			engines = append(engines, e.ID)
		}
	}
	return
}

// Download fetches the engine (if missing) and the model in the background.
func (m *Manager) Download(modelID, variant string) error {
	mod := ModelByID(modelID)
	if mod == nil {
		return fmt.Errorf("unknown model %q", modelID)
	}
	if variant == "" {
		variant = "vulkan"
	}
	m.mu.Lock()
	if m.prog.Running {
		m.mu.Unlock()
		return errors.New("a download is already running")
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.prog = Progress{Running: true, Phase: "engine", Label: "Getting ready…", Model: modelID, Engine: variant, Steps: 3, Step: 1}
	m.mu.Unlock()
	go func() {
		err := m.run(ctx, *mod, variant)
		m.set(func(p *Progress) {
			p.Running = false
			if err != nil {
				if ctx.Err() != nil {
					p.Error = "Download paused. It will continue from where it stopped next time."
				} else {
					p.Error = err.Error()
				}
				return
			}
			p.Finished, p.Phase, p.Label = true, "done", mod.Name+" is ready."
		})
	}()
	return nil
}

func (m *Manager) Cancel() {
	m.mu.Lock()
	if m.cancel != nil {
		m.cancel()
	}
	m.mu.Unlock()
}

func (m *Manager) run(ctx context.Context, mod Model, variant string) error {
	if err := os.MkdirAll(m.Dir, 0o755); err != nil {
		return fmt.Errorf("can't create %s: %v", m.Dir, err)
	}
	if _, ok := m.EngineInstalled(variant); !ok {
		if err := m.fetchEngine(ctx, variant); err != nil {
			return fmt.Errorf("couldn't download the AI engine: %v", err)
		}
	}
	m.set(func(p *Progress) { p.Step = 2 })
	if _, ok := m.ModelInstalled(mod.ID); ok {
		return nil
	}
	return m.fetchModel(ctx, mod)
}

type ghAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
	Size int64  `json:"size"`
}

type ghRelease struct {
	Tag    string    `json:"tag_name"`
	Draft  bool      `json:"draft"`
	Assets []ghAsset `json:"assets"`
}

var cudaRe = regexp.MustCompile(`cuda-?([\d.]+)`)

// pickAssets finds the engine zip(s) for a variant in one release's assets, tolerating naming changes
// (llama-b6500-bin-win-vulkan-x64.zip, llama-v1.2.0-bin-win-vulkan-x64.zip, …). CUDA also needs the
// matching cudart runtime zip.
func pickAssets(assets []ghAsset, variant, osTag string) []*ghAsset {
	ok := func(n string) bool {
		n = strings.ToLower(n)
		return strings.HasSuffix(n, ".zip") && strings.Contains(n, "-"+osTag+"-") && (strings.Contains(n, "x64") || strings.Contains(n, "amd64")) && !strings.Contains(n, "arm64")
	}
	if variant == "cuda" {
		var best *ghAsset
		bestV := ""
		for i := range assets {
			n := strings.ToLower(assets[i].Name)
			if !ok(n) || strings.HasPrefix(n, "cudart") {
				continue
			}
			if mm := cudaRe.FindStringSubmatch(n); mm != nil && (best == nil || verLess(bestV, mm[1])) {
				best, bestV = &assets[i], mm[1]
			}
		}
		if best == nil {
			return nil
		}
		out := []*ghAsset{best}
		for i := range assets {
			n := strings.ToLower(assets[i].Name)
			if strings.HasPrefix(n, "cudart") && ok(n) && strings.Contains(n, "cuda-"+bestV) {
				out = append(out, &assets[i])
				break
			}
		}
		return out
	}
	var best *ghAsset
	for i := range assets {
		n := strings.ToLower(assets[i].Name)
		if !ok(n) || strings.HasPrefix(n, "cudart") || !strings.Contains(n, "-"+variant) {
			continue
		}
		if best == nil || (strings.HasPrefix(n, "llama") && !strings.HasPrefix(strings.ToLower(best.Name), "llama")) {
			best = &assets[i]
		}
	}
	if best == nil {
		return nil
	}
	return []*ghAsset{best}
}

func (m *Manager) fetchEngine(ctx context.Context, variant string) error {
	m.set(func(p *Progress) {
		p.Phase, p.Label, p.Done, p.Total = "engine", "Finding the latest AI engine (llama.cpp)…", 0, 0
	})
	// Not just releases/latest: llama.cpp's stable "v1.x" releases can be source-only while its numbered
	// builds (b1234) carry the binaries, so take the newest release that has the build we need.
	req, _ := http.NewRequestWithContext(ctx, "GET", ghAPI()+"/repos/ggml-org/llama.cpp/releases?per_page=40", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "TraceLab")
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("GitHub answered %s", res.Status)
	}
	var rels []ghRelease
	if err := json.NewDecoder(res.Body).Decode(&rels); err != nil {
		return err
	}
	osTag := map[string]string{"windows": "win", "linux": "ubuntu", "darwin": "macos"}[runtime.GOOS]
	var rel ghRelease
	var want []*ghAsset
	for i := range rels {
		if rels[i].Draft {
			continue
		}
		if w := pickAssets(rels[i].Assets, variant, osTag); len(w) > 0 {
			rel, want = rels[i], w
			break
		}
	}
	if len(want) == 0 {
		if variant == "cuda" {
			return errors.New("no recent llama.cpp release has an NVIDIA CUDA build; choose the graphics card (Vulkan) engine")
		}
		return fmt.Errorf("no recent llama.cpp release has a %s build for this system", variant)
	}
	dir := m.engineDir(variant)
	tmpDir := dir + ".new"
	_ = os.RemoveAll(tmpDir)
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return err
	}
	for _, a := range want {
		zp := filepath.Join(m.Dir, "engine", a.Name)
		label := "Downloading the AI engine (" + rel.Tag + ")"
		if strings.HasPrefix(a.Name, "cudart") {
			label = "Downloading NVIDIA CUDA runtime"
		}
		if err := m.fetchFile(ctx, a.URL, zp, a.Size, "", "engine", label); err != nil {
			return err
		}
		if err := unzip(zp, tmpDir); err != nil {
			return fmt.Errorf("couldn't unpack %s: %v", a.Name, err)
		}
		_ = os.Remove(zp)
	}
	exe := findFile(tmpDir, serverExe())
	if exe == "" {
		return errors.New("the engine download didn't contain llama-server")
	}
	_ = os.RemoveAll(dir)
	if err := os.Rename(tmpDir, dir); err != nil {
		return err
	}
	exe = filepath.Join(dir, strings.TrimPrefix(exe, tmpDir))
	if runtime.GOOS != "windows" {
		_ = os.Chmod(exe, 0o755)
	}
	return writeJSON(filepath.Join(dir, "engine.json"), engineInfo{Variant: variant, Tag: rel.Tag, Exe: exe})
}

func verLess(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			fmt.Sscan(pa[i], &x)
		}
		if i < len(pb) {
			fmt.Sscan(pb[i], &y)
		}
		if x != y {
			return x < y
		}
	}
	return false
}

func serverExe() string {
	if runtime.GOOS == "windows" {
		return "llama-server.exe"
	}
	return "llama-server"
}

func findFile(root, name string) string {
	found := ""
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.EqualFold(d.Name(), name) {
			found = p
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

func unzip(zp, dst string) error {
	r, err := zip.OpenReader(zp)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		p := filepath.Join(dst, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(p, filepath.Clean(dst)+string(os.PathSeparator)) {
			continue // zip-slip guard
		}
		if f.FileInfo().IsDir() {
			_ = os.MkdirAll(p, 0o755)
			continue
		}
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, f.Mode()|0o600)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		rc.Close()
		out.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

type hfFile struct {
	Type string `json:"type"`
	Path string `json:"path"`
	Size int64  `json:"size"`
	LFS  *struct {
		Oid  string `json:"oid"`
		Size int64  `json:"size"`
	} `json:"lfs"`
}

func (f hfFile) size() int64 {
	if f.LFS != nil && f.LFS.Size > 0 {
		return f.LFS.Size
	}
	return f.Size
}

// ResolveFiles lists a model repo and picks the model file (preferred quantisation) and vision file.
func ResolveFiles(ctx context.Context, mod Model) (model, vision hfFile, err error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", hfBase()+"/api/models/"+mod.Repo+"/tree/main", nil)
	req.Header.Set("User-Agent", "TraceLab")
	res, err := client.Do(req)
	if err != nil {
		return model, vision, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return model, vision, fmt.Errorf("Hugging Face answered %s for %s", res.Status, mod.Repo)
	}
	var files []hfFile
	if err := json.NewDecoder(res.Body).Decode(&files); err != nil {
		return model, vision, err
	}
	var ggufs, mm []hfFile
	for _, f := range files {
		n := strings.ToLower(f.Path)
		if f.Type != "file" || !strings.HasSuffix(n, ".gguf") {
			continue
		}
		base := filepath.Base(n)
		switch {
		case strings.Contains(base, "mmproj"):
			mm = append(mm, f)
		case isAuxFile(base):
			// draft / multi-token-prediction heads (e.g. mtp-gemma-4-E4B-it-Q4_0.gguf) aren't models on their own
		default:
			ggufs = append(ggufs, f)
		}
	}
	if len(ggufs) == 0 {
		return model, vision, fmt.Errorf("no model files found in %s", mod.Repo)
	}
	sort.Slice(ggufs, func(i, j int) bool { return ggufs[i].size() < ggufs[j].size() })
	model = ggufs[0]
	found := false
	for _, q := range []string{mod.Quant, "Q4_K_M", "Q4_0", "Q4_K", "Q5_K_M", "Q8_0"} {
		for _, f := range ggufs {
			if strings.Contains(strings.ToUpper(f.Path), strings.ToUpper(q)) {
				model, found = f, true
				break
			}
		}
		if found {
			break
		}
	}
	if len(mm) > 0 {
		sort.Slice(mm, func(i, j int) bool { return mm[i].size() < mm[j].size() })
		vision = mm[0]
	pick: // Q8_0 reads images as well as F16/BF16 at about half the size
		for _, want := range []string{"q8_0", "f16"} {
			for _, f := range mm {
				if strings.Contains(strings.ToLower(f.Path), want) {
					vision = f
					break pick
				}
			}
		}
	}
	return model, vision, nil
}

// Sizes looks up the real download size of each catalog model (falls back to the estimate).
func Sizes(ctx context.Context) map[string]int64 {
	out := map[string]int64{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, c := range Catalog {
		wg.Add(1)
		go func(c Model) {
			defer wg.Done()
			m, v, err := ResolveFiles(ctx, c)
			if err == nil {
				mu.Lock()
				out[c.ID] = m.size() + v.size()
				mu.Unlock()
			}
		}(c)
	}
	wg.Wait()
	return out
}

func (m *Manager) fetchModel(ctx context.Context, mod Model) error {
	m.set(func(p *Progress) { p.Phase, p.Label, p.Done, p.Total = "model", "Looking up "+mod.Name+"…", 0, 0 })
	mf, vf, err := ResolveFiles(ctx, mod)
	if err != nil {
		return fmt.Errorf("couldn't find the model files: %v", err)
	}
	dir := m.modelDir(mod.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if free := osutil.FreeSpace(dir); free > 0 && uint64(mf.size()+vf.size()) > free {
		return fmt.Errorf("not enough disk space: %s needs %.1f GB and the drive has %.1f GB free. Choose another folder for AI models", mod.Name, float64(mf.size()+vf.size())/gb, float64(free)/gb)
	}
	sha := func(f hfFile) string {
		if f.LFS != nil {
			return f.LFS.Oid
		}
		return ""
	}
	url := func(f hfFile) string { return hfBase() + "/" + mod.Repo + "/resolve/main/" + f.Path }
	if err := m.fetchFile(ctx, url(mf), filepath.Join(dir, filepath.Base(mf.Path)), mf.size(), sha(mf), "model", "Downloading "+mod.Name); err != nil {
		return err
	}
	m.set(func(p *Progress) { p.Step = 3 })
	vision := ""
	if vf.Path != "" {
		vision = filepath.Base(vf.Path)
		if err := m.fetchFile(ctx, url(vf), filepath.Join(dir, vision), vf.size(), sha(vf), "vision", "Downloading the image reader for "+mod.Name); err != nil {
			return err
		}
	}
	keep := map[string]bool{strings.ToLower(filepath.Base(mf.Path)): true, strings.ToLower(vision): true}
	if ents, err := os.ReadDir(dir); err == nil { // drop files from an earlier, different pick
		for _, e := range ents {
			if n := strings.ToLower(e.Name()); strings.HasSuffix(n, ".gguf") && !keep[n] {
				_ = os.Remove(filepath.Join(dir, e.Name()))
			}
		}
	}
	return writeJSON(filepath.Join(dir, "model.json"), modelInfo{ID: mod.ID, Repo: mod.Repo, Model: filepath.Base(mf.Path), Vision: vision, Bytes: mf.size() + vf.size(), Fetched: time.Now().Unix()})
}

// fetchFile downloads url to dst with resume and an optional SHA-256 check.
func (m *Manager) fetchFile(ctx context.Context, url, dst string, size int64, sha, phase, label string) error {
	if st, err := os.Stat(dst); err == nil && (size <= 0 || st.Size() == size) {
		return nil
	}
	part := dst + ".part"
	h := sha256.New()
	var have int64
	if f, err := os.Open(part); err == nil { // resume: hash what we already have
		m.set(func(p *Progress) { p.Phase, p.Label = phase, label+" (resuming)" })
		have, _ = io.Copy(h, f)
		f.Close()
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", "TraceLab")
	if have > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", have))
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	flags := os.O_CREATE | os.O_WRONLY
	switch {
	case res.StatusCode == http.StatusPartialContent && have > 0:
		flags |= os.O_APPEND
	case res.StatusCode == http.StatusOK:
		have = 0
		h.Reset()
		flags |= os.O_TRUNC
	case res.StatusCode == http.StatusRequestedRangeNotSatisfiable && have > 0 && have == size:
		// already complete
	default:
		return fmt.Errorf("download failed: %s", res.Status)
	}
	if size <= 0 && res.ContentLength > 0 {
		size = have + res.ContentLength
	}
	out, err := os.OpenFile(part, flags, 0o644)
	if err != nil {
		return err
	}
	m.set(func(p *Progress) { p.Phase, p.Label, p.Done, p.Total, p.Rate = phase, label, have, size, 0 })
	buf := make([]byte, 1<<20)
	t0, done0, last := time.Now(), have, time.Now()
	for res.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if _, err := out.Write(buf[:n]); err != nil {
				out.Close()
				return fmt.Errorf("couldn't write the download: %v", err)
			}
			h.Write(buf[:n])
			have += int64(n)
			if time.Since(last) > 200*time.Millisecond {
				last = time.Now()
				rate := float64(have-done0) / time.Since(t0).Seconds()
				hv := have
				m.set(func(p *Progress) { p.Done, p.Rate = hv, rate })
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			out.Close()
			return rerr
		}
	}
	out.Close()
	m.set(func(p *Progress) { p.Done = have })
	if size > 0 && have != size {
		return fmt.Errorf("the download stopped early (%d of %d bytes); try again to resume", have, size)
	}
	if sha != "" && !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), sha) {
		_ = os.Remove(part)
		return errors.New("the downloaded file was damaged (checksum mismatch); try again")
	}
	return os.Rename(part, dst)
}

// Remove deletes a downloaded model (and stops the server if it's using it).
func (m *Manager) Remove(id string) error {
	if strings.HasPrefix(id, "ext:") {
		return errors.New("this model belongs to another app or folder; Trace Lab doesn't delete it")
	}
	m.mu.Lock()
	s := m.srv
	m.mu.Unlock()
	if s != nil && s.model == id {
		m.Stop()
	}
	return os.RemoveAll(m.modelDir(id))
}
