// OS-level sandbox for bash_tool (macOS Seatbelt / sandbox-exec). Our cmdguard/SSRF/pathguard are
// pattern-matching IN PROCESS — a novel command shape or an interpreter one-liner can slip a regex.
// A kernel-enforced profile is a strictly lower layer: even a command we didn't anticipate cannot
// READ ~/.ssh/~/.aws/~/.gnupg or WRITE a .env/.key/.pem. Opt-in (FABULA_SANDBOX=1). "the harness
// assumes the model will fail — and so does the OS." Pure profile builder here; wiring in fabula-tools.
import * as path from "node:path"

export interface SandboxConfig {
  home: string
  denyReadPaths?: string[]   // absolute dirs whose reads the kernel denies
  denyWriteRegex?: string[]  // path regexes whose writes the kernel denies
}

export function defaultSandboxConfig(home: string): SandboxConfig {
  return {
    home,
    denyReadPaths: [".ssh", ".aws", ".gnupg", ".config/gh", ".netrc"].map((p) => path.join(home, p)),
    denyWriteRegex: [
      "\\.env$", "\\.key$", "\\.pem$", "\\.p12$", "id_rsa", "id_ed25519",
      // THE PERSISTENCE AND SUPERVISION TARGETS, enforced by the kernel rather than by a path string.
      //
      // MEASURED 2026-08-01 through the live app: the write guard refused a LaunchAgent plist on every
      // file tool AND (after the shell door was closed) on bash too — and the model then wrote it with
      // `execute_code`, four lines of Node calling the ordinary filesystem API. A path a program COMPUTES
      // is invisible to every rule that reads arguments, which is exactly what a kernel profile is for:
      // it does not care how the path was arrived at. These mirror lib/pathguard's hardline set, so the
      // in-process rules and the kernel agree on what must not be written.
      "/LaunchAgents/", "/LaunchDaemons/",
      "authorized_keys",
      "/etc/sudoers", "/etc/passwd", "/etc/shadow",
      "/cron(tab|\\.d)", "/var/at/", "/var/spool/cron/",
      "fabula-permissions\\.json$", "fabula-state\\.json$",
    ],
  }
}

/** Escape a path for an SBPL STRING literal (`"..."`), where a backslash is itself an escape. */
function sbpl(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/**
 * Escape a pattern for an SBPL REGEX literal (`#"..."`), which is a DIFFERENT grammar.
 *
 * MEASURED 2026-08-01 against the real kernel: four of the six write rules never matched anything.
 * Inside sandbox-exec with the shipped profile, writes to `x.env`, `x.key` and `x.pem` all SUCCEEDED.
 * Isolated one rule at a time: `(regex #"\\.env$")` — what the builder emitted — WROTE; `(regex #"\.env$")`
 * was denied. The cause is that the string escaper was used on a regex literal: in `#"..."` a backslash
 * is already the REGEX escape, so doubling it produces a pattern matching a literal backslash. Only the
 * two rules with no backslash in them (`id_rsa`, `id_ed25519`) ever worked.
 *
 * Why no test caught it: the unit test asserted `toContain('\.env$')`, and in a JavaScript string
 * literal `'\.'` IS `.` — so the assertion was satisfied by the broken output as readily as by the
 * correct one, and the one live kernel test only ever attempted a READ.
 */
function sbplRegex(s: string): string {
  return s.replace(/"/g, '\\"')
}

/** Build a Seatbelt (SBPL) profile: allow everything by default, then deny reading secret dirs and
 * writing secret files. `allow default` keeps normal builds/tests working; the denies are the guard. */
export function buildSeatbeltProfile(cfg: SandboxConfig): string {
  const lines = ["(version 1)", "(allow default)"]
  const reads = (cfg.denyReadPaths ?? []).filter(Boolean)
  if (reads.length) lines.push("(deny file-read* " + reads.map((p) => `(subpath "${sbpl(p)}")`).join(" ") + ")")
  const writes = (cfg.denyWriteRegex ?? []).filter(Boolean)
  if (writes.length) lines.push("(deny file-write* " + writes.map((r) => `(regex #"${sbplRegex(r)}")`).join(" ") + ")")
  return lines.join("\n")
}

/** argv to run a bash command under the sandbox profile. */
export function sandboxArgv(command: string, profile: string): string[] {
  return ["sandbox-exec", "-p", profile, "bash", "-lc", command]
}

/**
 * argv to run a program DIRECTLY under the profile, with no shell in between.
 *
 * MEASURED 2026-08-01: confining `execute_code` by building a shell string around the program broke
 * every multi-line snippet — bash received `import time\nfor i in ...` with the newline as two literal
 * characters, and Python answered "SyntaxError: unexpected character after line continuation character".
 * Code is not a command line, and passing it through one changes it. `sandbox-exec` runs any argv, so
 * the interpreter is invoked exactly as it would have been unconfined.
 */
export function sandboxExecArgv(argv: readonly string[], profile: string): string[] {
  return ["sandbox-exec", "-p", profile, ...argv]
}
