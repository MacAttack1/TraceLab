//go:build windows

// Trace Lab installer. Per-user install (no admin rights) to %LOCALAPPDATA%\Programs\Trace Lab.
//
//	TraceLab-Setup.exe              setup wizard (install location, data, folders, offline AI)
//	TraceLab-Setup.exe /S           silent install (used by the in-app updater)
//	TraceLab-Setup.exe /S /relaunch silent install, then start Trace Lab
//	"Uninstall Trace Lab.exe" /uninstall [/S]
package main

import (
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

//go:embed payload/TraceLab.exe
var payload []byte

var appVersion = "1.6.2" // -X main.appVersion

const (
	appName     = "Trace Lab"
	appID       = "TraceLab"
	exeName     = "TraceLab.exe"
	uninstName  = "Uninstall Trace Lab.exe"
	uninstKey   = `Software\Microsoft\Windows\CurrentVersion\Uninstall\TraceLab`
	progID      = "TraceLab.Boardview"
	publisher   = "Trace Lab"
	mbOK        = 0x0
	mbYesNo     = 0x4
	mbIconInfo  = 0x40
	mbIconQuest = 0x20
	mbIconErr   = 0x10
	idYes       = 6
)

// Boardview extensions that get an "Open with > Trace Lab" entry. Defaults are never taken over.
var boardExts = []string{".brd", ".bdv", ".fz", ".cae", ".asc", ".bvr", ".bvr3", ".cad", ".cst", ".pcb", ".kicad_pcb", ".pcbdoc", ".ipc", ".356", ".d356"}

var (
	user32     = syscall.NewLazyDLL("user32.dll")
	shell32    = syscall.NewLazyDLL("shell32.dll")
	messageBox = user32.NewProc("MessageBoxW")
	changeNtfy = shell32.NewProc("SHChangeNotify")
)

func msg(text string, flags uintptr) int {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(appName + " Setup")
	r, _, _ := messageBox.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags|0x10000) // MB_SETFOREGROUND
	return int(r)
}

func installDir() string {
	if k, err := registry.OpenKey(registry.CURRENT_USER, uninstKey, registry.QUERY_VALUE); err == nil { // keep an existing install where it is
		loc, _, _ := k.GetStringValue("InstallLocation")
		k.Close()
		if loc != "" {
			return loc
		}
	}
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base, _ = os.UserConfigDir()
	}
	return filepath.Join(base, "Programs", appName)
}

