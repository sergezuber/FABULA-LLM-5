// Tool-execution backend seam (pi's "gondolin" pattern, pure). bash_tool runs against a SWAPPABLE
// backend chosen by env, so isolation is a backend swap — not a tool rewrite:
//   host              — bash -lc (default)
//   sandbox           — FABULA_SANDBOX=1 -> macOS Seatbelt (kernel-denies secret reads/writes)
//   docker:<cid>      — FABULA_BASH_BACKEND=docker:<cid> -> run inside a container (bench verify-in-
//                       container / "untrusted repo" mode: the model's commands can't touch the host)
// The harness owns the blast radius, not the model.

import { shellArgv } from "./platform/shell"
import { sandboxShellArgv, shellScope } from "./platform/sandbox"
import { current } from "./platform/index"

export interface BackendConfig { sandboxProfile?: string; dockerCid?: string }

/**
 * argv to run a shell command under the selected backend.
 *
 * The shell itself is NOT spelled out here. It comes from `platform/shell.ts`, which is also what
 * `lib/cmdguard.ts` and `lib/shelltargets.ts` are written to parse — if a backend could pick a different
 * shell, the guards would be reading one grammar while the machine ran another, and the hole would be
 * shaped like whichever backend was added last.
 *
 * The container is the exception, and deliberately so: `docker exec` runs the command inside the IMAGE's
 * shell, which is that image's business and not this host's. `bash` is named literally for that reason.
 */
export function bashArgv(command: string, cfg: BackendConfig = {}): string[] {
  if (cfg.dockerCid) return ["docker", "exec", "-i", cfg.dockerCid, "bash", "-lc", command]
  if (cfg.sandboxProfile) {
    // A profile STRING is Seatbelt's own language, so it means something on macOS and nothing anywhere
    // else. Where it means something the CALLER'S profile is used exactly as given — a caller that built
    // a narrower or wider profile has decided, and substituting our own would silently enforce a
    // different claim than the one it asked for. Everywhere else the platform is asked what it can
    // enforce instead of being handed a document it cannot read; where it can enforce nothing, `wrap` is
    // the identity and the command runs exactly as it would have, with the caller's note saying so.
    if (current() === "darwin") return ["sandbox-exec", "-p", cfg.sandboxProfile, ...shellArgv(command)]
    return sandboxShellArgv(command, shellScope()).argv
  }
  return shellArgv(command)
}

/** Resolve the backend from env (docker takes precedence over sandbox over host). */
export function resolveBackend(env: Record<string, string | undefined>, sandboxProfile: string): BackendConfig {
  const be = env.FABULA_BASH_BACKEND || ""
  if (be.startsWith("docker:")) {
    const cid = be.slice("docker:".length).trim()
    if (cid) return { dockerCid: cid }
  }
  if (env.FABULA_SANDBOX === "1" && sandboxProfile) return { sandboxProfile }
  return {}
}

/** Human-readable note appended to a tool result so the isolation is visible in the transcript. */
export function backendNote(cfg: BackendConfig): string {
  if (cfg.dockerCid) return `[backend: docker exec ${cfg.dockerCid.slice(0, 12)}]`
  if (cfg.sandboxProfile) return "[backend: macOS sandbox — secret reads/writes denied]"
  return ""
}
