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
  echo "▸ 3/5  Engine + macOS app…"
  # The engine binary is repo-local (bin/fabula, gitignored) — build it if it isn't there yet.
  [ -x bin/fabula ] || ./build.sh
  [ -d FABULA-LLM-5.app ] || bash app/build.sh
else
  echo "▸ 3/5  Skipped engine/app build (--deps)."
fi

echo "▸ 4/5  Config + engine command…"
# Personal config from the templates — never clobber an existing one (cp -n aborts under set -e on macOS).
[ -f fabula.config.json ] || cp fabula.config.example.json fabula.config.json
[ -f .env ] || cp .env.example .env
mkdir -p "$HOME/.config"
[ -e "$HOME/.config/fabula" ] || [ -L "$HOME/.config/fabula" ] || ln -s "$HERE" "$HOME/.config/fabula"

# The `fabula` command: prefer an engine already on PATH (`command -v mimo`), else the repo-local binary we just built.
if ! command -v fabula >/dev/null 2>&1; then
  ENGINE_REAL="$(command -v mimo || true)"
  [ -n "$ENGINE_REAL" ] || { [ -x "$HERE/bin/fabula" ] && ENGINE_REAL="$HERE/bin/fabula"; }
  if [ -n "$ENGINE_REAL" ]; then
    for BIN_DIR in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
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
# Never touch a live adapter: if ANYTHING answers on :1235 (even a 502 while LM Studio is off),
# an adapter instance owns the port — a LaunchAgent or a manual run. Leave it alone.
if curl -s -o /dev/null -m 2 http://localhost:1235/v1/models 2>/dev/null; then
  echo "  adapter already running — left untouched."
elif [ -f "$HOME/Library/LaunchAgents/com.fabula.lmstudio-adapter.plist" ]; then
  echo "  LaunchAgent installed but not answering — start LM Studio, then: launchctl kickstart -k gui/$(id -u)/com.fabula.lmstudio-adapter"
else
  PLIST="$HOME/Library/LaunchAgents/com.fabula.lmstudio-adapter.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  PY="$(command -v python3 || echo /usr/bin/python3)"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.fabula.lmstudio-adapter</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$HERE/proxy/lmstudio-adapter.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PLIST_EOF
  launchctl load "$PLIST" 2>/dev/null || true
  echo "  adapter installed as a LaunchAgent (starts with your session)."
fi

echo ""
echo "✓ Setup complete.  →  open FABULA-LLM-5.app"
echo "  (Pick a model served by LM Studio, or add a cloud key in .env — the config is fabula.config.json.)"
echo "  Manage plugins any time from chat: list_plugins / enable_plugin / disable_plugin / install_plugin_deps."
