// "Run this again later" — one contract, three schedulers.
//
// launchd, systemd and Task Scheduler agree on what a scheduled job IS and disagree about every detail of
// declaring one: a plist under `~/Library/LaunchAgents` loaded with `launchctl`, a `.timer` beside a
// `.service` under `~/.config/systemd/user` enabled with `systemctl --user`, a task registered with
// `schtasks /Create`. So the SHAPE of a job lives here once, and each platform renders it.
//
// THE PROPERTY THAT MUST SURVIVE THE PORT, because it was paid for: MEASURED 2026-08-01, two
// `com.fabula.schedule.*` plists sat in `~/Library/LaunchAgents` that `launchctl list` had never heard
// of, and `list_scheduled` reported both as armed jobs. A file is not a schedule. Every backend here
// therefore answers `list` from the SCHEDULER, and reports a file the scheduler does not know as an
// ORPHAN rather than as a job — the same claim on all three platforms, since a stale unit file and a
// stale plist mislead a reader identically.

import { current, type Platform } from "./index"
import { homeDir } from "./paths"
import * as path from "node:path"

// Rendered in the TARGET platform's dialect, not the host's: `path.join` answers in the shape of the
// machine running this code, so a Windows host produced backslash paths for the POSIX platforms and
// every rule written with `/` stopped matching. `path` itself stays only where the question really is
// about this machine.
const posix = path.posix
const win = path.win32

export const LABEL_PREFIX = "com.fabula.schedule."

/** A daily job, described once, independent of who will run it. */
export interface JobSpec {
  /** Slug, already sanitised. The label/unit/task name is derived from it. */
  id: string
  /** The command line, run under the harness's shell. */
  command: string
  hour: number
  minute: number
  logPath: string
}

/** What a backend needs to DO to install a job: a file to write, then a command to run. */
export interface JobInstall {
  /** Absolute path of the definition file, or null for a backend that keeps no file (schtasks). */
  filePath: string | null
  /** Contents of that file, or null when there is none. */
  fileBody: string | null
  /** argv that registers the job with the scheduler. */
  registerArgv: string[]
  /** argv that de-registers a prior version first. Idempotence: run it and ignore failure. */
  unregisterArgv: string[]
  /** argv that lists what the scheduler actually knows about. */
  listArgv: string[]
}

export function jobLabel(id: string): string {
  return LABEL_PREFIX + id
}

/** Directory holding job definition files, or null for a backend that keeps none. */
export function jobDir(p: Platform = current(), env: NodeJS.ProcessEnv = process.env): string | null {
  const home = homeDir(env)
  if (p === "darwin") return posix.join(home, "Library", "LaunchAgents")
  if (p === "linux") return posix.join(home, ".config", "systemd", "user")
  return null // Task Scheduler owns its own store; nothing of ours belongs on disk
}

/** The definition file for a job, or null when the backend keeps none. */
export function jobFile(id: string, p: Platform = current(), env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = jobDir(p, env)
  if (!dir) return null
  return p === "darwin"
    ? posix.join(dir, `${jobLabel(id)}.plist`)
    : posix.join(dir, `${jobLabel(id)}.timer`)
}

