// W7 — the only honest way to ask whether memory helps.
//
// Every published number this wave read is unusable here, and the reasons are worth stating because they
// are what this file is built to avoid:
//
//   • The benchmark most memory papers report on has an independently audited answer key that is ~6.4%
//     wrong, and the model it uses for grading accepted ~63% of intentionally wrong but topically adjacent
//     answers — precisely the failure mode of weak retrieval, which the benchmark then rewards.
//   • Rankings REVERSE across backbone models, and swapping only the embedding model in an otherwise
//     identical pipeline moved accuracy 6.2 points (p=0.004) and reordered systems. Most claimed
//     architectural gains are smaller than that confound.
//   • Strict token-F1 and model-graded scoring disagreed by 27.5 points on identical outputs.
//   • And the failure that matters most for a long-running harness is invisible to all of them: systems
//     get WORSE as they remember more. Measuring once, early, reports the best moment of a curve that
//     bends down later.
//
// So: real tasks from this project's own repos (which also dodges the training-contamination problem —
// one model family scores 3× better on a public SWE benchmark than on held-out equivalents, and 6× better
// at locating edited files, which is recall of training data rather than skill). Outcome decided by the
// project's existing verifier, never by a model. Paired, same seed, same fixed embedder. Reported as a
// curve against store size.
//
// THE NOISE ARM IS NOT OPTIONAL. Without it, "memory hurts" is undetectable: arms A and B alone can only
// show memory helping or doing nothing, never that a store full of plausible-but-irrelevant entries drags
// the run down — and the measured dose-response there is steep (65.1% clean → 32.5% fully noised).

/**
 * WHERE the curve is measured — declared up front, not bucketed after the fact.
 *
 * Post-hoc bucketing of whatever store sizes happened to occur is how a bend gets missed: runs cluster
 * wherever the store happened to be, and a downturn past that cluster is simply never sampled. Naming the
 * axis in advance also makes the experiment pre-registered in the only way that matters here — the sizes
 * cannot be chosen after seeing which ones look good.
 *
 * 0 is the floor (equivalent to the `none` arm and a consistency check on it); the rest span the range
 * where saturation has been reported to appear.
 */
export const STORE_SIZES = [0, 25, 100, 400, 1600] as const

/** The three arms. Dropping any one of them makes the result uninterpretable, for the reason on each. */
export const ARMS = [
  {
    name: "none",
    note: "no memory at all — the floor. Without it there is nothing to compare against.",
    outcome: "verifier-decided: resolved iff the project's own check fails on base and passes on the patch (exit code), never a model's opinion",
    // Measured at one point by definition: an empty store has no size to sweep.
    storeSizes: [0],
  },
  {
    name: "memory",
    note: "memory as the harness would really serve it.",
    outcome: "verifier-decided: resolved iff the project's own check fails on base and passes on the patch (exit code), never a model's opinion",
    // Each arm declares WHERE it is measured, and the axis is part of the arm rather than a comment,
    // because a size axis that lives only in prose is one nobody runs.
    storeSizes: STORE_SIZES,
  },
  {
    name: "noised",
    note:
      "memory with a fraction of entries replaced by plausible-but-irrelevant ones — the arm that makes " +
      "'memory HURTS' detectable. Omit it and the experiment can only ever find help or indifference.",
    outcome: "verifier-decided: resolved iff the project's own check fails on base and passes on the patch (exit code), never a model's opinion",
    storeSizes: STORE_SIZES,
  },
] as const

export type ArmName = (typeof ARMS)[number]["name"]


/** One run. `resolved` comes from the verifier — never from a model, and never from a similarity score. */
export interface RunRecord {
  task: string
  arm: ArmName
  seed: number
  /** the verifier's binary verdict: fail-on-base AND pass-on-gold, the same gate the harness already uses */
  resolved: boolean
  /** how many entries were in the store for this run — the x-axis of the curve */
  storeSize: number
  tokens: number
  ms: number
  /** recorded so a later reader can prove the confound was held fixed rather than assume it */
  embedder: string
}

/**
 * McNemar's EXACT test over the paired outcomes.
 *
 * Exact rather than the chi-square approximation because the discordant counts here are small — dozens of
 * tasks, not thousands — and the approximation is unreliable in exactly that regime. Two-sided, computed
 * from the binomial tail with p=0.5: under the null, each discordant pair is a coin flip.
 *
 * `b` = tasks the memory arm resolved and the no-memory arm did not.
 * `c` = tasks the no-memory arm resolved and the memory arm did not.
 * Concordant pairs carry no information about the difference and are correctly ignored.
 */
