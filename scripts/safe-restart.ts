#!/usr/bin/env bun
// Restart the app WITHOUT killing the user's work.
//
// Paid for twice on 2026-07-25: a deploy quit the app while a 29-minute analysis was mid-flight. The user
// saw "Interrupted" and lost the run. The deploy had no idea a turn was in flight, because nothing looked.
// This script is the looking: it refuses to quit while any session is generating, waits for quiet up to a
// deadline, and only then restarts. A deploy is never worth a user's running turn — if quiet never comes
// it EXITS NONZERO and the caller decides, rather than killing the work silently.
//
//   bun scripts/safe-restart.ts [max_wait_seconds]     (default 3600)
//
// PORTED FROM BASH because every mechanism it used was macOS-only: `osascript` to ask the app to quit,
// `pkill -f` to find it, and the `sqlite3` CLI to see whether anything was generating. The QUESTIONS are
// platform-independent — is a turn in flight, is the app still up — so they are now asked in ways that
// work anywhere: the engine's own HTTP surface, and the child registry the harness already maintains.

import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import * as path from "node:path"
import { baseDirs } from "../plugin/lib/platform/paths"
import { readRegistry, isAlive } from "../plugin/lib/childreg"

const MAX_WAIT = Number(process.argv[2]) || 3600
const PORT = Number(process.env.FABULA_PORT) || 4096
const DB = path.join(baseDirs().data, "fabula.db")

/**
 * How many sessions are generating right now.
 *
 * A generating turn touches its message row continuously, so a row updated in the last 45 seconds is a
 * turn in flight. Returns null when the question cannot be answered at all — which is NOT the same as
 * zero, and the caller must not treat it as permission to kill anything.
 */
function busyCount(): number | null {
  if (!existsSync(DB)) return null
  try {
    const db = new Database(DB, { readonly: true })
    const r = db.query(
      "SELECT count(DISTINCT session_id) AS n FROM message WHERE time_updated > (unixepoch('now') - 45) * 1000",
    ).get() as any
    db.close()
    return Number(r?.n ?? 0)
  } catch {
    return null
  }
}

async function engineUp(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${PORT}/global/health`, { signal: AbortSignal.timeout(1500) })
    return true
  } catch {
    return false
  }
}

/** Stop the engine and every child it spawned, from the registry the harness already keeps. */
function stopAll(): number {
  let n = 0
  for (const rec of readRegistry()) {
    if (!isAlive(rec.pid)) continue
    try { process.kill(rec.pid, "SIGKILL"); n++ } catch {}
  }
  return n
}

let waited = 0
for (;;) {
  const n = busyCount()
  if (n === null) {
    // Nothing to ask means nothing to protect: no database, or it cannot be read.
    console.log("no session database to consult — restarting")
    stopAll()
    process.exit(0)
  }
  if (n === 0) {
    console.log("quiet — restarting")
    const killed = stopAll()
    for (let i = 0; i < 20 && await engineUp(); i++) await Bun.sleep(300)
    console.log(`stopped ${killed} process(es)`)
    process.exit(0)
  }
  if (waited >= MAX_WAIT) {
    console.error(`REFUSED: ${n} session(s) still working after ${waited}s — not killing the user's run`)
    process.exit(1)
  }
  console.log(`waiting: ${n} session(s) working (${waited}s)`)
  await Bun.sleep(15_000)
  waited += 15
}
