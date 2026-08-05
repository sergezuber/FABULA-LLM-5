// "Start this with my session and keep it alive" — the adapter on :1235, on three platforms.
//
// The adapter is not optional: local models are reached THROUGH it, and without it structured/tool calls
// fail with HTTP 400. So it has to come up with the user's session on whatever they are running, and the
// three systems that can promise that speak three different languages — a launchd LaunchAgent, a systemd
// user service, a Task Scheduler task registered for logon.
//
// ONE THING MATTERS MORE THAN THE FORMAT, and it is why this module exists rather than three inline
// heredocs: a service manager hands the process NO environment of its own. That was a live defect for a
// long time — every documented adapter knob was silently a code default and every kill-switch was
// UNREACHABLE in production, verified by finding zero `FABULA_*` variables in the running process. The
// adapter now loads the repo `.env` itself, which is the honest fix; the units below therefore do NOT try
// to smuggle environment in, and `.env` stays the single place the documentation can point at.

import * as path from "node:path"

// Rendered in the TARGET platform's dialect, not the host's: `path.join` answers in the shape of the
// machine running this code, so a Windows host produced backslash paths for the POSIX platforms and
// every rule written with `/` stopped matching. `path` itself stays only where the question really is
// about this machine.
const posix = path.posix
const win = path.win32
import { current, type Platform } from "./index"
import { homeDir } from "./paths"

export const ADAPTER_LABEL = "com.fabula.lmstudio-adapter"

export interface ServiceSpec {
  /** Absolute path to the python interpreter that will run the adapter. */
  python: string
  /** Absolute path to `proxy/lmstudio-adapter.py`. */
  script: string
  /** Where stdout/stderr go. The adapter rotates this file itself. */
  logPath: string
}

export interface ServiceInstall {
  filePath: string | null
  fileBody: string | null
  registerArgv: string[]
  unregisterArgv: string[]
  statusArgv: string[]
  /** One sentence a human can act on if the register step fails. */
  hint: string
}

function xml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function serviceFile(p: Platform = current(), env: NodeJS.ProcessEnv = process.env): string | null {
  const home = homeDir(env)
  if (p === "darwin") return posix.join(home, "Library", "LaunchAgents", `${ADAPTER_LABEL}.plist`)
  if (p === "linux") return posix.join(home, ".config", "systemd", "user", "fabula-adapter.service")
  return null
}

export function planServiceInstall(
  spec: ServiceSpec,
  p: Platform = current(),
  env: NodeJS.ProcessEnv = process.env,
): ServiceInstall {
  const file = serviceFile(p, env)

  if (p === "darwin") {
    return {
      filePath: file,
      fileBody: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${ADAPTER_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(spec.python)}</string><string>${xml(spec.script)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`,
      unregisterArgv: ["launchctl", "unload", file!],
      registerArgv: ["launchctl", "load", file!],
      statusArgv: ["launchctl", "list", ADAPTER_LABEL],
      hint: `start LM Studio, then: launchctl kickstart -k gui/$(id -u)/${ADAPTER_LABEL}`,
    }
  }

  if (p === "linux") {
    return {
      filePath: file,
      // Restart=always is the systemd spelling of launchd's KeepAlive. RestartSec keeps a genuinely
      // broken adapter from becoming a spin loop that fills the journal.
      fileBody: `[Unit]
Description=FABULA LM Studio compatibility adapter (:1235)
After=default.target

[Service]
Type=simple
ExecStart=${spec.python} ${spec.script}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`,
      unregisterArgv: ["systemctl", "--user", "disable", "--now", "fabula-adapter.service"],
      registerArgv: ["systemctl", "--user", "enable", "--now", "fabula-adapter.service"],
      statusArgv: ["systemctl", "--user", "is-active", "fabula-adapter.service"],
      hint: "start LM Studio, then: systemctl --user restart fabula-adapter.service" +
        " (a session with no systemd user instance needs `loginctl enable-linger $USER` first)",
    }
  }

  // Windows: registered for LOGON rather than boot. The adapter talks to a serving runtime the user
  // starts in their own session, so a task running before anyone logs in would only ever fail.
  return {
    filePath: null,
    fileBody: null,
    unregisterArgv: ["schtasks", "/Delete", "/TN", ADAPTER_LABEL, "/F"],
    registerArgv: [
      "schtasks", "/Create", "/TN", ADAPTER_LABEL, "/SC", "ONLOGON", "/F",
      "/TR", `"${spec.python}" "${spec.script}"`,
    ],
    statusArgv: ["schtasks", "/Query", "/TN", ADAPTER_LABEL],
    hint: `start LM Studio, then: schtasks /Run /TN ${ADAPTER_LABEL}`,
  }
}

/**
 * Candidate python interpreters, most specific first.
 *
 * NAMED explicitly because the adapter is stdlib-only: any Python 3 will run it, so the goal is simply to
 * find one that exists rather than to find the "right" one. `py -3` is the Windows launcher, which is how
 * a Windows install is reachable without knowing where the interpreter was put.
 */
export function pythonCandidates(p: Platform = current()): string[] {
  if (p === "win32") return ["python3.exe", "python.exe", "py"]
  return ["python3", "/usr/bin/python3", "/opt/homebrew/bin/python3"]
}
