//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
)

var (
	user32         = syscall.NewLazyDLL("user32.dll")
	procMessageBox = user32.NewProc("MessageBoxW")
	procShowWindow = user32.NewProc("ShowWindow")
)

func msgBox(text string, flags uintptr) {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(appName)
	procMessageBox.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
}

func fatal(msg string) {
	msgBox(msg, 0x10) // MB_ICONERROR
	os.Exit(1)
}

func openBrowser(url string) {
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func runWindow(url string) {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		local = dataDir()
	}
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     os.Getenv("TRACELAB_DEBUG") != "",
		AutoFocus: true,
		DataPath:  filepath.Join(local, appID, "WebView2"),
		WindowOptions: webview2.WindowOptions{
			Title:  appName,
			Width:  1600,
			Height: 960,
			IconId: 2, // icon group id from the embedded resource (manifest is 1)
			Center: true,
		},
	})
	if w == nil {
		// WebView2 runtime missing: fall back to the default browser and keep serving.
		msgBox("The Microsoft Edge WebView2 Runtime isn't installed, so Trace Lab will open in your web browser instead.\n\nInstall the runtime from Microsoft (search \"WebView2 Runtime\") to get the app window. Close this Trace Lab process from Task Manager when you're done.", 0x40)
		openBrowser(url)
		select {}
	}
	defer w.Destroy()
	if h := w.Window(); h != nil {
		procShowWindow.Call(uintptr(h), 3) // SW_MAXIMIZE
	}
	w.Navigate(url)
	w.Run()
}

const canSelfUpdate = true

// launchInstaller runs the downloaded setup silently; it waits for this process to exit,
// replaces TraceLab.exe and starts the new version.
func launchInstaller(path string) error {
	cmd := exec.Command(path, "/S", "/relaunch")
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200 | 0x01000000} // NEW_PROCESS_GROUP | BREAKAWAY_FROM_JOB
	if err := cmd.Start(); err != nil {
		cmd = exec.Command(path, "/S", "/relaunch")
		return cmd.Start()
	}
	return nil
}
