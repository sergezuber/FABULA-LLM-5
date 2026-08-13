#!/bin/bash
# FABULA-LLM-5 — setup. Clone → ./setup.sh → open the app. Re-run any time; every step is idempotent.
#
# IT ASKS NOTHING. That is the whole design of this script, and it was learned the hard way: the version
# before it opened with "Where will your model come from?" and three paragraphs about localhost adapters,
# OpenAI-compatible endpoints and model ids. To answer the first question you had to already understand
# the architecture — so a person who simply wanted the application installed was made to sit an exam,
# and said so. Explaining everything IS the complexity, not the cure for it.
#
# So the default installs what FABULA cannot run without (four npm packages, git, the engine, the
# localhost adapter) and stops. Nothing large arrives unasked — no browser, no Docker, no speech models,
# no Go toolchain. Choosing a model happens IN THE APPLICATION, which has a screen for it.
#
#   ./setup.sh                        # install and finish — no questions
#   ./setup.sh --ask                  # walk me through the optional extras
#   ./setup.sh --with=browser,voice   # add named capabilities
#   ./setup.sh --all                  # everything
#   ./setup.sh --minimal              # skip even the adapter
#   ./setup.sh --deps                 # dependencies only, skip the engine/app build
#   ./setup.sh --help                 # this list
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

IS_MAC=""
[ "$(uname -s 2>/dev/null)" = "Darwin" ] && IS_MAC=1

BUILD_APP=1
MODE="default"
GROUPS=""
SHOW_HELP=""
for a in "$@"; do
  case "$a" in
    --ask)      MODE="ask" ;;
    --all)      MODE="all" ;;
    --minimal)  MODE="minimal" ;;
    --with=*)   MODE="named"; GROUPS="${a#--with=}" ;;
    --deps)     BUILD_APP=0 ;;
    --help|-h)  SHOW_HELP=1 ;;
  esac
done
# A prompt nobody can answer is a hang. Without a terminal --ask degrades to the silent default.
[ -t 0 ] || { [ "$MODE" = "ask" ] && MODE="default"; }

say()  { printf '%s\n' "$1"; }
bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

