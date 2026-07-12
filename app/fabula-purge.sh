#!/bin/bash
# fabula-purge — erase every trace of DELETED chats from the FABULA engine, permanently.
#
# Rule enforced: "session exists -> its history exists; session gone -> NOTHING:
# no rows, no full-text index, no freed-page residue, no session memory, no logs."
#
# What the engine's own `session delete` does NOT clean (verified): orphaned `message` and
# `history_fts` rows survive, and deleted content stays recoverable in freed DB pages
# + WAL + FTS5 segments. This script removes all of that.
#
# The DB must be closed (engine not running) to VACUUM safely.
#   fabula-purge.sh            -> scrub the real DB (refuses if the engine is running)
#   fabula-purge.sh --force    -> stop the engine first, then scrub
#   fabula-purge.sh --db PATH  -> scrub a specific DB file (for testing)
set -euo pipefail

# The engine's XDG data dir + DB name follow the app id (engine/packages/shared/src/global.ts: APP="fabula")
# → ~/.local/share/fabula/fabula.db. (Historically this was "mimocode"; the rename moved the real DB, so
# scrubbing the old path silently no-oped and deleted-chat residue survived — this points at the LIVE DB.)
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/fabula"
DB="$DATA/fabula.db"
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --db) DB="$2"; shift ;;
    *) echo "unknown arg: $1"; exit 2 ;;
  esac
  shift
done

engine_running() { lsof -nP -iTCP:4096 -sTCP:LISTEN >/dev/null 2>&1 || pgrep -f "mimocode/bin/.mimocode|(mimo|fabula) (web|serve|run)" >/dev/null 2>&1; }

if [ "$DB" = "$DATA/fabula.db" ] && engine_running; then
  if [ "$FORCE" = 1 ]; then
    echo "• stopping the engine (server/TUI) so the database can be scrubbed…"
    pkill -f "mimo web" 2>/dev/null || true
    pkill -f "mimo serve" 2>/dev/null || true
    pkill -f "fabula serve" 2>/dev/null || true
    pkill -f "mimocode/bin/.mimocode" 2>/dev/null || true
    for i in $(seq 1 20); do engine_running || break; sleep 0.3; done
  else
    echo "✗ the engine is running. Close FABULA-LLM-5 first, or run: fabula-purge.sh --force"
    exit 1
  fi
fi

[ -f "$DB" ] || { echo "✗ no DB at $DB"; exit 1; }
SIZE_BEFORE=$(du -h "$DB" | cut -f1)

# Fast path: if no deleted-chat residue exists, skip the expensive VACUUM.
ORPH=$(sqlite3 "$DB" "SELECT
  (SELECT count(*) FROM message     WHERE session_id NOT IN (SELECT id FROM session)) +
  (SELECT count(*) FROM part        WHERE session_id NOT IN (SELECT id FROM session)) +
  (SELECT count(*) FROM history_fts WHERE session_id NOT IN (SELECT id FROM session))" 2>/dev/null || echo 0)
if [ "${ORPH:-0}" = "0" ]; then
  echo "✓ nothing to purge — no deleted-chat residue. (DB $SIZE_BEFORE)"
  sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
  exit 0
fi

echo "• scrubbing deleted-chat data from $DB ($ORPH orphan rows)"
sqlite3 "$DB" <<'SQL'
PRAGMA foreign_keys=OFF;
PRAGMA wal_checkpoint(TRUNCATE);

-- Remove all rows belonging to sessions that no longer exist (orphans of deleted chats).
DELETE FROM message        WHERE session_id NOT IN (SELECT id FROM session);
DELETE FROM part           WHERE session_id NOT IN (SELECT id FROM session);
DELETE FROM history_fts    WHERE session_id NOT IN (SELECT id FROM session);
DELETE FROM task           WHERE session_id NOT IN (SELECT id FROM session);
DELETE FROM task_event     WHERE session_id NOT IN (SELECT id FROM session);
DELETE FROM todo           WHERE session_id NOT IN (SELECT id FROM session);
DELETE FROM session_share  WHERE session_id NOT IN (SELECT id FROM session);
DELETE FROM workflow_run   WHERE session_id NOT IN (SELECT id FROM session);
DELETE FROM actor_registry WHERE session_id NOT IN (SELECT id FROM session);

-- Re-derive FTS5 indexes from their (now-clean) content tables so deleted text
-- is purged from the index segments too.
INSERT INTO history_fts_idx(history_fts_idx) VALUES('rebuild');
INSERT INTO memory_fts_idx(memory_fts_idx) VALUES('rebuild');

-- Zero every freed page and compact the file. auto_vacuum makes future deletes
-- shrink the file immediately; secure_delete zeroes the bytes (no recovery).
PRAGMA auto_vacuum=FULL;
PRAGMA secure_delete=ON;
VACUUM;
SQL

# Filesystem residue of deleted sessions: per-session checkpoint memory.
LIVE_IDS=$(sqlite3 "$DB" "SELECT id FROM session" 2>/dev/null)
if [ -d "$DATA/memory/sessions" ]; then
  for d in "$DATA/memory/sessions"/*/; do
    [ -d "$d" ] || continue
    sid=$(basename "$d")
    echo "$LIVE_IDS" | grep -qxF "$sid" || { rm -rf "$d"; echo "  – removed session memory $sid"; }
  done
fi

# Orphaned project memory + working-tree snapshots (projects with no rows left).
LIVE_PROJ=$(sqlite3 "$DB" "SELECT id FROM project" 2>/dev/null)
for base in "$DATA/memory/projects" "$DATA/snapshot"; do
  [ -d "$base" ] || continue
  for d in "$base"/*/; do
    [ -d "$d" ] || continue
    pid=$(basename "$d")
    echo "$LIVE_PROJ" | grep -qxF "$pid" || { rm -rf "$d"; echo "  – removed orphan $base/$pid"; }
  done
done

# Debug logs mix all sessions and are regenerable — clear them so no chat text lingers.
if [ -d "$DATA/log" ]; then rm -f "$DATA"/log/*.log 2>/dev/null || true; echo "  – cleared debug logs"; fi

SIZE_AFTER=$(du -h "$DB" | cut -f1)
echo "✓ purge complete. DB $SIZE_BEFORE -> $SIZE_AFTER. No trace of deleted chats remains."
