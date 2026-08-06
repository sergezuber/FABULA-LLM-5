// WHAT MACHINE IS THIS — asked once, answered in one shape, for every decision that depends on it.
//
// The harness sizes a model's window, decides how many calls may reach it at once, and chooses how to
// confine code it did not write. Every one of those is a judgement about HARDWARE, and the hardware is
// different for every user: unified memory or a discrete card, four cores or thirty-two, a container
// runtime present or absent, a kernel that can confine a process or one that cannot.
//
// THE DEFECT THIS EXISTS TO CLOSE, measured rather than supposed: `windowplan.DEFAULT_POLICY` carries
// numbers taken on ONE machine — 48 GB of unified memory — and `policyFitsSource` correctly REFUSES to
// apply them anywhere else. Correct, and it means a user with a discrete graphics card gets no window
// plan at all. A product cannot be right for one machine and absent for the next.
//
// The answer is the one already proven for the per-token cost in `kvcost.ts`: do not tabulate hardware,
// MEASURE it, and write the measurement down. This module is the reading; `windowplan` turns a reading
// into a policy. Facts about the machine are probed. Judgements about how to treat a machine live
// elsewhere, named, so the two can never be confused for one another.
//
// READ AT CALL TIME. A profile captured at import is a snapshot of the machine as it was when a process
// started — and this project has been bitten by that shape repeatedly. The cache below is keyed by a
// FINGERPRINT of the hardware, so a machine that changed invalidates its own entry rather than serving
// a reading about a card that is no longer in it.

import * as os from "node:os"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { current, type Platform } from "./index"
import { memoryReading, gpuReading, defaultRun, type GpuReading, type MemoryKind } from "./memory"
import { sandboxPlan, untrustedScope } from "./sandbox"
import { dataDir } from "./paths"

// The accelerator is asked ONCE, in `./memory`, because sizing the window and describing the machine are
// the same question about the same hardware. They had been two probes and had already drifted: the one
// the planner used knew a single vendor, so a machine with an AMD or Intel card was sized against system
// memory as though it had none — the cache then lives somewhere far smaller than what was planned for.
export { gpuReading, type GpuReading }


export interface MachineProfile {
  platform: Platform
  memory: { kind: MemoryKind; totalBytes: number; usedBytes: number; detail: string }
  cpu: { cores: number; model: string }
  gpu: GpuReading
  /** Can untrusted code be confined by the kernel here, and by what. */
  confinement: { mechanism: "seatbelt" | "bubblewrap" | "none"; available: boolean; note: string }
  /** Is a container runtime able to run the images the sandbox uses. */
  container: { available: boolean; detail: string }
  /** Identifies the HARDWARE, not the moment. Two readings of the same machine share it. */
  fingerprint: string
}



/**
 * Everything the planner needs to know about this machine, in one reading.
 *
 * Nothing here is a judgement: no reserve, no fraction, no ceiling. Those belong to a policy, and a
 * policy is about how to TREAT a machine — which is exactly the distinction that was blurred when one
 * machine's reserve became every machine's default.
 */
export function readMachineProfile(
  p: Platform = current(),
  env: NodeJS.ProcessEnv = process.env,
): MachineProfile {
  const mem = memoryReading(p, env)
  const cpus = os.cpus?.() ?? []
  const gpu = gpuReading(p, env)
  const plan = sandboxPlan(untrustedScope(env), p, env)
  const container = containerReading(env)
  const profile: Omit<MachineProfile, "fingerprint"> = {
    platform: p,
    memory: { kind: mem.kind, totalBytes: mem.total, usedBytes: mem.used, detail: mem.detail },
    cpu: { cores: cpus.length || 1, model: cpus[0]?.model?.trim() || "unknown" },
    gpu,
    confinement: { mechanism: plan.mechanism, available: plan.available, note: plan.note },
    container,
  }
  return { ...profile, fingerprint: fingerprintOf(profile) }
}

