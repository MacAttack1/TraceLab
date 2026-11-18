//go:build !windows

// Development build of the installer: serves the setup wizard on 127.0.0.1 so it can be tried and
// tested in a browser. It "installs" a placeholder file instead of TraceLab.exe.
package main

import (
	"fmt"
	"os"
	"path/filepath"
)

var appVersion = "dev"

const appID = "TraceLab"

type devPlatform struct{}

func (devPlatform) installDir() string {
	if d := os.Getenv("TRACELAB_SETUP_DIR"); d != "" {
		return d
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".local", "share", "Trace Lab")
}
func (devPlatform) installedVersion() string           { return os.Getenv("TRACELAB_SETUP_PREV") }
func (devPlatform) hasDesktopShortcut() bool           { return false }
func (devPlatform) note() string                       { return "Development build: nothing is really installed." }
func (devPlatform) launch(dir string)                  { fmt.Println("launch", dir) }
func (devPlatform) integrate(string, bool, bool) error { return nil }
func (devPlatform) copyFiles(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "TraceLab.placeholder"), []byte(appVersion), 0o644)
}

func main() {
	port := os.Getenv("TRACELAB_SETUP_PORT")
	if port == "" {
		port = "0"
	}
	url, run, err := serveWizard(port, devPlatform{})
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	fmt.Println("wizard", url)
	launch := <-run.finish
	fmt.Println("finished, launch =", launch)
}
