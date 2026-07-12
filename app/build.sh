#!/bin/bash
# Build the native FABULA-LLM-5.app binary from FabulaApp.swift.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/../FABULA-LLM-5.app"
BIN="$APP/Contents/MacOS/FABULA-LLM-5"

mkdir -p "$APP/Contents/MacOS"
echo "Compiling Swift → $BIN"
swiftc -O "$HERE/FabulaApp.swift" -o "$BIN" \
  -framework Cocoa -framework WebKit \
  -target arm64-apple-macos12.0

# Ad-hoc codesign so Gatekeeper/WebKit are happy on this machine.
codesign --force --deep --sign - "$APP" 2>/dev/null || true
echo "Done. Bundle: $APP"
