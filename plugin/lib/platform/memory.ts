// How much memory this machine has, and how much of it is already spent.
//
// THE PORT'S DEEPEST PROBLEM LIVES HERE, and it is not "a different command for the same number".
// `lib/windowplan.ts` sizes a model's context window as
//     (total − systemReserve − residents) × commitFraction − weights
// and on Apple Silicon that arithmetic is right because memory is UNIFIED: the KV cache, the weights and
// the desktop all draw on one pool, so `vm_stat` measures the thing being spent. On a typical Windows or
// Linux box with a discrete GPU the KV cache lives in VRAM, and system RAM is simply the wrong quantity.
// A planner given 64 GB of system RAM on a machine with 24 GB of VRAM computes a window the loader cannot
// pay for — and on that hardware an over-sized load does not fail cleanly, it drives the machine into
// swap. `modelload.ts` says NEVER PROBES for exactly that reason.
//
// So the source of the number is a decision, and it is made here, once. When the source cannot be
// established the answer is `unknown` and the planner REFUSES — it already has that path, and a refusal
// is the only honest output when the alternative is a confident guess about someone's machine.

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { totalmem, freemem } from "node:os"
import { current, type Platform } from "./index"

/**
 * Where the KV cache is actually allocated on this machine.
 *
 * `unified`       — one pool for everything (Apple Silicon). System memory IS the budget.
 * `discrete-vram` — the cache lives in GPU memory; system RAM does not bound it and must not be used.
 * `cpu-only`      — no GPU in play; system memory is the budget again, but without a unified-memory
 *                   desktop competing for the same pages in the same way.
 * `unknown`       — could not be established. The planner refuses rather than guessing.
 */
export type MemoryKind = "unified" | "discrete-vram" | "cpu-only" | "unknown"

export interface MemoryReading {
  kind: MemoryKind
  /** Total bytes of the pool the cache is allocated from. 0 when unknown. */
  total: number
  /** Bytes of that pool already spent. 0 when unknown. */
  used: number
  /** Plain sentence naming where these came from — it ends up in refusal messages. */
  detail: string
}

/**
 * Bytes in use right now, from the kernel.
 *
 * macOS: `vm_stat`, because nothing else reports it — the serving API returns no memory field and
 * `lms ps` reports the weights, which are constant in the window and fit a flat line. Active + wired +
 * compressor is the honest "cannot be handed to someone else" figure; `freemem()` on macOS counts
 * compressed pages as free and reads high by tens of gigabytes.
 *
 * Linux: `MemAvailable` from `/proc/meminfo` — deliberately NOT `MemFree`, which excludes reclaimable
 * page cache and so understates what a new allocation can actually have, systematically and by a lot.
 *
 * Windows: `os.freemem()`, which on Windows genuinely reports available physical memory.
 */
export function usedBytes(p: Platform = current(), env: NodeJS.ProcessEnv = process.env): number {
  const pinned = Number(env.FABULA_MEMORY_USED_BYTES)
  if (Number.isFinite(pinned) && pinned > 0) return pinned
  try {
    if (p === "darwin") {
      const out = execFileSync("vm_stat", { encoding: "utf8", timeout: 3000 })
      const page = Number(out.match(/page size of (\d+)/)?.[1]) || 16384
      const grab = (label: string) => Number(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1]) || 0
      return (grab("Pages active") + grab("Pages wired down") + grab("Pages occupied by compressor")) * page
    }
    if (p === "linux") {
      const info = readFileSync("/proc/meminfo", "utf8")
      const kb = (label: string) => Number(info.match(new RegExp(`^${label}:\\s+(\\d+) kB`, "m"))?.[1]) || 0
      const total = kb("MemTotal")
      const available = kb("MemAvailable")
      if (!total || !available) return 0
      return Math.max(0, (total - available) * 1024)
    }
    // Windows and everything else: the runtime's own figure, which is correct there.
    const t = totalmem()
    const f = freemem()
    return t > 0 && f >= 0 ? Math.max(0, t - f) : 0
  } catch {
    // A memory reading is an input to a decision that can refuse. Zero means "did not measure", and the
    // caller treats it as such — it must never be mistaken for "nothing is in use".
    return 0
  }
}