func startMenuLink() string {
	return filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs`, appName+".lnk")
}

func desktopLink() string {
	d, err := windows.KnownFolderPath(windows.FOLDERID_Desktop, 0)
	if err != nil {
		home, _ := os.UserHomeDir()
		d = filepath.Join(home, "Desktop")
	}
	return filepath.Join(d, appName+".lnk")
}

func has(args []string, flags ...string) bool {
	for _, a := range args {
		for _, f := range flags {
			if strings.EqualFold(a, f) {
				return true
			}
		}
	}
	return false
}

func main() {
	runtime.LockOSThread()
	args := os.Args[1:]
	silent := has(args, "/S", "-S", "--silent")
	if has(args, "/uninstall", "--uninstall") {
		uninstall(silent)
		return
	}
	if !silent && runWizard() {
		return
	}
	install(silent, has(args, "/relaunch", "--relaunch"))
}

// ---- setup wizard ----

type winPlatform struct{}

func (winPlatform) installDir() string       { return installDir() }
func (winPlatform) installedVersion() string { return installedVersion() }
func (winPlatform) hasDesktopShortcut() bool { return fileExists(desktopLink()) }
func (winPlatform) note() string             { return "" }
func (winPlatform) launch(dir string)        { _ = exec.Command(filepath.Join(dir, exeName)).Start() }

func (winPlatform) copyFiles(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("couldn't create the install folder: %v", err)
	}
	exe := filepath.Join(dir, exeName)
	if err := writeWithRetry(exe, payload, 30*time.Second); err != nil {
		return fmt.Errorf("couldn't replace %s. Close Trace Lab and try again (%v)", exeName, err)
	}
	go func() { time.Sleep(3 * time.Second); _ = os.Remove(exe + ".old") }()
	if self, err := os.Executable(); err == nil {
		if b, err := os.ReadFile(self); err == nil {
			_ = writeWithRetry(filepath.Join(dir, uninstName), b, 10*time.Second)
		}
	}
	return nil
}

func (winPlatform) integrate(dir string, desktop, openWith bool) error {
	exe := filepath.Join(dir, exeName)
	err := withCOM(func() error {
		if err := makeShortcut(startMenuLink(), exe, dir); err != nil {
			return err
		}
		if desktop {
			return makeShortcut(desktopLink(), exe, dir)
		}
		_ = os.Remove(desktopLink())
		return nil
	})
	registerApp(dir, exe)
	if !openWith {
		unregisterFileTypes()
	}
	changeNtfy.Call(0x08000000, 0, 0, 0)
	return err
}

// runWizard shows the setup wizard. It returns false if WebView2 isn't available, so the caller
// falls back to the simple message-box install.
func runWizard() bool {
	url, run, err := serveWizard("0", winPlatform{})
	if err != nil {
		return false
	}
	tmp := filepath.Join(os.TempDir(), "TraceLabSetup")
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus:     true,
		DataPath:      filepath.Join(tmp, "WebView2"),
		WindowOptions: webview2.WindowOptions{Title: appName + " Setup", Width: 1040, Height: 780, IconId: 2, Center: true},
	})
	if w == nil {
		return false
	}
	go func() {
		<-run.finish
		w.Dispatch(func() { w.Terminate() })
	}()
	w.Navigate(url)
	w.Run()
	w.Destroy()
	run.mu.Lock()
	ai := run.ai
	run.mu.Unlock()
	if ai != nil {
		ai.Cancel() // closing the window pauses the download; Trace Lab resumes it
	}
	_ = os.RemoveAll(tmp)
	return true
}

func installedVersion() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, uninstKey, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, _ := k.GetStringValue("DisplayVersion")
	return v
}

func install(silent, relaunch bool) {
	dir := installDir()
	prev := installedVersion()
	if !silent {
		q := fmt.Sprintf("Install %s %s?\n\nIt installs for your Windows account only, so no administrator rights are needed:\n%s", appName, appVersion, dir)
		if prev != "" {
			q = fmt.Sprintf("Update %s from %s to %s?\n\nYour settings, API key and readings are kept.", appName, prev, appVersion)
		}
		if msg(q, mbYesNo|mbIconQuest) != idYes {
			return
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fail(silent, "Couldn't create the install folder:\n"+err.Error())
		return
	}
	exe := filepath.Join(dir, exeName)
	// The running app may take a moment to exit after starting an update.
	if err := writeWithRetry(exe, payload, 60*time.Second); err != nil {
		fail(silent, "Couldn't replace "+exeName+". Close Trace Lab and run setup again.\n\n"+err.Error())
		return
	}
	go func() { time.Sleep(3 * time.Second); _ = os.Remove(exe + ".old") }()
	if self, err := os.Executable(); err == nil {
		if b, err := os.ReadFile(self); err == nil {
			_ = writeWithRetry(filepath.Join(dir, uninstName), b, 10*time.Second)
		}
	}
	shortcutErr := withCOM(func() error {
		if err := makeShortcut(startMenuLink(), exe, dir); err != nil {
			return err
		}
		if prev == "" || fileExists(desktopLink()) {
			return makeShortcut(desktopLink(), exe, dir)
		}
		return nil
	})
	registerApp(dir, exe)
	changeNtfy.Call(0x08000000, 0, 0, 0) // SHCNE_ASSOCCHANGED: refresh icons and Open-with lists

	if relaunch {
		_ = exec.Command(exe, "--updated").Start()
		return
	}
	if !silent {
		done := fmt.Sprintf("%s %s is installed.", appName, appVersion)
		if shortcutErr != nil {
			done += "\n\nThe Start menu shortcut couldn't be created (" + shortcutErr.Error() + "). You can start it from:\n" + exe
		}
		if msg(done+"\n\nOpen Trace Lab now?", mbYesNo|mbIconInfo) == idYes {
			_ = exec.Command(exe).Start()
		}
	}
}

func fail(silent bool, text string) {
	if silent {
		// Updater runs us silently; leave a log the user can find.
		if d, err := os.UserConfigDir(); err == nil {
			_ = os.MkdirAll(filepath.Join(d, appID), 0o700)
			_ = os.WriteFile(filepath.Join(d, appID, "update-error.log"), []byte(time.Now().Format(time.RFC3339)+" "+text), 0o600)
		}
		return
	}
	msg(text, mbOK|mbIconErr)
}

func writeWithRetry(path string, data []byte, wait time.Duration) error {
	deadline := time.Now().Add(wait)
	tmp := path + ".new"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return err
	}
	for {
		err := os.Rename(tmp, path)
		if err == nil {
			return nil
		}
		// A running exe can't be overwritten but can be renamed out of the way.
		old := path + ".old"
		_ = os.Remove(old)
		if os.Rename(path, old) == nil {
			if err = os.Rename(tmp, path); err == nil {
				return nil
			}
		}
		if time.Now().After(deadline) {
			_ = os.Remove(tmp)
			return err
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func dirSize(root string) int64 {
	var n int64
	_ = filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			n += info.Size()
		}
		return nil
	})
	return n
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func withCOM(fn func() error) error {
	if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
		if oe, ok := err.(*ole.OleError); !ok || (oe.Code() != 1 && oe.Code() != 0) { // S_FALSE: already initialised
			return err
		}
	}
	defer ole.CoUninitialize()
	return fn()
}

func makeShortcut(lnk, target, workdir string) error {
	_ = os.MkdirAll(filepath.Dir(lnk), 0o755)
	unk, err := oleutil.CreateObject("WScript.Shell")
	if err != nil {
		return err
	}
	defer unk.Release()
	shell, err := unk.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return err
	}
	defer shell.Release()
	v, err := oleutil.CallMethod(shell, "CreateShortcut", lnk)
	if err != nil {
		return err
	}
	sc := v.ToIDispatch()
	defer sc.Release()
	for k, val := range map[string]string{"TargetPath": target, "WorkingDirectory": workdir, "IconLocation": target + ",0", "Description": "Boardview and schematic viewer with an AI repair assistant"} {
		if _, err := oleutil.PutProperty(sc, k, val); err != nil {
			return err
		}
	}
	_, err = oleutil.CallMethod(sc, "Save")
	return err
}

func setStr(root registry.Key, path string, vals map[string]string) {
	k, _, err := registry.CreateKey(root, path, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	for n, v := range vals {
		_ = k.SetStringValue(n, v)
	}
}

func registerApp(dir, exe string) {
	cu := registry.CURRENT_USER
	un := filepath.Join(dir, uninstName)
	setStr(cu, uninstKey, map[string]string{
		"DisplayName": appName, "DisplayVersion": appVersion, "Publisher": publisher, "DisplayIcon": exe + ",0",
		"InstallLocation": dir, "UninstallString": `"` + un + `" /uninstall`, "QuietUninstallString": `"` + un + `" /uninstall /S`,
	})
	if k, err := registry.OpenKey(cu, uninstKey, registry.SET_VALUE); err == nil {
		_ = k.SetDWordValue("NoModify", 1)
		_ = k.SetDWordValue("NoRepair", 1)
		_ = k.SetDWordValue("EstimatedSize", uint32(len(payload)/1024+200))
		k.Close()
	}
	open := `"` + exe + `" "%1"`
	setStr(cu, `Software\Classes\`+progID, map[string]string{"": "Boardview file", "FriendlyTypeName": "Boardview file"})
	setStr(cu, `Software\Classes\`+progID+`\DefaultIcon`, map[string]string{"": exe + ",0"})
	setStr(cu, `Software\Classes\`+progID+`\shell\open\command`, map[string]string{"": open})
	setStr(cu, `Software\Classes\Applications\`+exeName, map[string]string{"FriendlyAppName": appName})
	setStr(cu, `Software\Classes\Applications\`+exeName+`\shell\open\command`, map[string]string{"": open})
	types := map[string]string{".pdf": ""}
	for _, e := range boardExts {
		types[e] = ""
		setStr(cu, `Software\Classes\`+e+`\OpenWithProgids`, map[string]string{progID: ""})
	}
	setStr(cu, `Software\Classes\Applications\`+exeName+`\SupportedTypes`, types)
}

func unregisterFileTypes() {
	for _, e := range boardExts {
		if k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Classes\`+e+`\OpenWithProgids`, registry.SET_VALUE); err == nil {
			_ = k.DeleteValue(progID)
			k.Close()
		}
	}
}

func unregisterApp() {
	cu := registry.CURRENT_USER
	unregisterFileTypes()
	for _, p := range []string{
		`Software\Classes\` + progID + `\shell\open\command`, `Software\Classes\` + progID + `\shell\open`, `Software\Classes\` + progID + `\shell`,
		`Software\Classes\` + progID + `\DefaultIcon`, `Software\Classes\` + progID,
		`Software\Classes\Applications\` + exeName + `\shell\open\command`, `Software\Classes\Applications\` + exeName + `\shell\open`,
		`Software\Classes\Applications\` + exeName + `\shell`, `Software\Classes\Applications\` + exeName + `\SupportedTypes`,
		`Software\Classes\Applications\` + exeName, uninstKey,
	} {
		_ = registry.DeleteKey(cu, p)
	}
}

func uninstall(silent bool) {
	dir := installDir()
	if self, err := os.Executable(); err == nil {
		dir = filepath.Dir(self)
	}
	if !silent && msg("Remove "+appName+" from this PC?\n\nYour settings and API key in %APPDATA%\\TraceLab are kept. Delete that folder too if you want them gone.", mbYesNo|mbIconQuest) != idYes {
		return
	}
	exe := filepath.Join(dir, exeName)
	for i := 0; i < 20; i++ {
		if err := os.Remove(exe); err == nil || os.IsNotExist(err) {
			break
		}
		if i == 19 {
			fail(silent, "Trace Lab is still running. Close it and try again.")
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
	_ = os.Remove(startMenuLink())
	_ = os.Remove(desktopLink())
	unregisterApp()
	changeNtfy.Call(0x08000000, 0, 0, 0)
	// Offline AI models are large; offer to remove them too (settings and readings are always kept).
	md := defaultModelsDir()
	if v, ok := readAppConfig()["models_dir"].(string); ok && v != "" {
		md = v
	}
	if n := dirSize(md); !silent && n > 50<<20 && msg(fmt.Sprintf("Also delete the downloaded offline AI models (%.1f GB)?\n\n%s", float64(n)/(1<<30), md), mbYesNo|mbIconQuest) == idYes {
		_ = os.RemoveAll(md)
	}
	// This uninstaller lives in the folder it removes, so hand the last step to cmd.
	cmd := exec.Command("cmd", "/C", "ping 127.0.0.1 -n 3 >nul & rmdir /s /q \""+dir+"\"")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	_ = cmd.Start()
	if !silent {
		msg(appName+" was removed.", mbOK|mbIconInfo)
	}
}
