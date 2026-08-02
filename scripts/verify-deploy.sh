#!/usr/bin/env bash
# Is the engine binary the app actually runs BUILT FROM the engine source in this tree?
#
# Why this exists: a wave was developed, tested, documented, committed and declared done while the
# deployed binary predated its own fix by two hours. Every check that wave ran — unit tests, the frozen
# acceptance suite, two independent verifier passes, a one-command replay — read the SOURCE. Not one of
# them looked at the artifact that starts when the user opens the app, so none of them could have caught
# it. A green suite over stale bytes is a green suite about nothing.
#
# Run it after any engine change, and before believing a wave is shipped:
#     bash scripts/verify-deploy.sh
#
# Freshness is also checked by NUMBER, not only by timestamp and content: FABULA_VERSION from
# engine/packages/app/src/data/fabula-changelog.ts must sit inside all three shipped artifacts —
# the built frontend bundle, the bytes of bin/fabula, and the app bundle's Info.plist. A binary
# built five minutes ago from some OTHER checkout is newer than every source file and carries every
# marker; the version string is the one thing it cannot fake.
#
# An optional argument points the same checks at another checkout of this repo:
#     bash scripts/verify-deploy.sh /path/to/tree
set -u
if [ -n "${1:-}" ]; then ROOT="$(cd "$1" && pwd)" || exit 2; else ROOT="$(cd "$(dirname "$0")/.." && pwd)"; fi
BIN="$ROOT/bin/fabula"
SRC="$ROOT/engine/packages/opencode/src"
fail=0
say() { printf '%s\n' "$1"; }
bad() { printf '   ❌ %s\n' "$1"; fail=1; }
ok()  { printf '   ✅ %s\n' "$1"; }

say "── the binary exists and runs"
if [ ! -x "$BIN" ]; then
  bad "no executable at bin/fabula — the app has nothing to run"
  echo; echo "DEPLOY: STALE"; exit 1
fi
VER="$("$BIN" --version 2>/dev/null | tr -d '\n')"
[ -n "$VER" ] && ok "bin/fabula runs (version $VER)" || bad "bin/fabula did not answer --version"

say "── the shim the app resolves points at it"
# Every `fabula` on PATH, not just the first: a stale one further along still shadows the right one
# whenever PATH is ordered differently (a terminal and the app do not share a PATH).
FOUND=0; SHADOW=0
IFS=: read -r -a _paths <<< "$PATH"
for d in "${_paths[@]}"; do
  c="$d/fabula"
  [ -x "$c" ] || continue
  FOUND=$((FOUND + 1))
  if grep -q "$BIN" "$c" 2>/dev/null; then
    ok "$c execs the repo-local binary"
  elif [ "$c" = "$BIN" ]; then
    ok "$c IS the repo-local binary"
  else
    bad "$c is a DIFFERENT engine (not a shim to $BIN) — whoever finds it first runs week-old code"
    SHADOW=$((SHADOW + 1))
  fi
done
[ "$FOUND" -eq 0 ] && say "   (no 'fabula' on PATH; the app falls back to its own resolution)"

say "── no engine source is newer than the binary"
# The general check: if ANY source file postdates the build, the binary cannot contain it. This catches
# every future wave that edits the engine and forgets to rebuild, without naming a single symbol.
NEWER="$(find "$SRC" -type f \( -name '*.ts' -o -name '*.txt' -o -name '*.json' \) -newer "$BIN" 2>/dev/null | head -5)"
if [ -n "$NEWER" ]; then
  bad "engine source is NEWER than the deployed binary — the app is running code you have not built:"
  printf '        %s\n' $NEWER
  COUNT="$(find "$SRC" -type f -name '*.ts' -newer "$BIN" 2>/dev/null | wc -l | tr -d ' ')"
  [ "$COUNT" -gt 5 ] && printf '        …and %s more\n' "$((COUNT - 5))"
else
  ok "every engine source file predates the build"
fi

