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
    denyWriteRegex: ["\\.env$", "\\.key$", "\\.pem$", "\\.p12$", "id_rsa", "id_ed25519"],
  }
}

/** Escape a path for an SBPL string literal. */
function sbpl(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** Build a Seatbelt (SBPL) profile: allow everything by default, then deny reading secret dirs and
 * writing secret files. `allow default` keeps normal builds/tests working; the denies are the guard. */
export function buildSeatbeltProfile(cfg: SandboxConfig): string {
  const lines = ["(version 1)", "(allow default)"]
  const reads = (cfg.denyReadPaths ?? []).filter(Boolean)
  if (reads.length) lines.push("(deny file-read* " + reads.map((p) => `(subpath "${sbpl(p)}")`).join(" ") + ")")
  const writes = (cfg.denyWriteRegex ?? []).filter(Boolean)
  if (writes.length) lines.push("(deny file-write* " + writes.map((r) => `(regex #"${sbpl(r)}")`).join(" ") + ")")
  return lines.join("\n")
}

/** argv to run a bash command under the sandbox profile. */
export function sandboxArgv(command: string, profile: string): string[] {
  return ["sandbox-exec", "-p", profile, "bash", "-lc", command]
}
