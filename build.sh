#!/usr/bin/env bash
# Builds TraceLab.exe and TraceLab-Setup-<version>.exe into dist/. Used locally and by GitHub Actions.
#   ./build.sh 1.2.0 [owner/repo]
set -euo pipefail
VERSION="${1:?usage: build.sh VERSION [owner/repo]}"
REPO="${2:-}"
cd "$(dirname "$0")"
mkdir -p dist installer/payload
export GOOS=windows GOARCH=amd64 CGO_ENABLED=0
go build -trimpath -ldflags "-H windowsgui -s -w -X main.appVersion=${VERSION} -X main.defaultUpdateRepo=${REPO}" -o installer/payload/TraceLab.exe .
go build -trimpath -ldflags "-H windowsgui -s -w -X main.appVersion=${VERSION}" -o "dist/TraceLab-Setup-${VERSION}.exe" ./installer
cp installer/payload/TraceLab.exe "dist/TraceLab-${VERSION}-portable.exe"
( cd dist && sha256sum "TraceLab-Setup-${VERSION}.exe" > "TraceLab-Setup-${VERSION}.exe.sha256" )
ls -la dist
