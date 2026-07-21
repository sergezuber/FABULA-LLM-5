// Decision-trace channel — the flight recorder for the run loop.
//
// Exists because of one measured day (2026-07-21): eight distinct stall/loop causes were diagnosed by
// hand-mining the DB and grepping logs — the writer that never wrote, the watermark that advanced anyway,
// the summarizer hijack, the compaction aborted by an app restart. Every one of those questions is a
// DECISION the harness made silently: which gate fired, why the loop broke, which overflow route was
// taken. This channel records exactly those decisions as JSONL, so the next "почему встала?" is answered
// by reading a file, not by archaeology.
//
// INVISIBLE TO THE USER by design: nothing here reaches the UI or the session transcript. The sink is
// <data>/log/trace.jsonl, read only by whoever is debugging.
//
// THE TOGGLE, and why it is a FILE: the observer usually decides to look only after the process is
// already mid-task, and an env var or config flag needs a restart — which is itself what killed the
// in-flight compaction twice today. A marker file flips tracing on a LIVE process:
//   on:   touch ~/.local/share/fabula/trace.on
//   off:  rm    ~/.local/share/fabula/trace.on
// FABULA_TRACE=1|0 is the env override (wins over the marker, both directions) for headless runs.
// The marker is re-checked at most every 2 seconds; when tracing is off the entire cost of a trace()
// call is one cached boolean read.
import { appendFileSync, existsSync, statSync, mkdirSync, renameSync } from "node:fs"
import * as path from "node:path"
import { Global } from "@/global"

const RECHECK_MS = 2_000
const ROTATE_BYTES = 20 * 1024 * 1024 // rotate at 20MB → .1 (one generation kept); a debug channel must never eat the disk

/** Pure decision so the precedence is unit-testable: env wins in BOTH directions, else the marker. */
export function traceDecision(env: string | undefined, markerExists: boolean): boolean {
  if (env === "1") return true
  if (env === "0") return false
  return markerExists
}

export function traceMarkerPath(): string {
  return path.join(Global.Path.data, "trace.on")
}
export function traceFilePath(): string {
  return path.join(Global.Path.data, "log", "trace.jsonl")
}

let cached = false
let checkedAt = 0
export function traceEnabled(now = Date.now()): boolean {
  if (now - checkedAt < RECHECK_MS) return cached
  checkedAt = now
  try {
    cached = traceDecision(process.env.FABULA_TRACE, existsSync(traceMarkerPath()))
  } catch {
    cached = false
  }
  return cached
}
/** Test hook: drop the cache so the next traceEnabled() re-reads the marker. */
export function _traceResetCache(): void {
  checkedAt = 0
}

/**
 * Record one decision. NEVER throws and never blocks a turn on failure — a broken flight recorder must
 * not down the plane. Values must be small scalars; whole messages/transcripts do not belong here.
 */
export function trace(event: string, data?: Record<string, unknown>): void {
  try {
    if (!traceEnabled()) return
    const file = traceFilePath()
    mkdirSync(path.dirname(file), { recursive: true })
    try {
      if (statSync(file).size > ROTATE_BYTES) renameSync(file, file + ".1")
    } catch {
      /* no file yet */
    }
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n")
  } catch {
    /* never break a turn over tracing */
  }
}
