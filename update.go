package main

// Self-update from GitHub Releases. A release carries TraceLab-Setup-<ver>.exe (and a .sha256);
// the app downloads it, checks the hash, runs it silently, and exits so it can be replaced.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type ghAsset struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	APIURL      string `json:"url"`
	DownloadURL string `json:"browser_download_url"`
}

type ghRelease struct {
	TagName    string    `json:"tag_name"`
	Name       string    `json:"name"`
	Body       string    `json:"body"`
	HTMLURL    string    `json:"html_url"`
	Draft      bool      `json:"draft"`
	Prerelease bool      `json:"prerelease"`
	Published  string    `json:"published_at"`
	Assets     []ghAsset `json:"assets"`
}

var repoRe = regexp.MustCompile(`^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`)

// normalizeRepo accepts "owner/repo", a github.com URL, or a .git URL.
func normalizeRepo(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(s, "/")
	s = strings.TrimSuffix(s, ".git")
	for _, p := range []string{"https://github.com/", "http://github.com/", "github.com/", "git@github.com:"} {
		s = strings.TrimPrefix(s, p)
	}
	if parts := strings.Split(s, "/"); len(parts) > 2 {
		s = parts[0] + "/" + parts[1]
	}
	return s
}

func ghAPIBase() string {
	if b := os.Getenv("TRACELAB_GITHUB_API"); b != "" {
		return strings.TrimSuffix(b, "/")
	}
	return "https://api.github.com"
}

var ghClient = &http.Client{Timeout: 10 * time.Minute}

func ghGet(url, accept string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", appID+"/"+appVersion)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	cfgMu.Lock()
	tok := cfg.GitHubToken
	cfgMu.Unlock()
	if tok != "" && strings.HasPrefix(url, ghAPIBase()) {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	return ghClient.Do(req)
}

func latestRelease(repo string) (*ghRelease, error) {
	if !repoRe.MatchString(repo) {
		return nil, fmt.Errorf("%q isn't a GitHub repo. Use the form owner/repo", repo)
	}
	resp, err := ghGet(ghAPIBase()+"/repos/"+repo+"/releases/latest", "application/vnd.github+json")
	if err != nil {
		return nil, fmt.Errorf("couldn't reach GitHub: %v", err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == 404:
		return nil, fmt.Errorf("no published release found in %s. Either the repo has no releases yet, or it's private and needs a GitHub token in Settings", repo)
	case resp.StatusCode == 401:
		return nil, errors.New("GitHub rejected the token in Settings")
	case resp.StatusCode == 403 || resp.StatusCode == 429:
		return nil, errors.New("GitHub's rate limit was hit. Try again later, or add a GitHub token in Settings")
	case resp.StatusCode != 200:
		return nil, fmt.Errorf("GitHub returned HTTP %d", resp.StatusCode)
	}
	var rel ghRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&rel); err != nil {
		return nil, fmt.Errorf("GitHub's reply couldn't be read: %v", err)
	}
	return &rel, nil
}

var setupRe = regexp.MustCompile(`(?i)^tracelab[-_. ]?setup.*\.exe$`)

func pickAssets(rel *ghRelease) (setup, sum *ghAsset) {
	for i := range rel.Assets {
		if setupRe.MatchString(rel.Assets[i].Name) {
			setup = &rel.Assets[i]
			break
		}
	}
	if setup == nil {
		for i := range rel.Assets {
			n := strings.ToLower(rel.Assets[i].Name)
			if strings.HasSuffix(n, ".exe") && strings.Contains(n, "setup") {
				setup = &rel.Assets[i]
				break
			}
		}
	}
	if setup != nil {
		for i := range rel.Assets {
			if strings.EqualFold(rel.Assets[i].Name, setup.Name+".sha256") {
				sum = &rel.Assets[i]
			}
		}
	}
	return
}

// compareVersions returns -1, 0 or 1. "v1.2.10" > "1.2.9"; a pre-release suffix sorts before the release.
func compareVersions(a, b string) int {
	norm := func(v string) ([]int, string) {
		v = strings.TrimPrefix(strings.TrimSpace(strings.ToLower(v)), "v")
		pre := ""
		if i := strings.IndexAny(v, "-+"); i >= 0 {
			pre, v = v[i:], v[:i]
		}
		var out []int
		for _, p := range strings.Split(v, ".") {
			n, _ := strconv.Atoi(p)
			out = append(out, n)
		}
		for len(out) < 3 {
			out = append(out, 0)
		}
		return out, pre
	}
	x, xp := norm(a)
	y, yp := norm(b)
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			if x[i] < y[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case xp == yp:
		return 0
	case xp == "":
		return 1
	case yp == "":
		return -1
	case xp < yp:
		return -1
	}
	return 1
}

func downloadAsset(a *ghAsset, dst string) error {
	cfgMu.Lock()
	tok := cfg.GitHubToken
	cfgMu.Unlock()
	var resp *http.Response
	var err error
	if tok != "" && a.APIURL != "" {
		resp, err = ghGet(a.APIURL, "application/octet-stream") // works for private repos
	} else {
		resp, err = ghGet(a.DownloadURL, "application/octet-stream")
	}
	if err != nil {
		return fmt.Errorf("download failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
	}
	_ = os.MkdirAll(filepath.Dir(dst), 0o700)
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, 512<<20))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("download failed: %v", err)
	}
	if a.Size > 0 && n != a.Size {
		return fmt.Errorf("download was incomplete (%d of %d bytes)", n, a.Size)
	}
	return nil
}