/**
 * Total bytes of physical system memory.
 *
 * `FABULA_MEMORY_TOTAL_BYTES` / `FABULA_MEMORY_USED_BYTES` pin both readings.
 *
 * WHY THEY EXIST, measured 2026-08-03: the window planner's tests read the REAL machine, so their verdict
 * moved with whatever else happened to be running. In isolation they passed 5/5; under the full 163-file
 * suite — or simply with the app open — three of them flipped, because a few gigabytes of live memory is
 * the difference between "this window fits" and "it does not". A test whose answer depends on the
 * developer's free RAM is not hermetic, and this repository's own rule says tests must be. The reading is
 * therefore pinnable at the SOURCE and `lib/test-preload.ts` pins it, so no test file had to be touched
 * and none can be quietly rewritten to match a machine.
 *
 * NOT a production knob: a pinned figure in real use would plan a window for a machine that does not
 * exist, which is precisely the mistake `NEVER PROBES` exists to prevent.
 */
export function totalBytes(p: Platform = current(), env: NodeJS.ProcessEnv = process.env): number {
  const pinned = Number(env.FABULA_MEMORY_TOTAL_BYTES)
  if (Number.isFinite(pinned) && pinned > 0) return pinned
  try {
    if (p === "linux") {
      const info = readFileSync("/proc/meminfo", "utf8")
      const total = Number(info.match(/^MemTotal:\s+(\d+) kB/m)?.[1]) || 0
      if (total) return total * 1024
    }
  } catch { /* fall through to the runtime's own answer */ }
  return totalmem()
}

/**
 * GPU memory, when a discrete GPU is what holds the cache.
 *
 * Returns null when there is no GPU tool to ask — which is a different answer from "zero VRAM" and is
 * treated as such by the caller. `nvidia-smi` ships with the driver on both Windows and Linux;
 * `rocm-smi` with ROCm. Neither is probed for on macOS: an Apple Silicon machine has no discrete VRAM to
 * find, and asking would only add a spawn to every plan.
 */
export function vramBytes(
  p: Platform = current(),
  env: NodeJS.ProcessEnv = process.env,
): { total: number; used: number } | null {
  if (p === "darwin") return null
  const named = env.FABULA_NVIDIA_SMI
  try {
    const out = execFileSync(named || "nvidia-smi", [
      "--query-gpu=memory.total,memory.used",
      "--format=csv,noheader,nounits",
    ], { encoding: "utf8", timeout: 4000 })
    // Sum across devices: a serving runtime given several GPUs draws on all of them.
    let total = 0
    let used = 0
    for (const line of out.trim().split("\n")) {
      const [t, u] = line.split(",").map((s) => Number(s.trim()))
      if (!Number.isFinite(t) || !Number.isFinite(u)) continue
      total += t * 1024 * 1024
      used += u * 1024 * 1024
    }
    return total > 0 ? { total, used } : null
  } catch {
    return null
  }
}

/**
 * The pool the window planner should size against, and where the numbers came from.
 *
 * `FABULA_MEMORY_SOURCE` forces the kind for an operator who knows their machine better than a probe
 * does — a shared server, an eGPU, a runtime pinned to the CPU. Naming it is a decision; the harness
 * never overrides a decision it did not make.
 */
export function memoryReading(
  p: Platform = current(),
  env: NodeJS.ProcessEnv = process.env,
): MemoryReading {
  const forced = env.FABULA_MEMORY_SOURCE as MemoryKind | undefined

  if (p === "darwin" && forced !== "cpu-only" && forced !== "discrete-vram") {
    const total = totalBytes(p, env)
    const used = usedBytes(p, env)
    if (!total) return { kind: "unknown", total: 0, used: 0, detail: "could not read system memory" }
    return { kind: "unified", total, used, detail: "unified memory (vm_stat)" }
  }

  if (forced !== "cpu-only") {
    const vram = vramBytes(p, env)
    if (vram) {
      return {
        kind: "discrete-vram",
        total: vram.total,
        used: vram.used,
        detail: `GPU memory (nvidia-smi): ${(vram.total / 1024 ** 3).toFixed(1)} GiB total`,
      }
    }
    if (forced === "discrete-vram") {
      return { kind: "unknown", total: 0, used: 0, detail: "FABULA_MEMORY_SOURCE=discrete-vram, but no GPU tool answered" }
    }
  }

  const total = totalBytes(p, env)
  const used = usedBytes(p, env)
  if (!total) return { kind: "unknown", total: 0, used: 0, detail: "could not read system memory" }
  return { kind: "cpu-only", total, used, detail: "system memory (no discrete GPU found)" }
}