/** Escape for XML text content (launchd plists). */
function xml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** A LaunchAgent plist that runs `command` daily at hour:minute. */
export function buildPlist(o: JobSpec & { label: string; shell: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(o.shell)}</string>
    <string>-lc</string>
    <string>${xml(o.command)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${o.hour}</integer><key>Minute</key><integer>${o.minute}</integer></dict>
  <key>StandardOutPath</key><string>${xml(o.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(o.logPath)}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`
}

/**
 * A systemd user timer, and the service it triggers.
 *
 * TWO units, because systemd separates WHEN from WHAT. `Persistent=true` is deliberate and is the one
 * real behavioural difference from launchd: a laptop asleep at the scheduled minute runs the job at the
 * next wake rather than skipping the day. launchd does this by default; without the flag systemd does
 * not, and a job silently skipped is the failure this whole ledger exists to make visible.
 */
export function buildSystemdUnits(o: JobSpec & { label: string; shell: string }): { timer: string; service: string } {
  const hh = String(o.hour).padStart(2, "0")
  const mm = String(o.minute).padStart(2, "0")
  return {
    timer: `[Unit]
Description=FABULA scheduled job ${o.label}

[Timer]
OnCalendar=*-*-* ${hh}:${mm}:00
Persistent=true
Unit=${o.label}.service

[Install]
WantedBy=timers.target
`,
    service: `[Unit]
Description=FABULA scheduled job ${o.label}

[Service]
Type=oneshot
ExecStart=${o.shell} -lc ${JSON.stringify(o.command)}
StandardOutput=append:${o.logPath}
StandardError=append:${o.logPath}
`,
  }
}

/**
 * Everything a caller must do to install this job on this platform.
 *
 * The caller writes `fileBody` to `filePath` (when there is one), runs `unregisterArgv` ignoring its
 * result, then runs `registerArgv`. Same three steps everywhere — which is the point.
 */
export function planInstall(
  spec: JobSpec,
  opts: { shell: string; platform?: Platform; env?: NodeJS.ProcessEnv } ,
): JobInstall {
  const env = opts.env ?? process.env
  const p = opts.platform ?? current(env)
  const label = jobLabel(spec.id)
  const file = jobFile(spec.id, p, env)

  if (p === "darwin") {
    return {
      filePath: file,
      fileBody: buildPlist({ ...spec, label, shell: opts.shell }),
      unregisterArgv: ["launchctl", "unload", file!],
      registerArgv: ["launchctl", "load", file!],
      listArgv: ["launchctl", "list"],
    }
  }

  if (p === "linux") {
    return {
      filePath: file,
      fileBody: buildSystemdUnits({ ...spec, label, shell: opts.shell }).timer,
      unregisterArgv: ["systemctl", "--user", "disable", "--now", `${label}.timer`],
      registerArgv: ["systemctl", "--user", "enable", "--now", `${label}.timer`],
      listArgv: ["systemctl", "--user", "list-timers", "--all", "--no-legend"],
    }
  }

  // Windows: the task IS the registration; there is no file of ours to leave behind — which also means
  // there is no orphan file to mistake for a job.
  const hhmm = `${String(spec.hour).padStart(2, "0")}:${String(spec.minute).padStart(2, "0")}`
  return {
    filePath: null,
    fileBody: null,
    unregisterArgv: ["schtasks", "/Delete", "/TN", label, "/F"],
    registerArgv: [
      "schtasks", "/Create", "/TN", label, "/SC", "DAILY", "/ST", hhmm, "/F",
      "/TR", `${opts.shell} -lc "${spec.command.replace(/"/g, '\\"')}"`,
    ],
    listArgv: ["schtasks", "/Query", "/FO", "CSV", "/NH"],
  }
}

/**
 * Which of our job ids the SCHEDULER actually knows about, read from its own list output.
 *
 * Every backend prints the label somewhere on the line; nothing here tries to parse the rest of the
 * format, because the only question being asked is "does the scheduler know this label". A parser that
 * understood more would have more ways to be wrong about the one thing that matters.
 */
export function parseKnownJobs(listOutput: string): string[] {
  const out: string[] = []
  const re = new RegExp(`${LABEL_PREFIX.replace(/\./g, "\\.")}([a-z0-9-]+)`, "g")
  for (const m of String(listOutput ?? "").matchAll(re)) {
    if (m[1] && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

/**
 * The one-shot self-removal appended to a job's own command line.
 *
 * Takes the definition file EXPLICITLY rather than deriving it: a one-shot job has to remove the exact
 * file it was installed from, and a helper that recomputed the path would silently do nothing whenever
 * the caller had installed it anywhere else.
 */
export function selfRemoveCommand(
  label: string,
  filePath: string | null,
  p: Platform = current(),
): string {
  const q = (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`
  if (p === "darwin") return `launchctl unload ${q(filePath!)} 2>/dev/null; rm -f ${q(filePath!)}`
  if (p === "linux") {
    const unit = label.endsWith(".timer") ? label : `${label}.timer`
    return `systemctl --user disable --now ${q(unit)} 2>/dev/null` + (filePath ? `; rm -f ${q(filePath)}` : "")
  }
  return `schtasks /Delete /TN ${q(label)} /F >NUL 2>&1`
}
