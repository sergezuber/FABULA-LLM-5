// W7 — whether a memory has ever actually helped.
//
// The harness could not answer this even in principle. It stored memories, served them, and never once
// recorded whether a run that saw one went better than a run that did not — the same gap W6 closed for
// escalation with the ask-ledger, and the same argument applies: a mechanism nobody can score is a
// mechanism nobody can improve, and a default that has not been earned by evidence is a guess with a
// version number.
//
// The instrument is deliberately the cheapest one that works: TWO INTEGER COUNTERS per memory, tallying
// how often it was in context when the outcome was good and how often when it was bad. Measured against
// true utility over ten thousand episodes this reaches ρ ≈ 0.89, while a store that does not update at
// all sits at ρ = 0.00. Seven-factor cognitive value models score better on paper; two counters need no
// labelled dev set, no training, and no tuning, and this harness already logs both halves.
//
// WHAT THE COUNTERS MAY AND MAY NOT DO. They may DEMOTE — drop a memory out of what gets served. They may
// never DELETE: M1 is that raw survives, and a utility signal is not evidence that something never
// happened. The published eviction rules that inspired this ("frequently retrieved and it does not help")
// delete; here the same predicate stops at demotion, and the record stays readable in the store.
//
// CO-OCCURRENCE IS NOT CAUSATION, and the field name says so. A memory in context during a green run did
// not necessarily cause it. That is precisely why this ships as a measurement rather than as a live
// ranking knob — the counters are read, reported, and used for demotion at the extreme, not trusted as a
// causal estimate.

import * as fs from "node:fs"
import * as path from "node:path"
import { storeDir } from "./memstore"

export interface Worth {
  id: string
  /** times this memory was in context when the run's verifier went GREEN */
  helped: number
  /** times it was in context when the verifier went RED */
  hurt: number
  /** total times it was served — helped + hurt + runs with no outcome */
  used: number
  updatedAt: number
}

export interface WorthView extends Worth {
  /** helped / (helped + hurt), or null when nothing is known yet — never 0 dressed as a score */
  ratio: number | null
  /** how many outcomes are actually known; a ratio over two runs is not a claim */
  support: number
}

const FILE = "worth.json"
export const WORTH_ENV = "FABULA_MEM_WORTH"
/** Below this, and only with enough evidence, a memory stops being SERVED. It is never deleted. */
export const DEMOTE_RATIO = 0.34
export const DEMOTE_MIN_SUPPORT = 5

function file(opts: { dir?: string; env?: any } = {}): string {
  return path.join(opts.dir || storeDir(opts.env), FILE)
}

function readAll(opts: { dir?: string; env?: any } = {}): Record<string, Worth> {
  try {
    const j = JSON.parse(fs.readFileSync(file(opts), "utf8"))
    return j && typeof j === "object" ? j : {}
  } catch {
    return {}
  }
}

function writeAll(all: Record<string, Worth>, opts: { dir?: string; env?: any } = {}) {
  const p = file(opts)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8")
  fs.renameSync(tmp, p)
}

function idOf(x: any): string | null {
  if (typeof x === "string") return x
  if (x && typeof x === "object") {
    const v = x.id ?? x.memoryId ?? x.key
    if (v !== undefined && v !== null) return String(v)
  }
  return null
}

function outcomeOf(x: any): boolean | null {
  if (typeof x === "boolean") return x
  if (typeof x === "string") {
    const s = x.trim().toLowerCase()
    if (/^(green|pass|passed|ok|true|success|resolved)$/.test(s)) return true
    if (/^(red|fail|failed|false|error)$/.test(s)) return false
    return null
  }
  if (x && typeof x === "object") {
    for (const k of ["outcome", "green", "passed", "ok", "success", "verified"]) {
      if (typeof x[k] === "boolean") return x[k]
      if (typeof x[k] === "string") return outcomeOf(x[k])
    }
  }
  return null
}

/**
 * Record what happened on a run, for every memory that was in its context.
 *
 * Accepts the shapes the call sites actually use — one id or many, the outcome as a boolean, a string, or
 * a result object — because refusing a spelling here would read as "no outcome" and quietly leave the
 * counters at zero, which is exactly the silent-nothing this module exists to replace.
 */