ask_yn() { # question, default(y/n) → 0 = yes
  local q="$1" def="$2" ans hint
  [ "$def" = "y" ] && hint="[Y/n]" || hint="[y/N]"
  printf '\033[1m%s\033[0m %s ' "$q" "$hint"
  read -r ans || ans=""
  ans="${ans:-$def}"
  case "$ans" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

if [ -n "$SHOW_HELP" ]; then
  say ""
  bold "FABULA-LLM-5 setup"
  say ""
  say "  ./setup.sh                        install and finish — asks nothing"
  say "  ./setup.sh --ask                  walk me through the optional extras"
  say "  ./setup.sh --with=browser,voice   add named capabilities"
  say "  ./setup.sh --all                  everything"
  say "  ./setup.sh --minimal              core only, without the localhost adapter"
  say "  ./setup.sh --deps                 dependencies only, skip the engine/app build"
  say ""
  dim  "  Capabilities: browser, search, sandbox, voice, go"
  dim  "  Your fabula.config.json and .env are never overwritten."
  say ""
  exit 0
fi

say ""
bold "FABULA-LLM-5 setup"
dim  "Nothing to decide. This installs what FABULA needs to run and stops; you choose a model in the app."
say ""

# ── 0. Runtime ────────────────────────────────────────────────────────────────
bold "▸ Runtime (bun)"
if ! command -v bun >/dev/null 2>&1; then
  dim "  installing bun…"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 || { say "✗ bun is required and could not be installed — see https://bun.sh"; exit 1; }
dim "  ok"

# ── 1. What do you want? ──────────────────────────────────────────────────────
# Where the model comes from is asked ONLY under --ask. The silent default installs the adapter,
# because it is ours, small, and inert until a local model runs — and because the alternative is asking
# a question whose answer most people cannot know before they have opened the application once.
MODEL_SOURCE="local"
[ "$MODE" = "minimal" ] && MODEL_SOURCE="later"
if [ "$MODE" = "ask" ]; then
  say ""
  bold "▸ Where will your model come from?"
  # The options come from plugin/lib/setupgroups.ts, like the capability questions below: writing them
  # out here as well is how a script and its module start telling people different things.
  SRC_IDS=""
  n=0
  while IFS='|' read -r sid slabel sdetail; do
    [ -z "$sid" ] && continue
    n=$((n + 1))
    say "   $n) $slabel"
    dim "      $sdetail"
    SRC_IDS="${SRC_IDS:+$SRC_IDS }$sid"
  done <<EOF
$(bun -e '
  import { MODEL_SOURCES } from "./plugin/lib/setupgroups"
  for (const m of MODEL_SOURCES) console.log([m.id, m.label, m.detail].join("|"))
' 2>/dev/null)
EOF
  if [ "$n" -gt 0 ]; then
    printf '\033[1m   Choose 1-%s\033[0m [1] ' "$n"
    read -r pick || pick=""
    case "${pick:-1}" in ''[!0-9]''*|'') pick=1 ;; esac
    [ "$pick" -ge 1 ] 2>/dev/null && [ "$pick" -le "$n" ] || pick=1
    MODEL_SOURCE="$(echo "$SRC_IDS" | cut -d' ' -f"$pick")"
  else
    say "   (could not read the options — assuming a model on this machine)"
    MODEL_SOURCE="local"
  fi

  say ""
  bold "▸ Optional capabilities"
  dim  "  Say no to anything you are unsure about — each can be added later, from chat or by re-running setup."
  say ""
  # The questions, their prices and their reasons live in plugin/lib/setupgroups.ts — one definition,
  # so this script, the installer and the docs cannot disagree about what is mandatory.
  while IFS='|' read -r gid gq gcost gskip gdef; do
    [ -z "$gid" ] && continue
    say ""
    say "  $gq"
    dim  "  costs: $gcost"
    dim  "  skip it if: $gskip"
    if ask_yn "  install it?" "$gdef"; then GROUPS="${GROUPS:+$GROUPS,}$gid"; fi
  done <<EOF
$(bun -e '
  import { SETUP_GROUPS } from "./plugin/lib/setupgroups"
  for (const g of SETUP_GROUPS)
    console.log([g.id, g.question, g.cost, g.skipIf, g.recommended ? "y" : "n"].join("|"))
' 2>/dev/null)
EOF
  say ""
elif [ "$MODE" = "minimal" ]; then
  say ""
  dim "▸ Core only (--minimal)."
elif [ "$MODE" = "named" ]; then
  say ""
  dim "▸ Core + ${GROUPS} (--with)."
fi

# ── 2. Dependencies ───────────────────────────────────────────────────────────
say ""
bold "▸ Dependencies"
( cd plugin && bun install )
if [ "$MODE" = "all" ]; then
  bun scripts/install-deps.ts --all || say "  (some installs failed — see above; re-runnable any time)"
else
  bun scripts/install-deps.ts --groups="$GROUPS" || say "  (some installs failed — see above; re-runnable any time)"
fi

# ── 3. Engine and app ─────────────────────────────────────────────────────────
if [ "$BUILD_APP" = "1" ]; then
  say ""
  bold "▸ Engine${IS_MAC:+ + macOS app}"
  # THE ARTIFACT, NOT ITS PRESENCE. This used to be `[ -x bin/fabula ] || ./build.sh`, so a re-run on an
  # existing clone found the binary already there and skipped the build entirely — while the README, in
  # all three languages, tells people to re-run setup after a `git pull`, which is exactly when a rebuild
  # is the whole point. Someone following the documented path got a successful-looking run and kept
  # running the old engine. Same trap RULE #20 exists for: a timestamp says a file is there, only the
  # version inside says the artifact CARRIES the change.
  #
  # The version is read the way `verify-deploy.sh` reads it, from the one source that declares it. If it
  # cannot be read, we build — an unnecessary build costs minutes, a skipped one costs a wrong answer.
  DECLARED="$(bun -e 'import {FABULA_VERSION} from "./engine/packages/app/src/data/fabula-changelog"; console.log(FABULA_VERSION)' 2>/dev/null || true)"
  if [ -x bin/fabula ] && [ -n "$DECLARED" ] && grep -qaF "\"$DECLARED\"" bin/fabula 2>/dev/null; then
    dim "  engine already carries $DECLARED — nothing to build"
  else
    [ -n "$DECLARED" ] && dim "  building $DECLARED (the installed engine does not carry it)"
    ./build.sh
  fi
  if [ -n "$IS_MAC" ]; then
    # app/build.sh is what stamps the version into Info.plist, so the bundle is rebuilt on the same
    # condition rather than on whether the directory happens to exist.
    if [ -d FABULA-LLM-5.app ] && [ -n "$DECLARED" ] &&
       [ "$(defaults read "$HERE/FABULA-LLM-5.app/Contents/Info" CFBundleShortVersionString 2>/dev/null)" = "$DECLARED" ]; then
      dim "  app bundle already carries $DECLARED"
    else
      bash app/build.sh
    fi
  else
    dim "  no native window on this platform yet — the engine serves its own UI in the browser"
  fi
else
  say ""
  dim "▸ Skipped engine/app build (--deps)."
fi

# ── 4. Config ─────────────────────────────────────────────────────────────────
say ""
bold "▸ Config"
[ -f fabula.config.json ] || cp fabula.config.example.json fabula.config.json
[ -f .env ] || cp .env.example .env
mkdir -p "$HERE/.fabula"
CFG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}"
mkdir -p "$CFG_ROOT"
[ -e "$CFG_ROOT/fabula" ] || [ -L "$CFG_ROOT/fabula" ] || ln -s "$HERE" "$CFG_ROOT/fabula"
dim "  fabula.config.json and .env are yours — setup never overwrites them"

# The `fabula` command: ALWAYS prefer the repo-local engine built above. An unrelated engine binary
# already on PATH (found via `command -v mimo`) must NOT win — the app would then serve a foreign
# engine's UI and config inside the FABULA window (a real hijack seen on a machine with a pre-existing
# MiMoCode install). The PATH engine is only the fallback when the repo binary is absent (a --deps
# run). An existing `fabula` exec-SHIM is repointed; a real `fabula` binary on PATH is left alone.
ENGINE_REAL=""
[ -x "$HERE/bin/fabula" ] && ENGINE_REAL="$HERE/bin/fabula"
[ -n "$ENGINE_REAL" ] || ENGINE_REAL="$(command -v mimo || true)"
if [ -n "$ENGINE_REAL" ]; then
  EXISTING="$(command -v fabula || true)"
  if [ -n "$EXISTING" ] && head -n 2 "$EXISTING" 2>/dev/null | grep -q '^exec "'; then
    printf '#!/bin/sh\nexec "%s" "$@"\n' "$ENGINE_REAL" > "$EXISTING"
    chmod +x "$EXISTING"
    dim "  engine command repointed: $EXISTING → $ENGINE_REAL"
  elif [ -z "$EXISTING" ]; then
    if [ -n "$IS_MAC" ]; then SHIM_DIRS="/opt/homebrew/bin /usr/local/bin $HOME/.local/bin"
    else SHIM_DIRS="$HOME/.local/bin /usr/local/bin"; fi
    for BIN_DIR in $SHIM_DIRS; do
      mkdir -p "$BIN_DIR" 2>/dev/null || true
      if [ -d "$BIN_DIR" ] && [ -w "$BIN_DIR" ]; then
        printf '#!/bin/sh\nexec "%s" "$@"\n' "$ENGINE_REAL" > "$BIN_DIR/fabula"
        chmod +x "$BIN_DIR/fabula"
        dim "  installed the 'fabula' command → $BIN_DIR/fabula"
        break
      fi
    done
  fi
fi

# ── 5. Local-model adapter — only if a local model is the plan ────────────────
# WHICH service manager promises "start this with my session" is the platform's answer, not this
# script's: a LaunchAgent, a systemd user service, or a Task Scheduler logon task. The installer holds
# all three and refuses to touch a live adapter — if ANYTHING answers on :1235, even a 502 while the
# serving runtime is off, an instance owns that port and replacing it would lose somebody's turn.
if [ "$MODEL_SOURCE" = "local" ] || [ "$MODE" = "all" ]; then
  say ""
  bold "▸ Local-model adapter (:1235)"
  bun scripts/install-adapter-service.ts || dim "  (not installed — run: bun scripts/install-adapter-service.ts --status)"
else
  say ""
  dim "▸ Local-model adapter: skipped — it is only needed for a model running on this machine."
  dim "  Changed your mind? bun scripts/install-adapter-service.ts"
fi

# ── Done: say what happens next, for the answer this person actually gave ─────
say ""
bold "✓ Setup complete"
say ""
say "  1. Start FABULA:"
if [ -n "$IS_MAC" ]; then
  say "       open FABULA-LLM-5.app"
else
  say "       bin/fabula serve --port 4096   then open http://127.0.0.1:4096"
fi
say "  2. Add a model — whichever you have:"
dim  "       on this machine — open LM Studio, load a tool-calling model, start its server"
dim  "       an endpoint of your own — in the app: Manage models → Custom provider"
say ""
dim "  More capabilities (browser, web search, container, speech, Go):  ./setup.sh --ask"
dim "  What is installed:  bun scripts/install-deps.ts --list"
