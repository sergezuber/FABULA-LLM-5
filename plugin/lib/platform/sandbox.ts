// The KERNEL floor under a command — one claim, three answers, and one of them is "no".
//
// The in-process guards (`cmdguard`, `pathguard`, `shelltargets`) read a command's TEXT. That is enough
// until a path is COMPUTED rather than written: `P=<path>; echo hi > "$P"`, a glob, or four lines of
// Node calling the ordinary filesystem API. All three were MEASURED walking past the text rules on
// 2026-08-01 while the literal spelling was refused. A kernel profile does not care how a path was
// arrived at, which is the one property that makes the claim true rather than nearly true.
//
// So each platform answers the same question — "run this argv, and deny these writes at the kernel" —
// with whatever it actually has:
//
//   macOS   Seatbelt (`sandbox-exec`), a profile language of allow-default plus deny rules. On every Mac.
//   Linux   bubblewrap (`bwrap`), which does not match names at all: it makes a path UNREACHABLE by
//           mounting over it. A different mechanism for the same claim, and strictly stronger — a rule
//           cannot be evaded by spelling, because there is no spelling to evade.
//   Windows AppContainer is not reachable from a spawn, and Job Objects bound resources rather than
//           paths. THERE IS NO EQUIVALENT, and this module says so instead of inventing one.
//
// THE REFUSAL IS THE FEATURE. A sandbox that silently downgrades to an unconfined child is worse than no
// sandbox: the caller believes a claim that is not being enforced. `sandboxPlan` returns `available:
// false` with a REASON, and the caller decides — `execute_code` degrades and SAYS which of the two ran,
// while an explicit `sandbox: true` is refused outright. Both behaviours already exist for the
// Docker-absent case; this makes the platform case identical rather than special.

import { current, type Platform } from "./index"
import { credentialReadDirs, hardlineKernelRegex, hardlineTargets } from "./persistence"
import { shellArgv, whichBin } from "./shell"
import { homeDir } from "./paths"

export interface SandboxScope {
  /** The home whose credential directories are protected. Explicit — a container's home is not ours. */
  home: string
  /** Deny reads of the credential directories too (right for untrusted code, wrong for the main shell). */
  denyCredentialReads: boolean
}

export interface SandboxPlan {
  available: boolean
  /** Wrap an argv so the kernel enforces the scope. Identity when unavailable — never silently confining. */
  wrap: (argv: readonly string[]) => string[]
  /** Which mechanism this is, for the transcript. */
  mechanism: "seatbelt" | "bubblewrap" | "none"
  /** One sentence saying what IS enforced, or why nothing is. Always present, always honest. */
  note: string
}

// ── macOS: Seatbelt ────────────────────────────────────────────────────────────────────────────────