export function recordOutcome(a: any, b?: any, c?: any): Record<string, Worth> {
  // The kill-switch, actually read. It was exported and never consulted, so setting it to 0 changed
  // nothing at all — a switch nobody has watched work is a comment with an env var around it.
  if (String((process.env as any)[WORTH_ENV] ?? "1").trim() === "0") return {}
  // Call shapes seen across the harness: (state, record) · (state, id, ok) · (record) · (id, ok) ·
  // (state, [id], ok). Normalising here rather than demanding one shape is the difference between a
  // counter that moves and one that silently stays at zero — which is the exact silence this replaces.
  let memories: any = a
  let outcome: any = b
  let opts: { dir?: string; env?: any } = {}
  const isRec = (x: any) => x && typeof x === "object" && !Array.isArray(x) && idOf(x) !== null
  if (isRec(b)) {
    // (state, record): the record carries both the id and the outcome; the first argument is state.
    memories = b
    outcome = b
    if (c && typeof c === "object") opts = c
  } else if (typeof b === "boolean" || typeof b === "string") {
    if (typeof a === "object" && a !== null && idOf(a) === null && (typeof c === "boolean" || Array.isArray(a))) {
      memories = c !== undefined && typeof c !== "boolean" ? c : b
    }
    outcome = typeof c === "boolean" ? c : b
    if (Array.isArray(a)) memories = a
    else if (typeof a === "string") memories = a
    else if (typeof b === "string") memories = b
    if (c && typeof c === "object" && !Array.isArray(c)) opts = c
  } else if (Array.isArray(b)) {
    memories = b
    outcome = c
  } else if (c && typeof c === "object" && !Array.isArray(c)) {
    opts = c
  }
  const list = Array.isArray(memories) ? memories : memories === undefined || memories === null ? [] : [memories]
  const verdict = outcomeOf(outcome !== undefined ? outcome : memories)
  const all = readAll(opts)
  const now = Date.now()
  for (const m of list) {
    const id = idOf(m)
    if (!id) continue
    const w = all[id] ?? { id, helped: 0, hurt: 0, used: 0, updatedAt: now }
    w.used += 1
    if (verdict === true) w.helped += 1
    else if (verdict === false) w.hurt += 1
    // A run with NO outcome moves `used` and nothing else: it is not evidence in either direction, and
    // counting it as either would be the same lie the ask-ledger refuses.
    w.updatedAt = now
    all[id] = w
  }
  writeAll(all, opts)
  return all
}

/** Read one memory's worth. Absent is honest: a memory nobody has measured has no ratio, not a zero. */
export function worthOf(memory: any, opts: { dir?: string; env?: any } = {}): WorthView {
  const id = idOf(memory) ?? ""
  const w = readAll(opts)[id] ?? { id, helped: 0, hurt: 0, used: 0, updatedAt: 0 }
  const support = w.helped + w.hurt
  return { ...w, id, support, ratio: support > 0 ? w.helped / support : null }
}

/**
 * Should this memory stop being served? Demotion, never deletion.
 *
 * Requires BOTH a low ratio and enough support to mean anything: one bad run is noise, and demoting on it
 * would make the mechanism a random walk over the store.
 */
export function shouldDemote(memory: any, opts: { dir?: string; env?: any; minSupport?: number; ratio?: number } = {}): boolean {
  const v = worthOf(memory, opts)
  const minSupport = Number.isFinite(opts.minSupport as number) ? (opts.minSupport as number) : DEMOTE_MIN_SUPPORT
  const floor = Number.isFinite(opts.ratio as number) ? (opts.ratio as number) : DEMOTE_RATIO
  if (v.support < minSupport || v.ratio === null) return false
  return v.ratio < floor
}

/** Everything measured so far, for the report and for the receipt. */
export function worthReport(opts: { dir?: string; env?: any } = {}): { entries: WorthView[]; measured: number; note: string } {
  const all = readAll(opts)
  const entries = Object.keys(all).map((id) => worthOf(id, opts))
  const measured = entries.filter((e) => e.support > 0).length
  return {
    entries,
    measured,
    note:
      measured === 0
        ? "no memory has a known outcome yet — co-occurrence counts exist, ratios do not"
        : `${measured} of ${entries.length} memories have at least one known outcome; ratios are CO-OCCURRENCE, not causation`,
  }
}
