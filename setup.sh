#!/bin/bash
# FABULA-LLM-5 — one-shot setup: clone → ./setup.sh → open the app. Everything else lives in here.
# Re-run any time; every step is idempotent. Plugin deps come from plugin/lib/manifest.ts (source of truth).
#
#   ./setup.sh            # runtime + deps + engine build + app build + config
#   ./setup.sh --all      # also install OPTIONAL deps (Docker, faster-whisper, Chromium, …)
#   ./setup.sh --deps     # dependencies only, skip the engine/app build
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

# One platform question, asked once. Everything below branches on this rather than assuming a Mac.
IS_MAC=""
[ "$(uname -s 2>/dev/null)" = "Darwin" ] && IS_MAC=1

DEPS_ARGS=()
BUILD_APP=1
for a in "$@"; do
  case "$a" in
    --all) DEPS_ARGS+=("--all") ;;
    --deps) BUILD_APP=0 ;;
    *) DEPS_ARGS+=("$a") ;;
  esac
done

echo "▸ 0/5  Runtime (bun)…"
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || { echo "✗ bun is required and could not be installed — see https://bun.sh"; exit 1; }

echo "▸ 1/5  Plugin dependencies (bun install in plugin/)…"
( cd plugin && bun install )

echo "▸ 2/5  System dependencies (from the manifest)…"
bun scripts/install-deps.ts "${DEPS_ARGS[@]}" || echo "  (some optional deps were skipped — install later via setup.sh --all or the in-app install_plugin_deps tool)"

if [ "$BUILD_APP" = "1" ]; then
  echo "▸ 3/5  Engine${IS_MAC:+ + macOS app}…"
  # The engine binary is repo-local (bin/fabula, gitignored) — build it if it isn't there yet.
  [ -x bin/fabula ] || ./build.sh
  # The native shell exists on macOS only. Elsewhere the engine serves its own UI and the browser is
  # the window — a real product, and the thing to use until the cross-platform shell lands.
  if [ -n "$IS_MAC" ]; then
    [ -d FABULA-LLM-5.app ] || bash app/build.sh
  else
    echo "  no native shell on this platform yet — run: bin/fabula serve --port 4096 and open http://127.0.0.1:4096"
  fi
else
  echo "▸ 3/5  Skipped engine/app build (--deps)."
fi

echo "▸ 4/5  Config + engine command…"
# Personal config from the templates — never clobber an existing one (cp -n aborts under set -e on macOS).
[ -f fabula.config.json ] || cp fabula.config.example.json fabula.config.json
[ -f .env ] || cp .env.example .env
# Project config dir for the engine (MIMOCODE_CONFIG_DIR): nothing inside is tracked, so a fresh
# clone lacks it — an engine built before v0.1.4 dies at startup writing .fabula/.gitignore.
mkdir -p "$HERE/.fabula"
# The engine's config dir follows XDG, exactly as the engine resolves it — not a hardcoded ~/.config.
CFG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}"
mkdir -p "$CFG_ROOT"
[ -e "$CFG_ROOT/fabula" ] || [ -L "$CFG_ROOT/fabula" ] || ln -s "$HERE" "$CFG_ROOT/fabula"

# The `fabula` command: ALWAYS prefer the repo-local engine built above. An unrelated engine
# binary already on PATH (found via `command -v mimo`) must NOT win — the app would then serve
# a foreign engine's UI and config inside the FABULA window (a real hijack seen on a machine
# with a pre-existing MiMoCode install). The PATH engine is only the fallback when the repo
# binary is absent (a --deps run). An existing `fabula` exec-SHIM is repointed to the preferred
# engine; a real `fabula` binary on PATH is left alone.
ENGINE_REAL=""
[ -x "$HERE/bin/fabula" ] && ENGINE_REAL="$HERE/bin/fabula"
[ -n "$ENGINE_REAL" ] || ENGINE_REAL="$(command -v mimo || true)"
if [ -n "$ENGINE_REAL" ]; then
  EXISTING="$(command -v fabula || true)"
  if [ -n "$EXISTING" ] && head -n 2 "$EXISTING" 2>/dev/null | grep -q '^exec "'; then
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$ENGINE_REAL" > "$EXISTING"
    chmod +x "$EXISTING"
    echo "  engine command repointed: $EXISTING → $ENGINE_REAL"
  elif [ -z "$EXISTING" ]; then
    # ~/.local/bin first on Linux (no Homebrew there, and it needs no privilege); Homebrew first on macOS.
    if [ -n "$IS_MAC" ]; then SHIM_DIRS="/opt/homebrew/bin /usr/local/bin $HOME/.local/bin"
    else SHIM_DIRS="$HOME/.local/bin /usr/local/bin"; fi
    for BIN_DIR in $SHIM_DIRS; do
      mkdir -p "$BIN_DIR" 2>/dev/null || true
      if [ -d "$BIN_DIR" ] && [ -w "$BIN_DIR" ]; then
        printf '#!/bin/sh\nexec "%s" "$@"\n' "$ENGINE_REAL" > "$BIN_DIR/fabula"
        chmod +x "$BIN_DIR/fabula"
        echo "  installed the 'fabula' engine command → $BIN_DIR/fabula"
        break
      fi
    done
  fi
fi

echo "▸ 5/5  Local-model adapter (:1235)…"
# WHICH service manager promises "start this with my session" is the platform's answer, not this
# script's: a LaunchAgent, a systemd user service, or a Task Scheduler logon task. The installer holds
# all three and refuses to touch a live adapter — if ANYTHING answers on :1235, even a 502 while the
# serving runtime is off, an instance owns that port and replacing it would lose somebody's turn.
bun scripts/install-adapter-service.ts || echo "  (adapter service not installed — run it manually: bun scripts/install-adapter-service.ts --status)"

echo ""
if [ -n "$IS_MAC" ]; then
  echo "✓ Setup complete.  →  open FABULA-LLM-5.app"
else
  echo "✓ Setup complete.  →  bin/fabula serve --port 4096   then open http://127.0.0.1:4096"
fi
echo "  (Pick a model served by LM Studio, or add a cloud key in .env — the config is fabula.config.json.)"
echo "  Manage plugins any time from chat: list_plugins / enable_plugin / disable_plugin / install_plugin_deps."
