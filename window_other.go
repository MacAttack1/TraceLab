//go:build !windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
)

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}

func openBrowser(url string) { _ = exec.Command("xdg-open", url).Start() }

// On non-Windows builds (used for development and testing) the UI opens in the default browser.
func runWindow(url string) {
	fmt.Println(appName, "running at", url)
	log.Println("open", url)
	if os.Getenv("TRACELAB_NO_BROWSER") == "" {
		_ = exec.Command("xdg-open", url).Start()
	}
	select {}
}

// Self-update installs only on Windows. TRACELAB_FAKE_INSTALL lets tests exercise download + checksum on other OSes.
var canSelfUpdate = os.Getenv("TRACELAB_FAKE_INSTALL") != ""

func launchInstaller(path string) error {
	if m := os.Getenv("TRACELAB_FAKE_INSTALL"); m != "" {
		return os.WriteFile(m, []byte(path), 0o600)
	}
	return fmt.Errorf("self-update is only supported on Windows (downloaded %s)", path)
}
