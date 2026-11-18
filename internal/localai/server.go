package localai

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"tracelab/internal/osutil"
)

type server struct {
	cmd     *exec.Cmd
	model   string
	variant string
	port    int
	ready   bool
	cpu     bool // fell back to CPU after the graphics engine failed
	err     string
	done    chan struct{}
	log     *bytes.Buffer
	mu      sync.Mutex
}

type ServerStatus struct {
	State   string `json:"state"` // stopped | starting | running | error
	Model   string `json:"model,omitempty"`
	Engine  string `json:"engine,omitempty"`
	Port    int    `json:"port,omitempty"`
	CPU     bool   `json:"cpu,omitempty"`
	Error   string `json:"error,omitempty"`
	LogTail string `json:"log_tail,omitempty"`
}

func freePort() int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 8139
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

type syncBuf struct {
	mu sync.Mutex
	b  *bytes.Buffer
	f  *os.File
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f != nil {
		s.f.Write(p)
	}
	s.b.Write(p)
	if s.b.Len() > 64<<10 {
		t := s.b.Bytes()[s.b.Len()-32<<10:]
		s.b = bytes.NewBuffer(append([]byte(nil), t...))
	}
	return len(p), nil
}

func (m *Manager) Status() ServerStatus {
	m.mu.Lock()
	s := m.srv
	m.mu.Unlock()
	if s == nil {
		return ServerStatus{State: "stopped"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st := ServerStatus{State: "starting", Model: s.model, Engine: s.variant, Port: s.port, CPU: s.cpu}
	select {
	case <-s.done:
		st.State, st.Error = "error", s.err
		if st.Error == "" {
			st.State = "stopped"
		}
	default:
		if s.ready {
			st.State = "running"
		}
	}
	if st.State == "error" {
		st.LogTail = tail(s.log.String(), 1200)
	}
	return st
}

func tail(s string, n int) string {
	if len(s) > n {
		s = s[len(s)-n:]
	}
	return strings.TrimSpace(s)
}

// Ready reports why a model can't be started yet (nil when it can).
func (m *Manager) Ready(modelID string) error {
	if _, ok := m.ModelInstalled(modelID); !ok {
		return errors.New("that offline model isn't downloaded yet. Open Settings → Offline AI to download it")
	}
	for _, e := range Engines {
		if _, ok := m.EngineInstalled(e.ID); ok {
			return nil
		}
	}
	return errors.New("the offline AI engine isn't downloaded yet. Open Settings → Offline AI to download it")
}

// Ensure starts llama-server with the model (or reuses the running one) and returns its
// OpenAI-compatible base URL once the model is loaded.
func (m *Manager) Ensure(modelID, variant string, ctxSize int) (string, error) {
	if variant == "" {
		variant = "vulkan"
	}
	m.mu.Lock()
	s := m.srv
	m.mu.Unlock()
	if s != nil && s.model == modelID {
		select {
		case <-s.done:
		default:
			if err := s.waitReady(4 * time.Minute); err != nil {
				return "", err
			}
			return fmt.Sprintf("http://127.0.0.1:%d/v1", s.port), nil
		}
	}
	if s != nil {
		m.Stop()
	}
	eng, ok := m.EngineInstalled(variant)
	if !ok {
		for _, e := range Engines { // any installed engine will do
			if eng, ok = m.EngineInstalled(e.ID); ok {
				variant = e.ID
				break
			}
		}
	}
	if !ok {
		return "", errors.New("the offline AI engine isn't downloaded yet. Open Settings → Offline AI to download it")
	}
	mi, ok := m.ModelInstalled(modelID)
	if !ok {
		return "", errors.New("that offline model isn't downloaded yet. Open Settings → Offline AI to download it")
	}
	if ctxSize <= 0 {
		ctxSize = 16384
	}
	s, err := m.start(eng, mi, variant, ctxSize, variant == "cpu")
	if err != nil {
		return "", err
	}
	err = s.waitReady(4 * time.Minute)
	if err != nil && variant != "cpu" && !s.cpu {
		// Graphics driver problems are the usual cause: try again on the processor.
		m.Stop()
		if s2, err2 := m.start(eng, mi, variant, ctxSize, true); err2 == nil {
			if err = s2.waitReady(6 * time.Minute); err == nil {
				s = s2
			}
		}
	}
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("http://127.0.0.1:%d/v1", s.port), nil
}

func (m *Manager) start(eng engineInfo, mi modelInfo, variant string, ctxSize int, cpu bool) (*server, error) {
	dir := m.modelDir(mi.ID)
	port := freePort()
	ngl := "999"
	if cpu {
		ngl = "0"
	}
	args := []string{"-m", filepath.Join(dir, mi.Model), "--jinja", "-ngl", ngl, "-c", strconv.Itoa(ctxSize),
		"--host", "127.0.0.1", "--port", strconv.Itoa(port), "--alias", mi.ID}
	if mi.Vision != "" {
		args = append(args, "--mmproj", filepath.Join(dir, mi.Vision))
	}
	cmd := exec.Command(eng.Exe, args...)
	cmd.Dir = filepath.Dir(eng.Exe)
	osutil.HideWindow(cmd)
	lf, _ := os.Create(filepath.Join(m.Dir, "server.log"))
	buf := &syncBuf{b: &bytes.Buffer{}, f: lf}
	cmd.Stdout, cmd.Stderr = buf, buf
	if err := cmd.Start(); err != nil {
		if lf != nil {
			lf.Close()
		}
		return nil, fmt.Errorf("couldn't start the AI engine: %v", err)
	}
	s := &server{cmd: cmd, model: mi.ID, variant: variant, port: port, cpu: cpu, done: make(chan struct{}), log: buf.b}
	go func() {
		err := cmd.Wait()
		if lf != nil {
			lf.Close()
		}
		s.mu.Lock()
		if !s.ready || err != nil {
			s.err = "The AI engine stopped"
			if err != nil {
				s.err += ": " + err.Error()
			}
		}
		s.log = buf.b
		s.mu.Unlock()
		close(s.done)
	}()
	m.mu.Lock()
	m.srv = s
	m.mu.Unlock()
	return s, nil
}

func (s *server) waitReady(max time.Duration) error {
	s.mu.Lock()
	if s.ready {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	deadline := time.Now().Add(max)
	c := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		select {
		case <-s.done:
			s.mu.Lock()
			defer s.mu.Unlock()
			return fmt.Errorf("%s. %s", s.err, lastLine(s.log.String()))
		case <-time.After(400 * time.Millisecond):
		}
		r, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/health", s.port))
		if err == nil {
			r.Body.Close()
			if r.StatusCode == 200 {
				s.mu.Lock()
				s.ready = true
				s.mu.Unlock()
				return nil
			}
		}
	}
	return errors.New("the AI model took too long to load")
}

func lastLine(s string) string {
	ls := strings.Split(strings.TrimSpace(s), "\n")
	for i := len(ls) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(ls[i]); l != "" {
			return l
		}
	}
	return ""
}

func (m *Manager) Stop() {
	m.mu.Lock()
	s := m.srv
	m.srv = nil
	m.mu.Unlock()
	if s == nil || s.cmd.Process == nil {
		return
	}
	_ = s.cmd.Process.Kill()
	select {
	case <-s.done:
	case <-time.After(5 * time.Second):
	}
}
