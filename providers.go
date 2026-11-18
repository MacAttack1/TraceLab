package main

// AI provider proxy. The page builds a provider-appropriate request body; this forwards it to the
// chosen service with the right URL and auth header, keeping API keys server-side, and streams the
// SSE response straight back. Anthropic uses its Messages API; every other provider is treated as an
// OpenAI-compatible Chat Completions endpoint (OpenAI, Google Gemini's OpenAI endpoint, OpenRouter,
// and any local or custom server such as Ollama or LM Studio).

import (
	"bytes"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

var aiClient = &http.Client{Transport: &http.Transport{
	Proxy:                 http.ProxyFromEnvironment,
	DialContext:           (&net.Dialer{Timeout: 20 * time.Second}).DialContext,
	TLSHandshakeTimeout:   20 * time.Second,
	ResponseHeaderTimeout: 180 * time.Second,
}}

func builtinFZKeyWords() string {
	h := strings.TrimSpace(builtinFZKeyHex)
	if len(h) != 352 {
		return ""
	}
	if _, err := hex.DecodeString(h); err != nil {
		return ""
	}
	var b strings.Builder
	for i := 0; i < 44; i++ {
		if i > 0 {
			b.WriteByte(' ')
		}
		b.WriteString("0x")
		b.WriteString(h[i*8 : i*8+8])
	}
	return b.String()
}

func anthropicBase() string {
	if b := os.Getenv("TRACELAB_API_BASE"); b != "" {
		return strings.TrimRight(b, "/")
	}
	return aiProviders["anthropic"]
}

// openaiBaseFor returns the Chat Completions base for a provider, honouring a test override.
func openaiBaseFor(provider string) string {
	if b := os.Getenv("TRACELAB_AI_BASE"); b != "" {
		return strings.TrimRight(b, "/")
	}
	if provider == "custom" {
		return strings.TrimRight(cfg.BaseURL, "/")
	}
	return aiProviders[provider]
}

func chatCompletionsURL(base string) string {
	base = strings.TrimRight(base, "/")
	if strings.HasSuffix(base, "/chat/completions") {
		return base
	}
	return base + "/chat/completions"
}

func registerAIProxy(mux *http.ServeMux) {
	mux.HandleFunc("/api/messages", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			apiErr(w, 405, "POST only")
			return
		}
		provider := r.Header.Get("X-TL-Provider")
		cfgMu.Lock()
		if provider == "" {
			provider = currentProvider()
		}
		if _, ok := aiProviders[provider]; !ok {
			provider = currentProvider()
		}
		key := providerKey(provider)
		base := cfg.BaseURL
		cfgMu.Unlock()

		var url string
		req := func() *http.Request {
			body, _ := io.ReadAll(io.LimitReader(r.Body, 64<<20))
			rq, _ := http.NewRequestWithContext(r.Context(), http.MethodPost, url, bytes.NewReader(body))
			rq.Header.Set("Content-Type", "application/json")
			rq.Header.Set("User-Agent", appID+"/"+appVersion)
			return rq
		}

		if provider == "anthropic" {
			if key == "" {
				apiErr(w, 428, "No Anthropic API key is set. Add one in Settings.")
				return
			}
			url = anthropicBase() + "/v1/messages"
			rq := req()
			rq.Header.Set("x-api-key", key)
			rq.Header.Set("anthropic-version", "2023-06-01")
			forward(w, rq)
			return
		}

		if provider == "custom" && base == "" && os.Getenv("TRACELAB_AI_BASE") == "" {
			apiErr(w, 428, "Set the base URL for your custom AI service in Settings (for example http://localhost:1234/v1).")
			return
		}
		if key == "" && provider != "custom" {
			apiErr(w, 428, "No API key is set for "+provider+". Add one in Settings.")
			return
		}
		url = chatCompletionsURL(openaiBaseFor(provider))
		rq := req()
		if key != "" {
			rq.Header.Set("Authorization", "Bearer "+key)
		}
		if provider == "openrouter" {
			rq.Header.Set("X-Title", appName)
			rq.Header.Set("HTTP-Referer", "https://github.com/"+effectiveRepo())
		}
		forward(w, rq)
	})
}

// registerModelsRoute lists the models the user's key can use, so the Settings model picker is never stale.
// Every supported service exposes GET …/models returning {"data":[{"id":…}]}.
func registerModelsRoute(mux *http.ServeMux) {
	mux.HandleFunc("/api/models", func(w http.ResponseWriter, r *http.Request) {
		provider := r.URL.Query().Get("provider")
		cfgMu.Lock()
		if _, ok := aiProviders[provider]; !ok {
			provider = currentProvider()
		}
		key := providerKey(provider)
		base := cfg.BaseURL
		cfgMu.Unlock()
		var url string
		if provider == "anthropic" {
			url = anthropicBase() + "/v1/models?limit=100"
		} else {
			b := openaiBaseFor(provider)
			if provider == "custom" && b == "" && base == "" {
				apiErr(w, 428, "Set the base URL for your custom AI service first.")
				return
			}
			url = strings.TrimSuffix(strings.TrimRight(b, "/"), "/chat/completions") + "/models"
		}
		if key == "" && provider != "custom" {
			apiErr(w, 428, "Save an API key for "+provider+" first.")
			return
		}
		rq, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, url, nil)
		rq.Header.Set("User-Agent", appID+"/"+appVersion)
		if provider == "anthropic" {
			rq.Header.Set("x-api-key", key)
			rq.Header.Set("anthropic-version", "2023-06-01")
		} else if key != "" {
			rq.Header.Set("Authorization", "Bearer "+key)
		}
		forward(w, rq)
	})
}

func forward(w http.ResponseWriter, rq *http.Request) {
	resp, err := aiClient.Do(rq)
	if err != nil {
		apiErr(w, 502, "Couldn't reach the AI service: "+err.Error())
		return
	}
	defer resp.Body.Close()
	for _, h := range []string{"Content-Type", "Request-Id", "Retry-After", "X-Request-Id"} {
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
}
