#!/usr/bin/env bash
# Build the cross-platform FABULA shell and stamp it with the version the source declares.
#
# The version is READ from engine/packages/app/src/data/fabula-changelog.ts — the single source of truth —
# and written into Cargo.toml and tauri.conf.json before compiling, so the number cannot be edited by hand
# in three places and drift in two of them. This is the same rule app/build.sh follows for Info.plist, and
# it is what makes `verify-deploy.sh` able to ask an artifact what it actually carries.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

VERSION="$(sed -n 's/^export const FABULA_VERSION = "\(.*\)"$/\1/p' \
  "$ROOT/engine/packages/app/src/data/fabula-changelog.ts" 2>/dev/null | head -1)"
[ -n "$VERSION" ] || { echo "FAIL: no FABULA_VERSION in the changelog source — nothing to stamp"; exit 1; }
echo "stamping $VERSION"

# Cargo.toml: only the package version, never a dependency's.
perl -0pi -e "s/^version = \"[^\"]*\"/version = \"$VERSION\"/m" "$HERE/Cargo.toml"
perl -0pi -e "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/"  "$HERE/tauri.conf.json"

# `frontendDist` in tauri.conf.json is "ui" — relative to that FILE, never to a guessed repository
# layout. It once read "../shell/ui", which resolved only because the crate directory happens to be
# named `shell`; a copy of the crate built anywhere else died with "this path doesn't exist". Found by
# building it on Linux, where the crate sat somewhere else. (Tauri's schema rejects unknown keys, so the
# reason lives here rather than as a comment inside the JSON.)
cd "$HERE"
cargo build --release

BIN="$HERE/target/release/fabula-shell"
[ -x "$BIN" ] || { echo "FAIL: shell binary not produced"; exit 1; }

# THE THIRD ARTIFACT this platform's verify-deploy checks. On macOS that is the app bundle's Info.plist,
# written by app/build.sh; on Linux a .desktop entry and on Windows a bare version manifest, both written
# here. Absence is a finding there, so these must exist whenever the shell has been built.
mkdir -p "$ROOT/dist"
case "$(uname -s 2>/dev/null)" in
  Linux)
    cat > "$ROOT/dist/fabula.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=FABULA
Comment=Local-first autonomous coding agent
Exec=$BIN
Icon=$HERE/icons/icon.png
Terminal=false
Categories=Development;
Version=$VERSION
DESKTOP
    echo "desktop entry: $ROOT/dist/fabula.desktop"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    printf '%s\n' "$VERSION" > "$ROOT/dist/fabula.version"
    echo "installer manifest: $ROOT/dist/fabula.version"
    ;;
  *)
    echo "(macOS keeps its own bundle — app/build.sh writes Info.plist)"
    ;;
esac
echo "shell built: $BIN (v$VERSION)"
