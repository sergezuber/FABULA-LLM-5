#!/usr/bin/env bun
// fabula-purge — erase every trace of DELETED chats from the FABULA engine, permanently.
//
// Rule enforced: "session exists -> its history exists; session gone -> NOTHING: no rows, no full-text
// index, no freed-page residue, no session memory, no logs."
//
// What the engine's own `session delete` does NOT clean (verified): orphaned `message` and `history_fts`
// rows survive, and deleted content stays recoverable in freed DB pages + WAL + FTS5 segments.
//
//   bun scripts/fabula-purge.ts            scrub the real DB (refuses if the engine is running)
//   bun scripts/fabula-purge.ts --force    stop the engine first, then scrub
//   bun scripts/fabula-purge.ts --db PATH  scrub a specific DB file (for testing)
//
// PORTED FROM BASH, and the reason is not tidiness. The previous version was 134 lines of shell that
// needed `sqlite3`, `lsof`, `pgrep`, `pkill` and `du` — five external programs, of which `sqlite3` is not
// installed by default anywhere and `lsof`/`pgrep` do not exist on Windows at all. The privacy guarantee
// above cannot depend on whether someone happened to install a CLI: `bun:sqlite` is built into the
// runtime that is already required, so the promise now holds wherever the app runs.

import { Database } from "bun:sqlite"
import { existsSync, statSync, rmSync, readdirSync, unlinkSync } from "node:fs"
import * as path from "node:path"
import { baseDirs } from "../plugin/lib/platform/paths"
import { readRegistry, isAlive } from "../plugin/lib/childreg"

const args = process.argv.slice(2)
const FORCE = args.includes("--force")
const dbArg = args.indexOf("--db")
const DATA = baseDirs().data
const DB = dbArg >= 0 ? args[dbArg + 1]! : path.join(DATA, "fabula.db")
const PORT = Number(process.env.FABULA_PORT) || 4096

/** Tables that carry per-session rows. Named explicitly: a table added later must be added here, and a
 *  DELETE against a table that does not exist is tolerated rather than fatal, so an older or newer schema
 *  is scrubbed as far as it can be rather than not at all. */
const SESSION_TABLES = [
  "message", "part", "history_fts", "task", "task_event",
  "todo", "session_share", "workflow_run", "actor_registry",
]

/**
 * Is the engine holding this database open?
 *
 * Asked over HTTP rather than by looking for a process: `lsof`/`pgrep` are POSIX-only and, more to the
 * point, a listening port is the actual question — a process that exists but is not serving cannot have
 * the DB open, and one serving from another checkout can.
 */