func verifyDownload(path string, sum *ghAsset) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if len(b) < 2 || b[0] != 'M' || b[1] != 'Z' {
		return errors.New("the downloaded file isn't a Windows program")
	}
	if sum == nil {
		return nil
	}
	tmp := path + ".sha256"
	if err := downloadAsset(sum, tmp); err != nil {
		return fmt.Errorf("checksum download failed: %v", err)
	}
	want, _ := os.ReadFile(tmp)
	_ = os.Remove(tmp)
	fields := strings.Fields(string(bytes.TrimSpace(want)))
	if len(fields) == 0 {
		return errors.New("the release's checksum file is empty")
	}
	h := sha256.Sum256(b)
	if !strings.EqualFold(fields[0], hex.EncodeToString(h[:])) {
		return errors.New("the download doesn't match the release checksum, so it wasn't installed")
	}
	return nil
}

func registerUpdateRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/update/check", func(w http.ResponseWriter, r *http.Request) {
		cfgMu.Lock()
		repo := effectiveRepo()
		cfgMu.Unlock()
		if q := r.URL.Query().Get("repo"); q != "" {
			repo = normalizeRepo(q)
		}
		out := map[string]any{"current": appVersion, "repo": repo, "configured": repo != "", "can_self_update": canSelfUpdate}
		if repo == "" {
			writeJSON(w, 200, out)
			return
		}
		rel, err := latestRelease(repo)
		if err != nil {
			out["error"] = err.Error()
			writeJSON(w, 200, out)
			return
		}
		setup, sum := pickAssets(rel)
		out["latest"] = strings.TrimPrefix(rel.TagName, "v")
		out["name"] = rel.Name
		out["notes"] = rel.Body
		out["url"] = rel.HTMLURL
		out["published"] = rel.Published
		out["newer"] = compareVersions(rel.TagName, appVersion) > 0
		if setup != nil {
			out["asset"] = setup.Name
			out["size"] = setup.Size
			out["checksum"] = sum != nil
		} else {
			out["asset_error"] = "This release has no TraceLab-Setup .exe attached."
		}
		writeJSON(w, 200, out)
	})

	mux.HandleFunc("/api/update/install", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			apiErr(w, 405, "POST only")
			return
		}
		if !canSelfUpdate {
			apiErr(w, 400, "Automatic install only works in the Windows app. Download the new version from the release page.")
			return
		}
		cfgMu.Lock()
		repo := effectiveRepo()
		cfgMu.Unlock()
		rel, err := latestRelease(repo)
		if err != nil {
			apiErr(w, 502, err.Error())
			return
		}
		if compareVersions(rel.TagName, appVersion) <= 0 && r.URL.Query().Get("force") != "1" {
			apiErr(w, 409, "You already have the latest version.")
			return
		}
		setup, sum := pickAssets(rel)
		if setup == nil {
			apiErr(w, 404, "This release has no TraceLab-Setup .exe attached.")
			return
		}
		dst := filepath.Join(os.TempDir(), appID+"-Update", filepath.Base(setup.Name))
		log.Println("update: downloading", setup.Name)
		if err := downloadAsset(setup, dst); err != nil {
			apiErr(w, 502, err.Error())
			return
		}
		if err := verifyDownload(dst, sum); err != nil {
			_ = os.Remove(dst)
			apiErr(w, 422, err.Error())
			return
		}
		if err := launchInstaller(dst); err != nil {
			apiErr(w, 500, "The installer couldn't start: "+err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "version": strings.TrimPrefix(rel.TagName, "v")})
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		go func() { time.Sleep(800 * time.Millisecond); os.Exit(0) }() // free TraceLab.exe so setup can replace it
	})
}