say "── the shipped gate mechanisms are present IN THE BINARY (not just in source)"
# Named markers, checked by content rather than by timestamp: minification renames symbols, so each
# marker below was chosen because it survives the bundler (a string literal, or a name that is exported).
check_marker() {
  local needle="$1" what="$2"
  if strings -a "$BIN" 2>/dev/null | grep -qF "$needle"; then ok "$what"; else bad "$what — MISSING from the binary"; fi
}
check_marker "gateTurnStep"                    "W4 · the task-gate turn policy"
check_marker "task gate hit cap; allowing stop" "W4 · the cap branch"
# NB every marker MUST be a string literal: the bundler minifies symbol names, so a function name is
# not evidence of anything. `trajectoryFeatures` was the first marker tried here and it reported W3
# missing from a binary that contains it — the guard's own false alarm, kept as a comment so the next
# person does not repeat it.
check_marker "no green verify has passed since" "W3 · the judge hard-veto wording"
check_marker "verify_done"                     "the verify gate"
check_marker "FABULA_CHANNEL_MAX_SESSIONS"     "W6 · the bounded shadow channel"
check_marker "modeOrigin"                      "W6 · the permission-mode origin stamp"
# W7 markers are literals copied VERBATIM out of the prompt files. Copying is not pedantry: probing this
# same binary with a plausible-sounding "archive notes.md" reported the change MISSING from a binary that
# contains it, because the real sentence reads differently. A marker written from memory tests the memory.
check_marker "notes-archive.md"                "W7 · the raw notes are archived before the reset"
check_marker "## Superseded"                   "W7 · dream retires rather than deletes"
# W8, verbatim again — probing this same binary with invented phrases ("not checkable here", "reproduce
# probe") reported MISSING twice from a binary that carries the real ones. Those two live in PLUGIN files,
# which never enter this binary at all; only the engine-side strings belong here.
check_marker "asserted by the receipt"         "W8 · the CLI names what it did not check"
check_marker "FABULA_RECHECK"                  "W8 · the wave switch"

say "── every artifact carries the version the source declares"
# One declaration, three carriers. FABULA_VERSION in the changelog source is the number the user is
# told they run; the frontend bakes it into dist, the engine binary embeds that dist, app/build.sh
# stamps it into Info.plist. Timestamps and markers cannot tell a fresh build of THIS tree from a
# fresh build of another one — the version string can, so each artifact answers for itself here,
# and a mismatch names the version the artifact actually carries, not just "stale".
CHANGELOG_TS="$ROOT/engine/packages/app/src/data/fabula-changelog.ts"
SRC_VER="$(sed -n 's/^export const FABULA_VERSION = "\(.*\)"$/\1/p' "$CHANGELOG_TS" 2>/dev/null | head -1)"
# What a JS payload ACTUALLY carries: the newest changelog entry survives minification verbatim as
# `version:"X",date` — read X from stdin so the same probe serves the dist file and the binary.
carried() { grep -oE 'version:"[0-9][0-9.]*",date' 2>/dev/null | head -1 | cut -d'"' -f2; }
if [ -z "$SRC_VER" ]; then
  bad "no FABULA_VERSION in engine/packages/app/src/data/fabula-changelog.ts — nothing to hold the artifacts to"
else
  DIST_JS="$(ls -t "$ROOT"/engine/packages/app/dist/assets/index-*.js 2>/dev/null | head -1)"
  if [ -z "$DIST_JS" ]; then
    bad "frontend dist has no assets/index-*.js — the frontend was never built (source declares $SRC_VER)"
  elif grep -qF "\"$SRC_VER\"" "$DIST_JS" 2>/dev/null; then
    ok "frontend dist carries $SRC_VER (${DIST_JS##*/})"
  else
    GOT="$(carried < "$DIST_JS")"
    bad "frontend dist carries ${GOT:-no recognizable version}, source declares $SRC_VER (${DIST_JS##*/})"
  fi
  if strings -a "$BIN" 2>/dev/null | grep -qF "\"$SRC_VER\""; then
    ok "engine binary carries $SRC_VER"
  else
    GOT="$(strings -a "$BIN" 2>/dev/null | carried)"
    bad "engine binary carries ${GOT:-no recognizable version}, source declares $SRC_VER"
  fi
  PLIST="$ROOT/FABULA-LLM-5.app/Contents/Info.plist"
  if [ ! -f "$PLIST" ]; then
    bad "app bundle has no Info.plist — the app was never built (source declares $SRC_VER)"
  else
    APP_VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST" 2>/dev/null)"
    [ -n "$APP_VER" ] || APP_VER="$(sed -n 's/.*CFBundleShortVersionString<\/key>[[:space:]]*<string>\([^<]*\)<\/string>.*/\1/p' "$PLIST" 2>/dev/null | head -1)"
    if [ "$APP_VER" = "$SRC_VER" ]; then
      ok "app bundle Info.plist carries $SRC_VER"
    else
      bad "app bundle Info.plist carries ${APP_VER:-no recognizable version}, source declares $SRC_VER"
    fi
  fi
fi

printf '\n'
if [ "$fail" -eq 0 ]; then echo "DEPLOY: FRESH — the app runs this tree's engine"; else echo "DEPLOY: STALE — rebuild with ./build.sh (or the engine step) before claiming a wave is shipped"; fi
exit "$fail"