export function mcnemar(b: number, c: number): number {
  const B = Math.max(0, Math.floor(Number(b) || 0))
  const C = Math.max(0, Math.floor(Number(c) || 0))
  const n = B + C
  if (n === 0) return 1 // no discordant pairs: nothing distinguishes the arms
  // Two-sided exact: 2 × P(X ≤ min(b,c)) under Binomial(n, 0.5), clamped at 1.
  const k = Math.min(B, C)
  let tail = 0
  // Pascal's triangle rather than factorials — n stays small and this cannot overflow into Infinity/NaN
  // the way n! does past 170, which would silently turn a p-value into garbage.
  let row = [1]
  for (let i = 1; i <= n; i++) {
    const next = [1]
    for (let j = 1; j < i; j++) next.push(row[j - 1]! + row[j]!)
    next.push(1)
    row = next
  }
  for (let i = 0; i <= k; i++) tail += row[i]!
  const p = (2 * tail) / Math.pow(2, n)
  return Math.min(1, p)
}

export interface PairedResult {
  b: number
  c: number
  p: number
  /** how many tasks contributed a pair at all */
  pairs: number
  note: string
}

/** Pair the `none` and `memory` arms task by task and test them. */
export function paired(records: RunRecord[], armA: ArmName = "none", armB: ArmName = "memory"): PairedResult {
  const byTask = new Map<string, Partial<Record<ArmName, boolean>>>()
  for (const r of records || []) {
    if (!r || typeof r !== "object") continue
    const cur = byTask.get(r.task) ?? {}
    cur[r.arm] = !!r.resolved
    byTask.set(r.task, cur)
  }
  let b = 0
  let c = 0
  let pairs = 0
  for (const [, v] of byTask) {
    if (typeof v[armA] !== "boolean" || typeof v[armB] !== "boolean") continue
    pairs++
    if (v[armB] && !v[armA]) b++
    else if (v[armA] && !v[armB]) c++
  }
  const p = mcnemar(b, c)
  return {
    b,
    c,
    p,
    pairs,
    note:
      pairs === 0
        ? "no task ran in both arms — nothing is comparable yet"
        : `${pairs} paired task(s); ${b} resolved only with memory, ${c} only without; two-sided exact p=${p.toFixed(4)}`,
  }
}

/**
 * The CURVE, not the point.
 *
 * A system that remembers more can get worse — sustained influx degrades retrieval and reasoning, and a
 * single measurement taken early reports the best moment of a curve that later bends down. Bucketing by
 * store size is what makes that visible.
 */
export function curve(records: RunRecord[], edges: readonly number[] = STORE_SIZES): Array<{ storeSize: number; n: number; resolved: number; rate: number | null }> {
  // Bucket by the DECLARED sizes, not by equal-width bins computed after the fact. Post-hoc bucketing
  // defeated the whole point: with five declared sizes and four equal-width bins, a real run collapsed
  // into TWO rows (≈0 and ≈1203), so a bend anywhere between 25 and 400 was structurally invisible —
  // and saturation, the failure where a system gets worse as it remembers more, lives exactly there.
  // Declaring the edges up front is what makes the curve comparable across runs at all.
  const rows = (records || []).filter((r) => r && typeof r === "object" && r.arm === "memory")
  if (!rows.length) return []
  const bounds = [...edges].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  const out: Array<{ storeSize: number; n: number; resolved: number; rate: number | null }> = []
  for (let k = 0; k < bounds.length; k++) {
    const lo = bounds[k]!
    const hi = k + 1 < bounds.length ? bounds[k + 1]! : Infinity
    const inBucket = rows.filter((r) => {
      const v = Number(r.storeSize) || 0
      return v >= lo && v < hi
    })
    if (!inBucket.length) continue
    const resolved = inBucket.filter((r) => r.resolved).length
    out.push({ storeSize: lo, n: inBucket.length, resolved, rate: resolved / inBucket.length })
  }
  return out
}


export interface Report {
  arms: typeof ARMS
  paired: PairedResult
  hurt: PairedResult
  curve: ReturnType<typeof curve>
  embedders: string[]
  warnings: string[]
}

/**
 * The whole report, including the warnings that make it readable rather than quotable.
 *
 * A result computed over a varying embedder is a measurement OF the embedder, so that is checked and said
 * out loud rather than left for a reader to notice.
 */
export function report(records: RunRecord[]): Report {
  const embedders = Array.from(new Set((records || []).map((r) => String(r?.embedder ?? "")).filter(Boolean)))
  const warnings: string[] = []
  if (embedders.length > 1) {
    warnings.push(
      `the embedding model VARIED across runs (${embedders.join(", ")}). Swapping only the embedder has been ` +
        `measured to move accuracy 6.2 points and reorder systems, which is larger than most effects this ` +
        `experiment could find — hold it fixed or this number is about the embedder.`,
    )
  }
  const arms = new Set((records || []).map((r) => r?.arm))
  if (!arms.has("noised")) {
    warnings.push(
      `the NOISE arm is missing: without it this experiment cannot detect memory HURTING, only helping or ` +
        `doing nothing.`,
    )
  }
  const p = paired(records)
  if (p.pairs > 0 && p.pairs < 30) {
    warnings.push(`${p.pairs} paired task(s) is a small sample; an exact test is honest about that, a reader may not be.`)
  }
  return { arms: ARMS, paired: p, hurt: paired(records, "memory", "noised"), curve: curve(records), embedders, warnings }
}