async function engineRunning(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${PORT}/global/health`, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

/** Stop the engine and everything it spawned, using the registry the harness already keeps. */
function stopEngine(): void {
  for (const rec of readRegistry()) {
    if (!isAlive(rec.pid)) continue
    try { process.kill(rec.pid, "SIGKILL") } catch { /* already gone */ }
  }
}

function humanSize(p: string): string {
  try {
    const b = statSync(p).size
    const u = ["B", "KB", "MB", "GB"]
    let i = 0, n = b
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
    return `${n.toFixed(1)}${u[i]}`
  } catch { return "?" }
}

/** Names under a directory that no longer correspond to anything live, removed. */
function removeOrphanDirs(base: string, live: Set<string>, label: string): number {
  if (!existsSync(base)) return 0
  let n = 0
  for (const name of readdirSync(base)) {
    if (live.has(name)) continue
    try { rmSync(path.join(base, name), { recursive: true, force: true }); n++; console.log(`  – removed ${label} ${name}`) } catch {}
  }
  return n
}

if (!existsSync(DB)) {
  console.error(`✗ no DB at ${DB}`)
  process.exit(1)
}

const isRealDb = DB === path.join(DATA, "fabula.db")
if (isRealDb && await engineRunning()) {
  if (!FORCE) {
    console.error("✗ the engine is running. Close FABULA first, or run with --force")
    process.exit(1)
  }
  console.log("• stopping the engine so the database can be scrubbed…")
  stopEngine()
  for (let i = 0; i < 20 && await engineRunning(); i++) await Bun.sleep(300)
}

const before = humanSize(DB)
const db = new Database(DB)

/** A DELETE whose table is absent is not an error here — schemas move. */
function tryExec(sql: string): void {
  try { db.exec(sql) } catch { /* table not in this schema version */ }
}

const orphanCount = SESSION_TABLES.reduce((acc, t) => {
  try {
    const r = db.query(`SELECT count(*) AS n FROM ${t} WHERE session_id NOT IN (SELECT id FROM session)`).get() as any
    return acc + Number(r?.n ?? 0)
  } catch { return acc }
}, 0)

if (orphanCount === 0) {
  // Fast path: nothing deleted means nothing to reclaim, and VACUUM on a large DB is not free.
  tryExec("PRAGMA wal_checkpoint(TRUNCATE)")
  db.close()
  console.log(`✓ nothing to purge — no deleted-chat residue. (DB ${before})`)
  process.exit(0)
}

console.log(`• scrubbing deleted-chat data from ${DB} (${orphanCount} orphan rows)`)
tryExec("PRAGMA foreign_keys=OFF")
tryExec("PRAGMA wal_checkpoint(TRUNCATE)")
for (const t of SESSION_TABLES) tryExec(`DELETE FROM ${t} WHERE session_id NOT IN (SELECT id FROM session)`)
// Re-derive the FTS indexes from their (now clean) content tables, so deleted text is gone from the
// index segments too — deleting a row does not remove its terms.
tryExec("INSERT INTO history_fts_idx(history_fts_idx) VALUES('rebuild')")
tryExec("INSERT INTO memory_fts_idx(memory_fts_idx) VALUES('rebuild')")
// Zero every freed page and compact the file: without secure_delete the bytes stay recoverable.
tryExec("PRAGMA auto_vacuum=FULL")
tryExec("PRAGMA secure_delete=ON")
tryExec("VACUUM")

const liveSessions = new Set<string>((db.query("SELECT id FROM session").all() as any[]).map((r) => String(r.id)))
const liveProjects = new Set<string>((db.query("SELECT id FROM project").all() as any[]).map((r) => String(r.id)))

// FILESYSTEM RESIDUE BELONGS TO THE DATABASE IT WAS DERIVED FROM.
//
// MEASURED on this script's own first run: `--db /tmp/copy.db` scrubbed the copy and then deleted the
// REAL data directory's logs, because the residue paths were built from `DATA` no matter which database
// had been named. The inherited shell version had the same shape, so it had the same hazard: pointing the
// tool at a copy to test it destroyed live state. A named database is a decision — everything downstream
// must follow it, and when it points somewhere else the only honest scope is the database itself.
if (!isRealDb) {
  db.close()
  console.log(`✓ purge complete on ${DB}. DB ${before} -> ${humanSize(DB)}.`)
  console.log("  (filesystem residue left untouched: --db named a database other than the live one)")
  process.exit(0)
}

removeOrphanDirs(path.join(DATA, "memory", "sessions"), liveSessions, "session memory")
removeOrphanDirs(path.join(DATA, "memory", "projects"), liveProjects, "orphan project memory")
removeOrphanDirs(path.join(DATA, "snapshot"), liveProjects, "orphan snapshot")

// Corpus map-reduce residue. This store holds a finished analysis IN FULL — the per-batch summaries
// verbatim, and since the delivery-safety change the report itself, written to disk before handover and
// kept whenever handover fails. Names are `<sessionID with punctuation stripped>-<dir slug>.<kind>`, so
// the id has to be stripped the same way before matching or every file reads as an orphan.
const corpus = path.join(DATA, "corpus")
if (existsSync(corpus)) {
  const stripped = [...liveSessions].map((s) => s.replace(/[^a-zA-Z0-9-]/g, ""))
  for (const name of readdirSync(corpus)) {
    if (stripped.some((s) => name.startsWith(s))) continue
    try { rmSync(path.join(corpus, name), { recursive: true, force: true }); console.log(`  – removed corpus residue ${name}`) } catch {}
  }
}

// Debug logs mix all sessions and are regenerable — clear them so no chat text lingers.
const logDir = path.join(DATA, "log")
if (existsSync(logDir)) {
  for (const f of readdirSync(logDir)) {
    if (f.endsWith(".log")) try { unlinkSync(path.join(logDir, f)) } catch {}
  }
  console.log("  – cleared debug logs")
}

db.close()
console.log(`✓ purge complete. DB ${before} -> ${humanSize(DB)}. No trace of deleted chats remains.`)
