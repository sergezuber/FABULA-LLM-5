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
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "== [1/3] engine deps =="
cd "$ROOT/engine"
bun install

echo "== [2/3] engine binary (frontend embedded) =="
bun run --cwd packages/app build
( cd packages/opencode && MIMOCODE_CHANNEL=prod bun run script/build.ts --single )
BIN="$(ls -t "$ROOT"/engine/packages/opencode/dist/*/bin/mimo 2>/dev/null | head -1)"
[ -n "$BIN" ] && [ -f "$BIN" ] || { echo "FAIL: engine binary not produced"; exit 1; }
codesign --force -s - "$BIN" 2>/dev/null || true
echo "engine binary: $BIN"

# Install the engine binary at the repo-local runtime path the app resolves as `fabula`
# (via `command -v fabula`). Keeps the running engine inside this repo — nothing external.
mkdir -p "$ROOT/bin"
cp -f "$BIN" "$ROOT/bin/fabula"
codesign --force -s - "$ROOT/bin/fabula" 2>/dev/null || true
echo "engine installed in-repo: $ROOT/bin/fabula"

echo "== [3/3] native macOS app =="
cd "$ROOT"
FABULA_ENGINE="$ROOT/bin/fabula" bash app/build.sh

echo "FABULA build complete. Engine: $ROOT/bin/fabula"
