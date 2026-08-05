// HOW MANY CALLS MAY REACH THE MODEL AT ONCE — measured on this machine, never inherited from another.
//
// The number in use is 1, and it was chosen from a real measurement: on a 48 GB Mac two concurrent
// requests took 48.4s against 41.9s for the same pair run one after the other, because concurrent
// prefill degrades BOTH rather than overlapping them. That conclusion is sound for that machine. It is
// not a fact about every machine: a host with two accelerators, or one whose serving runtime batches
// prefill properly, can genuinely answer differently, and this harness never asked how many cores the
// machine has at all.
//
// So the working point is treated the way the per-token cost already is (`kvcost.ts`): not written into
// the code, DERIVED from a measurement taken here and written down. Three answers, in order:
//
//   1. What the operator set. A named choice is a decision, and the harness never overrides one.
//   2. What was measured ON THIS MACHINE, keyed by its hardware fingerprint.
//   3. One — declared as the unmeasured conservative floor, not as a result.
//
// The third is deliberately not a guess dressed as an answer: a slot the admission gate never uses buys
// no concurrency and takes window away from the request that IS running, so erring low costs latency in
// a case that may not exist, while erring high costs memory in every case.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { dataDir } from "./platform/paths"

/** One paired observation: the same work, run at a given slot count, and what it cost. */
export interface ConcurrencySample {
  /** Hardware this was taken on. A sample from another machine is not evidence about this one. */
  fingerprint: string
  slots: number
  /** Wall-clock per call, averaged over the run. Lower is better; the units only have to be consistent. */
  msPerCall: number
  /** How many calls the average is over. One call is an anecdote. */
  calls: number
}

export interface ConcurrencyStore {
  samples: ConcurrencySample[]
}

/** Below this many calls a working POINT is an anecdote, however those calls arrived. */
export const MIN_CALLS_FOR_A_SAMPLE = 4

/**
 * A measurable difference. Below it the two slot counts are the same answer with noise on top, and the
 * lower one wins — because equal speed at more slots is strictly worse: it costs window for nothing.
 */
export const MEANINGFUL_GAIN = 0.1

/**
 * Which slot count this machine actually prefers, from its own paired samples.
 *
 * Returns null when there is nothing to conclude: fewer than two slot counts measured, or samples too
 * thin to be evidence. Null means "not measured", which the caller reports as such rather than turning
 * into a number.
 */
export function bestSlots(samples: readonly ConcurrencySample[], fingerprint: string): number | null {
  const mine = samples.filter((s) => s.fingerprint === fingerprint && s.msPerCall > 0 && s.calls > 0)
  if (mine.length === 0) return null
  // Weighted by how many calls each reading covers, and the evidence bar is on the POINT rather than on
  // one reading: a working point is measured by however many calls have landed on it, whether that came
  // as one long run or as eight ordinary ones. Putting the bar inside a single reading would have made
  // the harness's own free measurement — one real request at a time — permanently inadmissible.
  const bySlots = new Map<number, { total: number; calls: number }>()
  for (const s of mine) {
    const cur = bySlots.get(s.slots) ?? { total: 0, calls: 0 }
    bySlots.set(s.slots, { total: cur.total + s.msPerCall * s.calls, calls: cur.calls + s.calls })
  }
  const points = [...bySlots.entries()]
    .filter(([, v]) => v.calls >= MIN_CALLS_FOR_A_SAMPLE)
    .map(([slots, v]) => ({ slots, ms: v.total / v.calls }))
    .sort((a, b) => a.slots - b.slots)
  if (points.length < 2) return null // one point is not a comparison
  let winner = points[0]!
  for (const p of points.slice(1)) {
    // A higher slot count has to EARN its window: it wins only by a margin, never by a hair.
    if (p.ms < winner.ms * (1 - MEANINGFUL_GAIN)) winner = p
  }
  return winner.slots
}

/**
 * The working point, in the order that respects who decided what.
 *
 * `envSlots` is whatever the operator named, already parsed. `0` at the gate means "unlimited", which is
 * not a provisioning a machine can be sized for — the honest reading of it is one slot, and the gate
 * still admits more.
 */
export function resolveSlots(input: {
  envSlots?: number
  samples?: readonly ConcurrencySample[]
  fingerprint: string
}): { slots: number; source: "operator" | "measured" | "unmeasured-floor" } {
  const named = Math.floor(Number(input.envSlots))
  if (Number.isFinite(named) && named > 0) return { slots: named, source: "operator" }
  const measured = bestSlots(input.samples ?? [], input.fingerprint)
  if (measured && measured > 0) return { slots: measured, source: "measured" }
  return { slots: 1, source: "unmeasured-floor" }
}

/** One line for a human, naming WHERE the number came from — the thing a bare integer cannot say. */
export function describeSlots(r: { slots: number; source: string }): string {
  if (r.source === "operator") return `${r.slots} (set explicitly)`
  if (r.source === "measured") return `${r.slots} (measured on this machine)`
  return `${r.slots} (not measured here — the conservative floor, since an unused slot costs window)`
}

// ── The store ──────────────────────────────────────────────────────────────────────────────────────

export function concurrencyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.FABULA_CONCURRENCY_FILE || path.join(dataDir(env), "concurrency.json")
}

export function readSamples(env: NodeJS.ProcessEnv = process.env): ConcurrencySample[] {
  try {
    const file = concurrencyPath(env)
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ConcurrencyStore
    return Array.isArray(parsed?.samples) ? parsed.samples : []
  } catch {
    return [] // an unreadable store is no evidence, never bad evidence
  }
}

/** Append a sample. Atomic, because a half-written store read as a whole one is worse than none. */
export function recordSample(sample: ConcurrencySample, env: NodeJS.ProcessEnv = process.env): void {
  // A reading is admitted whenever it is a reading at all. Whether it amounts to EVIDENCE is decided
  // where the comparison is made, over everything landing on the same working point.
  if (!(sample.calls > 0) || !(sample.msPerCall > 0) || !sample.fingerprint) return
  try {
    const file = concurrencyPath(env)
    const samples = readSamples(env)
    samples.push(sample)
    // Bounded, and the bound is declared: the last hundred readings are plenty of evidence, and a store
    // that grows without limit is a store nobody notices going wrong.
    const kept = samples.slice(-100)
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ samples: kept }, null, 2))
    renameSync(tmp, file)
  } catch { /* an unwritable store costs a measurement, never correctness */ }
}
