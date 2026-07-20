// W6 — a quality estimate ahead of a DOOMED RETRY (arXiv:2606.27457, cluster-route-escalate).
//
// The paper puts a cheap estimator ahead of the expensive stage and routes a low-scoring candidate
// straight to escalation instead of paying for a cycle that will fail. Here the expensive stage is
// `verify_done`, which on a bench task means a full Docker suite measured in minutes.
//
// THE NARROWING, and why it is deliberate: we do NOT use this to skip a verify. Verify is the only
// source of truth in this harness — a skipped verify that WOULD have passed loses a real "done" and
// there is no way to get it back, while a wasted retry costs seconds. So the estimator gates only the
// next local RETRY after a red: when another attempt on this diff looks not worth its cost, the harness
// escalates NOW rather than burning the cycle. A verify itself is never blocked, by anything, ever.
//
// The consequence, stated rather than hidden: since the only action is "escalate now", on an install
// with no cloud provider configured this changes nothing at all. The saving exists where escalation has
// somewhere to go.

import { callAux } from "./auxLLM"

export type QeVerdict = "not-worth-retrying" | "worth-retrying" | "unknown"

export interface QeResult {
  verdict: QeVerdict
  /** why, in one line — this ends up in the ledger next to the decision it informed */
  reason: string
  /** true only when an aux model actually answered; a heuristic-only verdict says so */
  fromModel: boolean
}

/** Anything the caller can hand us as "what happened so far". Shapes vary across call sites, so the
 *  reader is deliberately generous and treats an unreadable history as "no evidence". */
type HistoryLike =
  | Array<{ green?: boolean; passed?: boolean; ok?: boolean; type?: string; [k: string]: unknown }>
  | { events?: unknown[]; [k: string]: unknown }
  | null
  | undefined

function eventsOf(h: HistoryLike): Array<Record<string, unknown>> {
  if (Array.isArray(h)) return h as Array<Record<string, unknown>>
  if (h && typeof h === "object" && Array.isArray((h as { events?: unknown[] }).events))
    return (h as { events: unknown[] }).events as Array<Record<string, unknown>>
  return []
}

/** How many verify events in this history were RED. A history with no red verify has nothing to gate. */
export function redVerifies(h: HistoryLike): number {
  let n = 0
  for (const e of eventsOf(h)) {
    if (!e || typeof e !== "object") continue
    const isVerify = e.type === undefined || /verify/i.test(String(e.type ?? ""))
    if (!isVerify) continue
    const green = e.green ?? e.passed ?? e.ok
    if (green === false) n++
  }
  return n
}

const KEEP: QeResult = { verdict: "worth-retrying", reason: "", fromModel: false }

function keep(reason: string): QeResult {
  return { ...KEEP, reason }
}

/**
 * Estimate whether ANOTHER LOCAL RETRY on this diff is worth its cost.
 *
 * Fail-open in every direction that matters:
 *   - no red verify in the history → never actionable. Nothing has failed, so there is nothing to gate,
 *     and an estimator that could veto a first attempt would be a way to never start work at all.
 *   - the aux model is unreachable, slow, or returns something unparseable → "worth retrying". The
 *     estimator NEVER rejects and never blocks on its own failure; a broken estimator must cost nothing.
 */
export async function qeVerdict(diff: string, history?: HistoryLike, opts: { timeoutMs?: number } = {}): Promise<QeResult> {
  const reds = redVerifies(history)
  if (reds < 1) {
    return keep("no failed verification yet — nothing to gate; a retry is by definition worth trying.")
  }
  const text = String(diff ?? "").slice(0, 6000)
  if (!text.trim()) {
    return keep("no diff to estimate — keeping the attempt local.")
  }

  let answer = ""
  const budgetMs = Math.min(opts.timeoutMs ?? 8000, 8000)
  const deadline = new Promise<null>((r) => setTimeout(() => r(null), budgetMs))
  try {
    // Route through the ADAPTER, not straight at the model server. `auxChain` defaults to LM Studio on
    // :1234, which is the same GPU the agent is generating on and BEHIND the admission gate this project
    // added precisely because concurrent prefill collapses throughput here. A quality estimate that
    // sidesteps the queue competes with the very turn it is advising.
    const res = await Promise.race([deadline, callAux(
      [
        "You are estimating whether ANOTHER local attempt at this change is worth its cost.",
        `The project's tests have already failed ${reds} time(s) in a row on this work.`,
        "Answer with exactly one word: WORTH if another local attempt is likely to succeed, or DOOMED if",
        "this approach looks fundamentally wrong and a second opinion from a stronger model is the better",
        "next step. Answer with the single word only.",
        "",
        "--- current change ---",
        text,
      ].join("\n"),
      {
        maxTokens: 8,
        // A HARD end-to-end bound. `callAux` retries and walks a chain of endpoints, so a per-request
        // timeout is not a per-call one: measured at 16.6s against a single hung endpoint, ~50s worst
        // case, inside a hook whose sibling escalation is capped at 8s with the note that a blocked turn
        // must cost seconds. The estimator is advice; it does not get to hold the turn longer than the
        // second opinion it might ask for.
        timeoutMs: budgetMs,
      },
    )])
    if (res === null) return keep(`quality estimate exceeded its ${budgetMs}ms budget — keeping the attempt local.`)
    answer = String(res?.text ?? "")
  } catch (e) {
    // The whole point of fail-open: an estimator that is down must be indistinguishable from an
    // estimator that said "keep trying". It must never propagate its own failure into the run.
    return keep(`quality estimate unavailable (${(e as Error)?.message ?? "error"}) — keeping the attempt local.`)
  }

  const s = answer.toLowerCase()
  if (/\bdoomed\b|\bhopeless\b|\bnot worth\b|\bfutile\b/.test(s)) {
    return {
      verdict: "not-worth-retrying",
      reason: `after ${reds} failed verification(s) the estimate is that another local attempt is not worth its cost.`,
      fromModel: true,
    }
  }
  if (/\bworth\b|\bretry\b|\blikely\b|\byes\b/.test(s)) {
    return { verdict: "worth-retrying", reason: "the estimate is that another local attempt is worth trying.", fromModel: true }
  }
  // Unrecognised answer is NOT a negative. An estimator that cannot be understood has said nothing.
  return { verdict: "unknown", reason: `the estimate could not be read (${JSON.stringify(answer.slice(0, 40))}) — keeping the attempt local.`, fromModel: true }
}

/** Does this verdict actually gate the next retry? Only an explicit negative does. */
export function qeBlocksRetry(v: QeResult | QeVerdict | null | undefined): boolean {
  const verdict = typeof v === "string" ? v : v?.verdict
  return verdict === "not-worth-retrying"
}