/** Whether a container runtime can run the images the sandbox uses — the same question the tool asks. */
export function containerReading(
  env: NodeJS.ProcessEnv = process.env,
  run: (cmd: string, args: string[]) => string | null = defaultRun,
): { available: boolean; detail: string } {
  const out = run(env.FABULA_DOCKER_BIN || "docker", ["info", "--format", "{{.OSType}}"])
  if (out === null) return { available: false, detail: "no container runtime answered" }
  const kind = out.trim().toLowerCase()
  if (kind === "linux") return { available: true, detail: "container runtime serving linux images" }
  return { available: false, detail: `container runtime is serving ${kind || "an unknown"} images, which the sandbox images are not` }
}

/**
 * A short, stable identity for the HARDWARE.
 *
 * Deliberately excludes anything that moves during ordinary use — memory in use, a model being loaded,
 * the time. A cached measurement stays valid while the machine is the same machine, and is discarded
 * the moment it is not: a card added, memory changed, a container runtime installed.
 */
export function fingerprintOf(p: Omit<MachineProfile, "fingerprint">): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto")
  return createHash("sha256")
    .update([
      p.platform,
      p.memory.kind,
      String(p.memory.totalBytes),
      String(p.cpu.cores),
      p.cpu.model,
      p.gpu.vendor,
      String(p.gpu.totalBytes),
      p.confinement.mechanism,
      String(p.container.available),
    ].join("|"))
    .digest("hex")
    .slice(0, 16)
}

// ── The cache ──────────────────────────────────────────────────────────────────────────────────────
//
// Probing costs several spawns. Doing it on every plan would put them on the path of every turn, and
// the answer changes only when the machine does — which the fingerprint detects. `FABULA_PROFILE_FILE`
// names the store; `FABULA_PROFILE_CACHE=0` turns the cache off for anyone measuring the probe itself.

export function profilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.FABULA_PROFILE_FILE || path.join(dataDir(env), "machine-profile.json")
}

let memo: MachineProfile | null = null

/** The profile, cached per process and on disk, re-read when the hardware no longer matches. */
export function machineProfile(env: NodeJS.ProcessEnv = process.env): MachineProfile {
  if (env.FABULA_PROFILE_CACHE === "0") return readMachineProfile(current(env), env)
  if (memo) return memo
  const file = profilePath(env)
  const fresh = readMachineProfile(current(env), env)
  try {
    if (existsSync(file)) {
      const stored = JSON.parse(readFileSync(file, "utf8")) as MachineProfile
      // The stored reading is used only if it is about THIS machine. Anything else is a reading about a
      // machine that no longer exists, and serving it would size a window for hardware that is not here.
      if (stored?.fingerprint === fresh.fingerprint) {
        memo = stored
        return stored
      }
    }
  } catch { /* an unreadable store is replaced, never trusted */ }
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(fresh, null, 2))
    renameSync(tmp, file) // atomic: a half-written profile must never be read as a whole one
  } catch { /* an unwritable store costs a probe per process, never correctness */ }
  memo = fresh
  return fresh
}

/** Forget the per-process memo. For a caller that has just changed the machine's state on purpose. */
export function forgetProfile(): void {
  memo = null
}

/**
 * One line a human can act on. Used in refusals, so it has to say what was found, not what was wanted.
 */
export function describeProfile(p: MachineProfile): string {
  const gib = (b: number) => (b / 1024 ** 3).toFixed(1) + " GiB"
  const acc = p.gpu.vendor === "none"
    ? "no accelerator"
    : `${p.gpu.vendor}${p.gpu.totalBytes ? " " + gib(p.gpu.totalBytes) : ""}`
  return [
    `${p.platform}, ${p.cpu.cores} cores`,
    `${p.memory.kind} memory ${gib(p.memory.totalBytes)}`,
    acc,
    p.confinement.available ? `confined by ${p.confinement.mechanism}` : "no kernel confinement",
    p.container.available ? "containers available" : "no containers",
  ].join(" · ")
}