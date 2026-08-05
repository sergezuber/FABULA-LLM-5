// OS-level sandbox for bash_tool (macOS Seatbelt / sandbox-exec). Our cmdguard/SSRF/pathguard are
// pattern-matching IN PROCESS — a novel command shape or an interpreter one-liner can slip a regex.
// A kernel-enforced profile is a strictly lower layer: even a command we didn't anticipate cannot
// READ ~/.ssh/~/.aws/~/.gnupg or WRITE a .env/.key/.pem. Opt-in (FABULA_SANDBOX=1). "the harness
// assumes the model will fail — and so does the OS." Pure profile builder here; wiring in fabula-tools.
import { CREDENTIAL_WRITE_REGEX, credentialReadDirs, hardlineKernelRegex } from "./platform/persistence"
import { shellArgv } from "./platform/shell"

export interface SandboxConfig {
  home: string
  denyReadPaths?: string[]   // absolute dirs whose reads the kernel denies
  denyWriteRegex?: string[]  // path regexes whose writes the kernel denies
}

export function defaultSandboxConfig(home: string): SandboxConfig {
  return {
    home,
    denyReadPaths: credentialReadDirs(home),
    denyWriteRegex: [
      ...CREDENTIAL_WRITE_REGEX,
      // THE PERSISTENCE AND SUPERVISION TARGETS, enforced by the kernel rather than by a path string.
      //
      // MEASURED 2026-08-01 through the live app: the write guard refused a LaunchAgent plist on every
      // file tool AND (after the shell door was closed) on bash too — and the model then wrote it with
      // `execute_code`, four lines of Node calling the ordinary filesystem API. A path a program COMPUTES
      // is invisible to every rule that reads arguments, which is exactly what a kernel profile is for:
      // it does not care how the path was arrived at.
      //
      // These used to be a hand-written COPY of `lib/pathguard`'s hardline set, with a comment saying so.
      // They are now RENDERED from it (`platform/persistence.ts`), which is the whole difference between
      // two lists that agree today and one list that cannot disagree tomorrow. One deliberate consequence:
      // this profile now also denies `~/.ssh/id_*`, which the copy had lost while the in-process guard
      // kept refusing it — the drift a mirror always eventually develops, found the moment the two were
      // rendered from one source.
      ...hardlineKernelRegex(),
    ],
  }
}

/**
 * The HARDLINE set only — the persistence and credential PATHS `lib/pathguard.ts` already refuses —
 * with none of the file-extension rules.
 *
 * This is the profile the SHELL runs under, and the difference from `defaultSandboxConfig` is the whole
 * point. `execute_code` is for untrusted or experimental code, so denying it every `.env`/`.key`/`.pem`
 * write is right. `bash_tool` is the main working tool, and writing a `.env` in your own project is
 * ordinary work — a guard that refuses it is one that gets switched off. So the kernel is asked to
 * enforce exactly what the in-process rules already declare, and nothing more.
 *
 * MEASURED 2026-08-01 by an independent review, and it is why this exists at all: the shell extractor
 * reads a command's TEXT, so three spellings of one write walked past it — `P=<path>; echo hi > "$P"`,
 * a glob, and `python3 -c "open(<path>,'w')"`. All three were allowed while the literal spelling was
 * blocked. No amount of parsing closes that: a path a program computes has no text to read. The kernel
 * does not care how a path was arrived at, which is the one property that makes the claim true rather
 * than nearly true.
 */
export function hardlineSandboxConfig(home: string): SandboxConfig {
  return {
    home,
    // Reads are NOT restricted here. The shell legitimately reads everything; the claim being enforced
    // is about WRITES, and widening it silently would break ordinary work in a way nobody asked for.
    denyReadPaths: [],
    // Exactly the in-process hardline set, rendered — no extension rules. That the two profiles differ by
    // one array spread, rather than by two hand-maintained lists, is what keeps the difference deliberate.
    denyWriteRegex: hardlineKernelRegex(),
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

/** argv to run a shell command under the sandbox profile. The shell itself comes from the one place
 *  that decides it (`platform/shell.ts`), so the confined shell and the unconfined one can never be
 *  different programs — a difference that would make the guards read one grammar and the kernel confine
 *  another.
 *
 *  Kept taking a macOS PROFILE STRING because that is what its callers and tests hold. New code should
 *  use `platform/sandbox.ts sandboxShellArgv`, which asks the platform what it can enforce instead of
 *  assuming Seatbelt exists. */
export function sandboxArgv(command: string, profile: string): string[] {
  return ["sandbox-exec", "-p", profile, ...shellArgv(command)]
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