// ── the runner ─────────────────────────────────────────────────────────────────────────────────────
//
// These functions existed with NO caller, which an independent verifier flagged precisely because it is
// the failure this project has been caught by before: an apparatus that cannot be invoked measures
// nothing, however correct its arithmetic. It was right, and silent.
//
//   bun scripts/memory-ab.ts <records.jsonl>   — aggregate a real run
//   bun scripts/memory-ab.ts --schema          — print the record shape a runner must emit
//
// It deliberately will NOT invent data. Records come from executing a real task under a real arm and
// reading the VERIFIER's binary outcome; a curve drawn from synthetic records would look exactly like
// evidence and be none.

/** One JSONL line per run. `resolved` is the verifier's, never a model's. */
export const RECORD_SCHEMA = {
  task: "string — stable id, identical across arms",
  arm: `one of ${ARMS.map((a) => a.name).join(" | ")}`,
  seed: "number — identical across arms for the same task, or the pairing means nothing",
  resolved: "boolean — decided by the verifier (fail-on-base + pass-on-gold), never by a judge model",
  storeSize: "number — records the memory store held when the run started",
  tokens: "number",
  ms: "number",
}

export function loadRecords(text: string): RunRecord[] {
  const out: RunRecord[] = []
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line)
      if (o && typeof o.task === "string" && typeof o.arm === "string" && typeof o.resolved === "boolean") out.push(o as RunRecord)
    } catch {
      // A torn line is skipped rather than fatal: a partial run is still evidence about the runs that did
      // complete, and discarding all of it would throw away the measurement to punish the file.
    }
  }
  return out
}

export function renderReport(r: Report): string {
  // Read the shape rather than assume it: the first version of this renderer printed `r.records` and
  // `r.tasks`, which `Report` does not have, so the header read "records: undefined · tasks: undefined"
  // above numbers that were perfectly correct. A report whose header is wrong invites the reader to
  // distrust the part that is right.
  const lines: string[] = []
  const p = r.paired
  // DISCORDANT pairs, named as such. The previous line summed fields `PairedResult` does not have and
  // printed the discordant count under the label "paired tasks" — a header that disagreed with the
  // warning three lines below it. The comment above this function says a wrong header invites distrust of
  // the parts that are right; it was itself the thing being distrusted.
  lines.push(`discordant pairs: ${p.b + p.c}  ·  arms: ${r.arms.map((a) => a.name).join(", ")}`)
  lines.push(
    `none → memory:  b=${p.b} c=${p.c}  p=${p.p === null ? "undefined (no discordant pairs)" : p.p.toFixed(4)}` +
      `  ${p.p !== null && p.p < 0.05 ? "significant" : "NOT significant"}`,
  )
  lines.push(`memory → noised:  b=${r.hurt.b} c=${r.hurt.c}  p=${r.hurt.p === null ? "undefined" : r.hurt.p.toFixed(4)}  (does memory HURT when polluted?)`)
  if (r.embedders.length > 1) lines.push(`⚠ ${r.embedders.length} different embedders across arms — swapping one alone moves accuracy more than most mechanisms do`)
  lines.push("")
  lines.push("outcome as a function of store size — the curve, not a point:")
  for (const b of r.curve) {
    lines.push(
      // Label the BUCKET, not a pretend observation: "≈0" over records of size 10 reads as an observed
      // store size to anyone who did not write this line.
      `  store ${String(b.storeSize).padStart(5)}+   n=${String(b.n).padStart(4)}  resolved=${b.resolved}  ` +
        `rate=${b.rate === null ? "—" : (b.rate * 100).toFixed(1) + "%"}`,
    )
  }
  if (r.curve.length < 2) {
    lines.push("  (fewer than two buckets — one measurement cannot show saturation, the failure where a")
    lines.push("   system gets WORSE as it remembers more.)")
  }
  for (const w of r.warnings ?? []) lines.push(`⚠ ${w}`)
  return lines.join("\n")
}

if (import.meta.main) {
  const arg = process.argv[2]
  if (!arg || arg === "--help" || arg === "-h") {
    console.log("usage: bun scripts/memory-ab.ts <records.jsonl>   ·   --schema prints the record shape")
    process.exit(arg ? 0 : 1)
  } else if (arg === "--schema") {
    console.log(JSON.stringify(RECORD_SCHEMA, null, 2))
  } else {
    const fs = require("node:fs") as typeof import("node:fs")
    if (!fs.existsSync(arg)) {
      console.error(`no such records file: ${arg}`)
      console.error("Nothing is aggregated from thin air — run the arms first, one JSONL line per run.")
      process.exit(2)
    }
    const records = loadRecords(fs.readFileSync(arg, "utf8"))
    if (!records.length) {
      console.error("the file parsed but held no usable records — has any arm actually run?")
      process.exit(3)
    }
    console.log(renderReport(report(records)))
  }
}
