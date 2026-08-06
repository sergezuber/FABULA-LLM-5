#!/usr/bin/env bash
# FABULA — build the self-contained desktop app from source.
#
#   1) engine/  — the local-first FABULA engine + embedded SolidJS frontend (lean fork of
#      OpenCode, MIT). Produces a single self-contained `fabula` engine binary with the web UI
#      embedded, installed at repo-local ./bin/fabula (the path the app resolves as `fabula`).
#   2) app/     — the native macOS Swift/WKWebView wrapper that launches the engine headless
#      and shows its web UI in its own window (own icon, no browser).
#
# This repo is self-contained: no external checkout is needed.
set -euo pipefail

# The desktop shell's two manifests are TRACKED and carry the version, so they are stamped on EVERY
# platform — including this one, where the shell itself is not built. Skipping it here is what let them
# lag behind the source and fail the deploy check on the platforms that do build it.
bun "$(cd "$(dirname "$0")" && pwd)/scripts/stamp-shell-version.ts" || true
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "== [1/3] engine deps =="
cd "$ROOT/engine"
bun install

echo "== [2/3] engine binary (frontend embedded) =="
bun run --cwd packages/app build
( cd packages/opencode && MIMOCODE_CHANNEL=prod bun run script/build.ts --single )
# The engine binary this platform produces — `mimo` everywhere, `mimo.exe` on Windows.
# `|| true` is load-bearing under `set -e`: with two globs, the one that matches nothing makes `ls` exit
# non-zero, and a command substitution's status is the assignment's status — so the script died silently
# right after the engine compiled, leaving a half-deployed tree that the deploy guard then called STALE.
BIN="$(ls -t "$ROOT"/engine/packages/opencode/dist/*/bin/mimo "$ROOT"/engine/packages/opencode/dist/*/bin/mimo.exe 2>/dev/null | head -1 || true)"
[ -n "$BIN" ] && [ -f "$BIN" ] || { echo "FAIL: engine binary not produced"; exit 1; }
codesign --force -s - "$BIN" 2>/dev/null || true
echo "engine binary: $BIN"

# Install the engine binary at the repo-local runtime path the app resolves as `fabula`
# (via `command -v fabula`). Keeps the running engine inside this repo — nothing external.
mkdir -p "$ROOT/bin"
# The installed name carries this platform's executable suffix, because that is the name the shell and
# `verify-deploy.sh` both look for.
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) INSTALLED="$ROOT/bin/fabula.exe" ;; *) INSTALLED="$ROOT/bin/fabula" ;; esac
cp -f "$BIN" "$INSTALLED"
codesign --force -s - "$INSTALLED" 2>/dev/null || true
echo "engine installed in-repo: $INSTALLED"

echo "== [3/3] desktop shell =="
cd "$ROOT"
# macOS keeps its own Swift/WKWebView host; every other platform gets the Tauri shell, which implements
# the SAME contract (engine child, diagnostic log, health deadline, five bridges, teardown). Building
# both on macOS would produce two windows claiming the same port, so each platform builds its own.
case "$(uname -s 2>/dev/null)" in
  Darwin) FABULA_ENGINE="$ROOT/bin/fabula" bash app/build.sh ;;
  *)      bash shell/build.sh ;;
esac

echo "FABULA build complete. Engine: $INSTALLED"
