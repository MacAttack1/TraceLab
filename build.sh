#!/usr/bin/env bash
# Builds TraceLab.exe and TraceLab-Setup-<version>.exe into dist/. Used locally and by GitHub Actions.
#   ./build.sh 1.2.0 [owner/repo]
set -euo pipefail
VERSION="${1:?usage: build.sh VERSION [owner/repo]}"
REPO="${2:-}"
cd "$(dirname "$0")"
mkdir -p dist installer/payload
export GOOS=windows GOARCH=amd64 CGO_ENABLED=0

# Built-in ASUS FZ key (RC6), injected from a secret so it never lives in the repo.
# Provide it as the TRACELAB_FZ_KEY env var (a GitHub Actions secret) or in build/fzkey.secret
# (gitignored): 352 hex chars = 44 eight-digit words, no 0x, no spaces.
FZKEY="${TRACELAB_FZ_KEY:-}"
if [ -z "$FZKEY" ] && [ -f build/fzkey.secret ]; then FZKEY="$(cat build/fzkey.secret)"; fi
# Accept any pasted form ("0x12345678 0x9abcdef0, …", line breaks, the 352-char blob): keep only the hex digits.
FZKEY="$(printf '%s' "$FZKEY" | sed 's/0[xX]//g' | tr -cd '0-9a-fA-F')"
if [ -n "$FZKEY" ] && [ "${#FZKEY}" -ne 352 ]; then
  echo "warning: FZ key has ${#FZKEY} hex digits, expected 352 (44 words); building without it" >&2
  FZKEY=""
fi
if [ -z "$FZKEY" ]; then echo "warning: no FZ key set; encrypted .fz files won't open in this build" >&2; fi

cp web/js/aichoice.js installer/wizard/aichoice.js # the setup wizard shares the model picker
go build -trimpath -ldflags "-H windowsgui -s -w -X main.appVersion=${VERSION} -X main.defaultUpdateRepo=${REPO} -X main.builtinFZKeyHex=${FZKEY}" -o installer/payload/TraceLab.exe .
go build -trimpath -ldflags "-H windowsgui -s -w -X main.appVersion=${VERSION}" -o "dist/TraceLab-Setup-${VERSION}.exe" ./installer
cp installer/payload/TraceLab.exe "dist/TraceLab-${VERSION}-portable.exe"
( cd dist && sha256sum "TraceLab-Setup-${VERSION}.exe" > "TraceLab-Setup-${VERSION}.exe.sha256" )
ls -la dist
