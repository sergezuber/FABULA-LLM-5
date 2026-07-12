// Self-scheduling via macOS launchd LaunchAgents (real firing, user-scoped, no daemon to
// maintain). Pure builders/parsers (unit-testable); the file write + launchctl load live in the tool.
// The scheduled prompt is threat-scanned (injection guard) before a job is ever written.

export const LABEL_PREFIX = "com.fabula.schedule."

/** Safe launchd label slug from a user name. */
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

/** Shell-quote a string for safe inclusion in a bash -lc command. */
export function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`
}

export interface PlistOpts {
  label: string
  command: string        // bash -lc <command>
  hour: number
  minute: number
  logPath: string
}

/** Build a LaunchAgent plist XML that runs `command` daily at hour:minute. */
export function buildPlist(o: PlistOpts): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>${esc(o.command)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${o.hour}</integer><key>Minute</key><integer>${o.minute}</integer></dict>
  <key>StandardOutPath</key><string>${esc(o.logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(o.logPath)}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`
}

/** Build the bash command that a scheduled job runs (sources .env, runs the engine; optional one-shot self-unload).
 *  With `notify`: adds a fail-loud preflight (if the local model endpoint is down → ping
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
  if (o.oneShot && o.plistPath && o.label) {
    cmd += `; launchctl unload ${shQuote(o.plistPath)} 2>/dev/null; rm -f ${shQuote(o.plistPath)}`
  }
  return cmd
}
