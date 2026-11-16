# Trace Lab

Boardview and schematic viewer for motherboard repair, with an AI repair assistant.
Windows 10/11 (64-bit).

- Opens .brd (Test_Link, BRDOUT, Eagle), .bdv, .asc, .fz, .cae, XZZ .pcb, .bvr, GenCAD and Samsung .cad,
  .cst, Altium ASCII, KiCad, IPC-D-356, Allegro text extracts and CSV pin lists.
- Click a net or part on the board or in the schematic PDF to find it in the other.
- Subnets: follows a rail through resistors, inductors, ferrites, fuses and jumpers.
- Log diode-mode, voltage and resistance readings per net, and mark nets known-good or faulty.
  Readings persist in a local database and carry across boards.
- Repair assistant: reads the board and schematic, views schematic pages, uses your readings
  (including known-good values from other boards), and suggests diagnostic steps.
  Works with Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, or a local/custom
  OpenAI-compatible server (Ollama, LM Studio, …). Pick the service and model in Settings.
- Theme (system/light/dark) and accent colour in Settings.

## Encrypted boardviews and the FZ key

Encrypted ASUS `.fz` files need the ASUS RC6 key. It is **not** stored in this repo. It is injected
at build time from a secret so released builds can open `.fz` files without the user entering anything:

- **Local builds:** put the key (352 hex chars = 44 eight-digit words, no `0x`, no spaces) in
  `build/fzkey.secret` (gitignored), or set the `TRACELAB_FZ_KEY` env var before `build.sh`.
- **GitHub Actions:** add a repository secret named `TRACELAB_FZ_KEY` with the same value
  (Settings > Secrets and variables > Actions). The release workflow passes it to the build.

Without it, every other format still works; only encrypted `.fz` files won't open.
XZZ and CAE keys are still entered per-user in Settings.

## Install

Download `TraceLab-Setup-<version>.exe` from [Releases](../../releases/latest) and run it.
It installs for your account only (no admin prompt) to `%LOCALAPPDATA%\Programs\Trace Lab`,
adds Start menu and desktop shortcuts, and adds Trace Lab to "Open with" for boardview files.
Remove it from Settings > Apps.

## Updates

Trace Lab checks this repo's latest release when it starts and offers to install newer versions.
Builds made by this repo's GitHub Action have the repo address built in. For older builds, enter
`owner/repo` in Settings > Updates once. A private repo also needs a GitHub token there
(fine-grained, read-only "Contents" on this repo).

## Publishing a new version

1. Commit your changes.
2. Tag and push:

   ```
   git tag v1.2.0
   git push origin v1.2.0
   ```

3. The **Release** workflow tests the parsers, builds `TraceLab-Setup-1.2.0.exe`, a portable exe and a
   `.sha256` checksum, and publishes the release. Installed copies pick it up on next start.

The repo must be public for unauthenticated update checks.

## Building locally

Needs Go 1.24+. All Go dependencies are vendored in `third_party/`, so no module downloads are needed.

```
./build.sh 1.2.0 owner/repo        # -> dist/TraceLab-Setup-1.2.0.exe
go run .                            # dev run on any OS; opens in your browser
node test/parsers.test.mjs          # format parser tests
```

| Path | What it is |
|---|---|
| `main.go` | local server, settings, config, startup files, built-in keys |
| `providers.go` | AI provider proxy (Anthropic + OpenAI-compatible services) |
| `readings.go` | readings database (per board, cross-board search) |
| `update.go` | GitHub release check, download, checksum, hand-off to installer |
| `window_windows.go` | WebView2 app window |
| `installer/` | per-user installer and uninstaller (embeds the built app) |
| `web/js/parsers.js` | boardview format parsers |
| `web/js/app.js` | board and schematic viewer, settings, readings UI |
| `web/js/ai.js` | repair assistant: system prompt, tools, provider adapters |
| `build/` | icon sources, Windows manifests, `fzkey.secret` (gitignored) |

Env vars: `ANTHROPIC_API_KEY`, `TRACELAB_FZ_KEY` (build-time), `TRACELAB_DEBUG=1` (WebView devtools),
`TRACELAB_PORT`, `TRACELAB_API_BASE` (Anthropic base, for testing), `TRACELAB_AI_BASE`
(OpenAI-compatible base, for testing), `TRACELAB_GITHUB_API`.

## Credits

File-format logic follows [OpenBoardView](https://github.com/OpenBoardView/OpenBoardView) (MIT).
PDF rendering by PDF.js (Apache-2.0). WebView2 binding by jchv/go-webview2 (MIT); go-ole (MIT);
golang.org/x/sys (BSD).
