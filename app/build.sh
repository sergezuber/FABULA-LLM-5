#!/bin/bash
# Build the native FABULA-LLM-5.app bundle from FabulaApp.swift.
#
# Writes the COMPLETE bundle every time — binary, Info.plist, PkgInfo, icon — then codesigns.
# The Info.plist is not optional decoration: without CFBundleIdentifier, UNUserNotificationCenter
# aborts the whole app at launch on macOS (LaunchServices cannot resolve the bundle proxy), so a
# bundle consisting of just Contents/MacOS/<binary> crashes on a fresh machine.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/../FABULA-LLM-5.app"
BIN="$APP/Contents/MacOS/FABULA-LLM-5"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
echo "Compiling Swift → $BIN"
swiftc -O "$HERE/FabulaApp.swift" -o "$BIN" \
  -framework Cocoa -framework WebKit \
  -target arm64-apple-macos12.0

# App version = FABULA_VERSION from the engine changelog (single source of truth), else 0.0.0.
VERSION="$(sed -n 's/^export const FABULA_VERSION = "\(.*\)"$/\1/p' "$HERE/../engine/packages/app/src/data/fabula-changelog.ts" 2>/dev/null | head -1)"
[ -n "$VERSION" ] || VERSION="0.0.0"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>FABULA-LLM-5</string>
  <key>CFBundleDisplayName</key><string>FABULA-LLM-5</string>
  <key>CFBundleIdentifier</key><string>com.sistemma.fabula-llm-5</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>FABULA-LLM-5</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict></plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"
cp -f "$HERE/icon.icns" "$APP/Contents/Resources/icon.icns"

# Sign LAST, after every resource is in place (signing first would break the seal), then let
# LaunchServices re-read the bundle so the identifier resolves on first launch.
codesign --force --deep --sign - "$APP" 2>/dev/null || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
echo "Done. Bundle: $APP (v$VERSION)"
