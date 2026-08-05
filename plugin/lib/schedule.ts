// Self-scheduling — the FABULA-shaped half. WHICH scheduler runs the job (launchd, systemd user timers,
// Task Scheduler) is `platform/scheduler.ts`; what a FABULA job CONTAINS is here: the id rules, the
// clock parsing, and the command line that sources .env, runs the engine and reports the outcome.
// The scheduled prompt is threat-scanned (injection guard) before a job is ever written.

import { LABEL_PREFIX, selfRemoveCommand, buildPlist as buildPlatformPlist } from "./platform/scheduler"
import { current } from "./platform/index"
import { shellBinAbsolute } from "./platform/shell"

export { LABEL_PREFIX }

/** Safe job-id slug from a user name. Deliberately the intersection of what all three schedulers accept:
 *  lowercase, digits and hyphens survive a launchd label, a systemd unit name and a Task Scheduler name
 *  alike, so one id names the same job everywhere. */
export function sanitizeJobId(name: string): string | null {
  if (typeof name !== "string") return null
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)
  return slug || null
}

/** Parse "HH:MM" (24h) → {hour, minute} or null. */
export function parseTime(t: string): { hour: number; minute: number } | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((t || "").trim())
  if (!m) return null
  return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) }
}

/** Shell-quote a string for safe inclusion in a `-lc` command. */
export function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`
}

export interface PlistOpts {
  label: string
  command: string
  hour: number
  minute: number
  logPath: string
}

/** Build a LaunchAgent plist XML that runs `command` daily at hour:minute.
 *  Kept as a named export because callers and tests speak in plists; the rendering itself lives with the
 *  other two schedulers, so adding a field to a job means editing one file rather than three. */
export function buildPlist(o: PlistOpts): string {
  // RESOLVED, and resolved to an ABSOLUTE path: `/bin/bash` is a fact about macOS and Linux rather than
  // about every machine this runs on, and a scheduler does not search PATH — a definition naming a program
  // it cannot find fails at the one moment nobody is watching.
  return buildPlatformPlist({ ...o, id: "", shell: shellBinAbsolute() })
}

/** Build the command that a scheduled job runs (sources .env, runs the engine; optional one-shot
 *  self-removal). With `notify`: adds a fail-loud preflight (if the local model endpoint is down → ping
 *  "did not run" + stamp, and stop) and captures the run output, piping it to the jobpostrun CLI helper
 *  (untrusted-wrap + threat-scan + ntfy + ledger-stamp). See lib/jobpostrun.ts. */
export function buildJobCommand(o: {
  workspace: string; dotenv: string; engine: string; model?: string; prompt: string
  oneShot?: boolean; plistPath?: string; label?: string
  notify?: { bun: string; helper: string; ledger: string; label: string; preflightUrl?: string }
}): string {
  const modelArg = o.model ? `-m ${shQuote(o.model)} ` : ""
  const engineRun = `${shQuote(o.engine)} run ${modelArg}${shQuote(o.prompt)}`
  let cmd = `cd ${shQuote(o.workspace)}; set -a; [ -f ${shQuote(o.dotenv)} ] && . ${shQuote(o.dotenv)}; set +a; ` +
    `export MIMOCODE_DISABLE_GIT=1; `
  if (o.notify) {
    const n = o.notify
    const helper = (extra: string) =>
      `${shQuote(n.bun)} ${shQuote(n.helper)} --label ${shQuote(n.label)} --ledger ${shQuote(n.ledger)} ${extra}`
    if (n.preflightUrl) {
      cmd += `if ! curl -sf -m 8 ${shQuote(n.preflightUrl)} >/dev/null 2>&1; then ${helper("--offline --rc 1")} </dev/null; exit 0; fi; `
    }
    cmd += `OUT=$(${engineRun} 2>&1); RC=$?; printf '%s' "$OUT" | ${helper(`--rc "$RC"`)}`
  } else {
    cmd += engineRun
  }
  // A one-shot job removes ITSELF, in whatever way this platform's scheduler understands.
  if (o.oneShot && o.plistPath && o.label) {
    cmd += `; ${selfRemoveCommand(o.label, o.plistPath, current())}`
  }
  return cmd
}
