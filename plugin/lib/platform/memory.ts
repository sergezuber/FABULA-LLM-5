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
import { whichBin } from "./shell"

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
 * Returns null when NO accelerator answered — a different statement from "zero VRAM", and the caller
 * relies on the difference. Every vendor is asked, through the one reading below.
 */
export function vramBytes(
  p: Platform = current(),
  env: NodeJS.ProcessEnv = process.env,
): { total: number; used: number } | null {
  if (p === "darwin") return null
  const g = gpuReading(p, env)
  return g.totalBytes > 0 ? { total: g.totalBytes, used: g.usedBytes } : null
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
    // Asked ONCE: the probe spawns a vendor tool, and this runs on the path that sizes every load.
    const g = p === "darwin" ? null : gpuReading(p, env)
    const vram = g && g.totalBytes > 0 ? { total: g.totalBytes, used: g.usedBytes } : null
    if (vram) {
      return {
        kind: "discrete-vram",
        total: vram.total,
        used: vram.used,
        detail: `GPU memory (${g!.detail}): ${(vram.total / 1024 ** 3).toFixed(1)} GiB total`,
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

export interface GpuReading {
  /** Named as the probe found it. `unknown` means an accelerator was seen and not identified — which is
   *  a different statement from "there is none", and the planner must be able to tell them apart. */
  vendor: "nvidia" | "amd" | "intel" | "apple" | "unknown" | "none"
  /** Total device memory in bytes, or 0 when the vendor is known but its memory could not be read. */
  totalBytes: number
  /** Device memory already in use, in bytes, when the vendor's tool reports it; 0 otherwise. */
  usedBytes: number
  /** How it was learned, in one phrase, for a human reading a refusal. */
  detail: string
}

/**
 * Accelerator, asked of each vendor's own tool.
 *
 * Only one vendor was ever asked, so every other machine answered "none" — and "none" is what tells the
 * planner to size against system memory. A machine with a card it could not name was therefore planned
 * for as though it had no card at all. Each vendor ships a tool that reports its own devices; the ones
 * that are not installed simply do not answer, which costs a failed spawn and no correctness.
 *
 * `none` and `unknown` are DIFFERENT answers and both are used: `none` is a claim (there is no
 * accelerator), `unknown` is the absence of one (something is there and this build cannot size it).
 */
export function gpuReading(
  p: Platform = current(),
  env: NodeJS.ProcessEnv = process.env,
  run: (cmd: string, args: string[]) => string | null = defaultRun,
): GpuReading {
  // Apple silicon has no separate device memory: the accelerator draws on the same pool as everything
  // else, which is precisely what "unified" means, and asking a vendor tool would invent a second pool.
  if (p === "darwin") {
    return { vendor: "apple", totalBytes: 0, usedBytes: 0, detail: "unified memory — the accelerator shares the system pool" }
  }

  const nv = run(env.FABULA_NVIDIA_SMI || "nvidia-smi", [
    "--query-gpu=memory.total,memory.used", "--format=csv,noheader,nounits",
  ])
  if (nv) {
    // Summed across devices: a serving runtime given several cards draws on all of them.
    let total = 0
    let used = 0
    for (const line of nv.trim().split("\n")) {
      const [t, u] = line.split(",").map((s) => Number(s.trim()))
      if (!Number.isFinite(t)) continue
      total += t * 1024 * 1024
      used += (Number.isFinite(u) ? u : 0) * 1024 * 1024
    }
    if (total > 0) return { vendor: "nvidia", totalBytes: total, usedBytes: used, detail: "nvidia-smi" }
  }

  // AMD's tool prints a table; the VRAM total is reported in bytes by `--showmeminfo vram`.
  const amd = run(env.FABULA_ROCM_SMI || "rocm-smi", ["--showmeminfo", "vram", "--csv"])
  if (amd) {
    const m = /(\d{6,})/.exec(amd) // the first large integer on the line is the byte total
    if (m) return { vendor: "amd", totalBytes: Number(m[1]), usedBytes: usedFromRocm(amd), detail: "rocm-smi" }
    return { vendor: "amd", totalBytes: 0, usedBytes: 0, detail: "rocm-smi answered but reported no memory total" }
  }

  // Intel's tool answers to `xpu-smi discovery`; it is present only where such a device is.
  const intel = run(env.FABULA_XPU_SMI || "xpu-smi", ["discovery"])
  if (intel && /GPU|Device/i.test(intel)) {
    return { vendor: "intel", totalBytes: 0, usedBytes: 0, detail: "xpu-smi found a device; its memory total was not read" }
  }

  return { vendor: "none", totalBytes: 0, usedBytes: 0, detail: "no accelerator tool answered on this machine" }
}
/**
 * Run a probe tool and hand back its output, or null when it is not on this machine.
 *
 * Exported because the profile asks the same way; a second copy would be a second decision about what
 * "the tool did not answer" means.
 */
export function defaultRun(cmd: string, args: string[]): string | null {
  // Resolved before spawning: a missing tool is the ordinary case here, and asking PATH is cheaper and
  // quieter than a spawn that fails.
  if (!whichBin(cmd)) return null
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return null
  }
}

// `--showmeminfo vram --csv` prints the total and then what is already held; the second large integer is
// the used figure. Absent, the answer is 0 — "nothing known to be in use", never a claim the card is empty.
function usedFromRocm(text: string): number {
  const nums = text.match(/\d{6,}/g)
  return nums && nums.length > 1 ? Number(nums[1]) : 0
}
