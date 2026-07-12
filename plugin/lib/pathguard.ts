// Sensitive-write-path guard. Blocks writes to credential/persistence files that are
// classic backdoor/exfil targets. Tight set (hardline) to avoid false-positives on normal project
// files. The broader "ask"-tier (.env, dotfiles) is policy in fabula-security, not here.

import * as os from "node:os"
import * as path from "node:path"

export interface PathVerdict { blocked: boolean; reason: string; code: string }
const OK: PathVerdict = { blocked: false, reason: "", code: "allow" }

function expand(p: string): string {
  if (typeof p !== "string" || !p) return ""
  let s = p.trim().replace(/^['"]|['"]$/g, "")
  if (s.startsWith("~/") || s === "~") s = path.join(os.homedir(), s.slice(1))
  s = s.replace(/\$\{?HOME\}?/g, os.homedir())
  try { s = path.normalize(s) } catch {}
  return s
}

/** Catastrophic write targets: SSH backdoors, system auth files, cron, shell-history poisoning. */
export function checkWritePath(rawPath: string): PathVerdict {
  const p = expand(rawPath)
  if (!p) return OK
  const home = os.homedir()
  const hits: Array<[RegExp | string, string, string]> = [
    [path.join(home, ".ssh", "authorized_keys"), "ssh_authorized_keys", "writing SSH authorized_keys installs a login backdoor."],
    [/\/\.ssh\/(authorized_keys|id_[a-z0-9]+)$/, "ssh_key", "writing into ~/.ssh keys/authorized_keys is an SSH backdoor vector."],
    ["/etc/sudoers", "sudoers", "modifying /etc/sudoers escalates privileges."],
    [/^\/etc\/sudoers\.d\//, "sudoers", "modifying sudoers.d escalates privileges."],
    ["/etc/passwd", "passwd", "modifying /etc/passwd tampers with system accounts."],
    ["/etc/shadow", "shadow", "modifying /etc/shadow tampers with password hashes."],
    [/\/cron(tab|\.d)\b|\/var\/(at|spool\/cron)\//, "cron", "writing cron entries installs persistence."],
    [/\/(Library|System)\/LaunchDaemons\//, "launchd", "writing LaunchDaemons installs persistence."],
    [path.join(home, "Library", "LaunchAgents"), "launchagent", "writing LaunchAgents installs persistence."],
  ]
  for (const [pat, code, reason] of hits) {
    const m = typeof pat === "string" ? p === pat || p.startsWith(pat) : pat.test(p)
    if (m) return { blocked: true, code, reason }
  }
  return OK
}

export function writeBlockedMessage(v: PathVerdict, p: string): string {
  return `[BLOCKED by FABULA security — write:${v.code}] Refused to write ${String(p).slice(0, 200)}: ${v.reason} ` +
    `Choose a project-local path instead.`
}
