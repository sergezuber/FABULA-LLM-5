#!/bin/bash
# Restart the app WITHOUT killing the user's work.
#
# Paid for twice on 2026-07-25: a deploy quit the app while a 29-minute book-analysis turn was mid-flight.
# The user saw "Interrupted" and lost the run. The deploy had no idea a turn was in flight, because
# nothing looked. This script is the looking: it refuses to quit while any session is generating, waits
# for quiet (up to a deadline), and only then restarts. A deploy is never worth a user's running turn —
# if quiet never comes, it EXITS NONZERO and the caller decides, rather than killing the work silently.
#
# Usage: bash scripts/safe-restart.sh [max_wait_seconds]   (default 3600)

set -u
MAX_WAIT="${1:-3600}"
PORT="${FABULA_PORT:-4096}"
WAITED=0

busy_count() {
  # The engine's status endpoint knows which sessions are generating; a dead engine means nothing to kill.
  curl -s --max-time 3 "http://127.0.0.1:${PORT}/global/fabula/sessions" >/dev/null 2>&1 || { echo 0; return; }
  # Count assistant messages updated in the last 45s — a generating turn touches its row continuously.
  sqlite3 "$HOME/.local/share/fabula/fabula.db" \
    "SELECT count(DISTINCT session_id) FROM message WHERE time_updated > (strftime('%s','now')-45)*1000;" 2>/dev/null || echo 0
}

while true; do
  N=$(busy_count)
  if [ "${N:-0}" -eq 0 ]; then
    echo "quiet — restarting"
    osascript -e 'tell application "FABULA-LLM-5" to quit' 2>/dev/null
    sleep 4
    pkill -f 'MacOS/FABULA-LLM-5' 2>/dev/null
    pkill -f 'bin/fabula serve' 2>/dev/null
    sleep 2
    exit 0
  fi
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    echo "REFUSED: ${N} session(s) still working after ${WAITED}s — not killing the user's run" >&2
    exit 1
  fi
  echo "waiting: ${N} session(s) working (${WAITED}s)"
  sleep 15
  WAITED=$((WAITED + 15))
done