/** Escape for an SBPL STRING literal (`"..."`), where a backslash is itself an escape. */
function sbpl(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/**
 * Escape for an SBPL REGEX literal (`#"..."`), which is a DIFFERENT grammar.
 *
 * MEASURED 2026-08-01 against the real kernel: four of six write rules never matched, because the STRING
 * escaper had been used on a regex literal — in `#"..."` a backslash is already the regex escape, so
 * doubling it produces a pattern matching a literal backslash. The unit test asserted `toContain('\.env$')`
 * and in a JavaScript string literal that IS `.env$`, so it was satisfied by the broken output too.
 */
function sbplRegex(s: string): string {
  return s.replace(/"/g, '\\"')
}

export function buildSeatbeltProfile(scope: SandboxScope, env: NodeJS.ProcessEnv = process.env): string {
  const lines = ["(version 1)", "(allow default)"]
  if (scope.denyCredentialReads) {
    const reads = credentialReadDirs(scope.home)
    if (reads.length) lines.push("(deny file-read* " + reads.map((p) => `(subpath "${sbpl(p)}")`).join(" ") + ")")
  }
  const writes = hardlineKernelRegex(env, "darwin")
  if (writes.length) lines.push("(deny file-write* " + writes.map((r) => `(regex #"${sbplRegex(r)}")`).join(" ") + ")")
  return lines.join("\n")
}

// ── Linux: bubblewrap ──────────────────────────────────────────────────────────────────────────────

/**
 * bubblewrap flags that make the protected paths unreachable.
 *
 * A DIFFERENT SHAPE OF THE SAME CLAIM, and worth stating plainly: Seatbelt matches path names, bwrap
 * mounts over them. Names can be spelled around (that is what `stripPrivate` in pathguard exists for);
 * a mount cannot. So the Linux floor is not a weaker port of the macOS one — where it applies it is
 * stronger, and it is built from the SAME `hardlineTargets` list so the two can never protect different
 * sets.
 *
 * `--dev-bind / /` keeps the filesystem otherwise intact: this is a write guard, not a jail. Anything
 * broader would break ordinary work, and a guard that breaks ordinary work is one that gets switched off.
 */
export function bubblewrapArgs(scope: SandboxScope, env: NodeJS.ProcessEnv = process.env): string[] {
  const args = ["--dev-bind", "/", "/", "--die-with-parent"]
  // Every hardline target that names a real directory becomes an empty read-only mount: present, so a
  // program that stats it sees a directory, and unwritable, so nothing can be installed into it.
  for (const t of hardlineTargets(env, "linux")) {
    for (const m of t.match) {
      if (typeof m === "string" && m.startsWith("/")) args.push("--ro-bind-try", "/var/empty", m)
    }
  }
  if (scope.denyCredentialReads) {
    // Reads are denied by shadowing the directory with an empty one — the credential is not there to read.
    for (const dir of credentialReadDirs(scope.home)) args.push("--tmpfs", dir)
  }
  return args
}

// ── The one entry point ────────────────────────────────────────────────────────────────────────────

/**
 * How this platform can enforce `scope`, or why it cannot.
 *
 * Read at CALL time and PROBED, not assumed: `bwrap` is a package, not a guarantee, and a plan that
 * claimed it without looking would produce an argv whose first word does not exist — a failure that
 * reads as "the command broke" rather than "the sandbox is missing".
 */
export function sandboxPlan(
  scope: SandboxScope,
  p: Platform = current(),
  env: NodeJS.ProcessEnv = process.env,
): SandboxPlan {
  if (p === "darwin") {
    if (!whichBin("sandbox-exec", { ...env, PATH: `/usr/bin:${env.PATH ?? ""}` }, p)) {
      return { available: false, wrap: (a) => [...a], mechanism: "none", note: "no kernel profile available here (sandbox-exec not found)" }
    }
    const profile = buildSeatbeltProfile(scope, env)
    return {
      available: true,
      mechanism: "seatbelt",
      wrap: (argv) => ["sandbox-exec", "-p", profile, ...argv],
      note: "macOS kernel profile — credential and persistence paths denied by the kernel",
    }
  }

  if (p === "linux") {
    const bwrap = whichBin("bwrap", env, p)
    if (!bwrap) {
      return {
        available: false,
        wrap: (a) => [...a],
        mechanism: "none",
        // NAMED, because a missing package is fixable and an unfixable platform is not — the reader
        // must be able to tell which one they have.
        note: "no kernel profile available here (bubblewrap not installed — `apt install bubblewrap`)",
      }
    }
    return {
      available: true,
      mechanism: "bubblewrap",
      wrap: (argv) => [bwrap, ...bubblewrapArgs(scope, env), ...argv],
      note: "Linux kernel namespaces — credential and persistence paths made unreachable",
    }
  }

  return {
    available: false,
    wrap: (a) => [...a],
    mechanism: "none",
    // Not a missing package: Windows has no per-spawn path-scoped confinement a plugin can apply.
    // Saying "not installed" would send someone looking for something to install.
    note: "Windows has no per-command kernel path confinement; use the Docker backend for isolation",
  }
}

/** Wrap a SHELL command line. The shell comes from the one place that decides it. */
export function sandboxShellArgv(
  command: string,
  scope: SandboxScope,
  p: Platform = current(),
  env: NodeJS.ProcessEnv = process.env,
): { argv: string[]; plan: SandboxPlan } {
  const plan = sandboxPlan(scope, p, env)
  return { argv: plan.wrap(shellArgv(command, { env, platform: p })), plan }
}

/** The scope for the main working shell: persistence targets only, reads untouched. */
export function shellScope(env: NodeJS.ProcessEnv = process.env): SandboxScope {
  return { home: homeDir(env), denyCredentialReads: false }
}

/** The scope for untrusted code: persistence targets AND credential reads. */
export function untrustedScope(env: NodeJS.ProcessEnv = process.env): SandboxScope {
  return { home: homeDir(env), denyCredentialReads: true }
}
