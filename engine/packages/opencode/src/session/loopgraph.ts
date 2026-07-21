// W4 — the Agentic Loop Dependence Graph (ALDG) of this harness, plus a shared per-turn re-entry budget.
//
// arXiv:2607.01641 (IAL-Scan): Infinite Agentic Loops are a distinct failure class that arises from agent
// logic + FRAMEWORK semantics + termination mechanisms — not from ordinary code loops. The remedy is to
// enumerate the harness's OWN feedback edges as a graph, assert every edge is explicitly bounded, and bound
// their COMPOSITION.
//
// Audit result for FABULA (2026-07-19, numbers re-derived from source after a first audit was fact-checked
// and found materially wrong): the gaps this module closes are
//   1. the aggregate was never DECLARED. Each edge carries `cap` — the value actually read from source — so
//      the worst case is DERIVED (`sumOfCaps`), not asserted from memory: 31 re-entries with an explicit
//      `/goal`, 22 when the goal is auto-armed. Each one is a full model call on a prefill-bound socket;
//   2. nothing failed if a NEW edge was added without a bound — a silent IAL regression. RE_ENTRY_EDGES is
//      the single source of truth, and the test suite fails when a re-entering gate is missing from it.
//
// The composition was NOT always a sum: `taskGate` used to clear its own counter from BOTH of its
// non-re-entry branches — cap-exceeded ("allow the stop") AND settled ("the board is empty") — re-arming
// the cap whenever another gate carried the turn forward, which made the bounds compose as a
// PRODUCT. That reset now lives at the real turn boundary (SessionPrompt.prompt) — see
// test/task/gate-reentry-invariant.test.ts, the durable guard against it coming back.
//
// ⚠️ STATUS — READ BEFORE CITING THIS MODULE. Two very different things live here:
//   * SHIPPED AND LOAD-BEARING: `RE_ENTRY_EDGES` (the declared graph + verified caps) and the guards built
//     on it. A new re-entering gate that is not registered fails the suite. This is real today.
//   * DECLARED, NOT WIRED: the shared budget (`reentryBudget` / `chargeReentry` / `renderBudgetExhausted` /
//     `DEFAULT_REENTRY_BUDGET`). NOTHING in the run loop calls them — `grep -rl loopgraph src/` finds no
//     production consumer. They bound nothing at runtime, and `FABULA_REENTRY_BUDGET` therefore changes no
//     behavior yet. Wiring them into the ~19 re-entry sites is deliberately a separate change.
// Do not describe the budget in live present tense until that wiring lands. (An independent verifier caught
// exactly that overstatement here.) When it is wired, the intent is an OUTER bound: per-edge caps fire
// first and stay untouched, so behavior is identical until the shared budget is actually spent, with
// FABULA_REENTRY_BUDGET=0 as the kill-switch.

export interface ReEntryEdge {
  /** stable id used when charging the budget */
  id: string
  /** the gate function in session/prompt.ts whose truthy result re-enters the turn */
  fn: string
  /** the per-turn counter that bounds this edge (a real `let` in prompt.ts), when it has one */
  counter?: string
  /** the env/flag that sets this edge's own cap, when it has one */
  boundEnv?: string
  /** this edge's DEFAULT per-turn cap = the maximum re-entries it can contribute, read from the source of
   *  truth named in `capSource`. Every value here is verified against live source, never remembered. */
  cap: number
  /** where `cap` was read from — so a reviewer can re-derive it instead of trusting this file */
  capSource: string
  /** how the LIVE code parses `boundEnv` — the engine uses three different parsers, and a model that
   *  assumed one of them would misreport the real cap:
   *   - "flagIntegerPositive": `flag.ts number()` — integer AND > 0, else the default
   *   - "finiteAtLeast1": finite AND >= 1, floored (the n-gram ladder)
   *   - "finiteNonNegative": finite AND >= 0, floored — 0 IS honored (verify / auto-goal) */
  capEnvParse?: "flagIntegerPositive" | "finiteAtLeast1" | "finiteNonNegative"
  /** re-entries CONTRIBUTED beyond the raw constant. Almost always 0 — the exception is the n-gram ladder,
   *  whose `TEXT_NGRAM_MAX_RECOVERY = 2` still carries the turn forward THREE times (remind/replan/wrapup)
   *  because only `attempts > max` terminates. Kept explicit so an env override scales correctly. */
  capLadderBonus?: number
  description: string
}

/** This edge's REAL cap under `env`. `cap` is only the default: 7 of the 9 bounds are env-overridable at
 *  runtime (`flag.ts` reads `process.env`), so a static sum would understate the legitimate worst case and
 *  the budget would truncate real work — exactly what the budget must never do. */
export function resolveEdgeCap(edge: ReEntryEdge, env: Record<string, string | undefined> = {}): number {
  // UNSET and EMPTY are different inputs to the live parsers: `Number(undefined)` is NaN (fall back to the
  // default) while `Number("")` is 0, which the `finiteNonNegative` parsers HONOR as a real cap of 0.
  const present = edge.boundEnv ? env[edge.boundEnv] : undefined
  const text = present === undefined ? undefined : present.trim()
  const raw = text === undefined ? Number.NaN : Number(text)
  const accepted =
    text !== undefined &&
    Number.isFinite(raw) &&
    (edge.capEnvParse === "finiteNonNegative"
      ? raw >= 0
      : edge.capEnvParse === "finiteAtLeast1"
        ? raw >= 1
        : text !== "" && Number.isInteger(raw) && raw > 0)
  const fromEnv = accepted ? Math.floor(raw) : undefined
  // The goal edge is the one with TWO regimes: MAX_GOAL_REACT (12) is a source literal for an explicit
  // `/goal` and is NOT env-settable, while FABULA_AUTO_GOAL_MAX moves only the auto-armed regime. The
  // worst case is whichever regime allows more.
  if (edge.id === "goal-judge") return Math.max(edge.cap, fromEnv ?? 0)
  if (fromEnv === undefined) return edge.cap
  return fromEnv + (edge.capLadderBonus ?? 0)
}

/** THE GRAPH. Every gate in session/prompt.ts whose result leads the run-loop to `continue` (or to
 *  `return "continue" as const`) must appear here. Adding a re-entering gate without registering it is an
 *  unbounded-loop regression, and the W4 suite fails on it. */
export const RE_ENTRY_EDGES: readonly ReEntryEdge[] = [
  {
    id: "text-tool-call-retry",
    fn: "autoRetryTextToolCall",
    counter: "textToolCallRetries",
    boundEnv: "MIMOCODE_TEXT_TOOL_CALL_RETRY_LIMIT",
    capEnvParse: "flagIntegerPositive",
    cap: 2,
    capSource: "flag.ts MIMOCODE_TEXT_TOOL_CALL_RETRY_LIMIT ?? 2",
    description: "the model emitted a tool call as plain text; retry the step asking for a real call",
  },
  {
    id: "invalid-structured-output",
    fn: "autoContinueInvalidOutput",
    counter: "invalidContinuations",
    boundEnv: "MIMOCODE_INVALID_OUTPUT_CONTINUATION_LIMIT",
    capEnvParse: "flagIntegerPositive",
    cap: 2,
    capSource: "flag.ts MIMOCODE_INVALID_OUTPUT_CONTINUATION_LIMIT ?? 2",
    description: "structured output did not satisfy the schema; re-enter asking for a valid object",
  },
  {
    id: "output-length-continuation",
    fn: "autoContinueOutputLength",
    counter: "outputLengthContinuations",
    boundEnv: "MIMOCODE_OUTPUT_LENGTH_CONTINUATION_LIMIT",
    capEnvParse: "flagIntegerPositive",
    cap: 3,
    capSource: "flag.ts MIMOCODE_OUTPUT_LENGTH_CONTINUATION_LIMIT ?? 3",
    description: "the turn hit the output-token limit mid tool-call; re-enter for complete arguments",
  },
  {
    id: "task-settle",
    fn: "taskGate",
    counter: "taskGateState",
    cap: 3,
    capSource: "task/gate.ts MAX_TASK_GATE_MAIN_REACT = 3",
    description:
      "incomplete background tasks; re-enter nudging `task done`. Bounded by the PERSISTED per-session taskGateState + MAX_TASK_GATE_MAIN_REACT (3). Its counter used to be cleared on the cap-exceeded branch, which re-armed the cap mid-turn and made the whole composition a PRODUCT; the reset now lives at the real turn boundary in SessionPrompt.prompt",
  },
  {
    id: "force-verify",
    fn: "autoContinueUnverified",
    counter: "unverifiedContinuations",
    boundEnv: "FABULA_VERIFY_CONTINUE_MAX",
    capEnvParse: "finiteNonNegative",
    cap: 2,
    capSource: "session/prompt.ts FABULA_VERIFY_CONTINUE_MAX default 2",
    description: "source was edited but never verified green; re-enter demanding verify_done",
  },
  {
    id: "goal-judge",
    fn: "goalGate",
    boundEnv: "FABULA_AUTO_GOAL_MAX",
    capEnvParse: "finiteNonNegative",
    cap: 12,
    capSource: "session/prompt.ts MAX_GOAL_REACT = 12 (explicit /goal; auto-armed is autoGoalCap = 3)",
    description:
      "the stop-condition judge (and the W3 trajectory hard-veto) refused the stop; re-enter. Bounded by the persisted goal react count (autoGoalCap for AUTO, MAX_GOAL_REACT for explicit /goal)",
  },
  {
    id: "structured-output-retry",
    fn: "autoRetryStructuredOutput",
    counter: "structuredRetries",
    cap: 2,
    capSource: "session/message-v2.ts format.retryCount default 2",
    description: "a structured-output call failed to produce an object; retry the step",
  },
  {
    id: "text-ngram-recovery",
    fn: "handleTextRepeat",
    counter: "textNgramRecoveryAttempts",
    cap: 3,
    capSource: "prompt/text-ngram-detection.ts TEXT_NGRAM_MAX_RECOVERY = 2 -> ladder remind/replan/wrapup re-enters 3x",
    boundEnv: "FABULA_NGRAM_MAX_RECOVERY",
    capEnvParse: "finiteAtLeast1",
    capLadderBonus: 1,
    description:
      "the assistant looped on an n-gram; inject a recovery steer and re-enter. Bounded by TEXT_NGRAM_MAX_RECOVERY — note the staged ladder (remind → replan → wrapup → terminate) allows THREE re-entries, not two",
  },
  {
    // No gate function: an inline block in the run loop that ends in a bare `continue`. The registry
    // covers it because an edge is an EDGE whether or not someone factored it into a function — a
    // function-shaped extractor alone would miss it (and did, until the audit was fact-checked).
    id: "text-loop-recovery-inline",
    fn: "(inline block — session/prompt.ts text-loop recovery, no gate function)",
    counter: "textLoopRecoveryAttempts",
    cap: 2,
    capSource: "prompt/text-loop-recovery.ts TEXT_LOOP_MAX_RECOVERY = 2",
    description:
      "the assistant repeated identical text; an inline recovery block injects a steer and re-enters. Bounded by TEXT_LOOP_MAX_RECOVERY (2)",
  },
  {
    id: "overflow-no-checkpoint-rebuild",
    fn: "(inline block — session/prompt.ts overflow router, no-checkpoint branch)",
    counter: "skipOverflowCheck",
    cap: 1,
    capSource:
      "prompt.ts overflow router: the inserted boundary raises skipOverflowCheck and resets thresholds; the next overflow requires genuinely new growth past a re-derived threshold, and the boundary itself trims the context — the same bound the pre-existing hasCheckpoint rebuild branch has always had",
    description:
      "context overflow in a session with NO checkpoint yet: instead of a minutes-long, abortable, hijackable model summarization (measured twice being killed mid-generation by an app restart), the harness inserts the model-free rebuild boundary (measured files-read ledger + recent asks) and continues. Model compaction remains for manual /compact and as last resort when the boundary cannot render",
  },
  {
    id: "compaction-failure-rescue",
    fn: "(inline block — session/prompt.ts compact branch, on compaction.process → stop)",
    counter: "compactionRescued",
    cap: 1,
    capSource:
      "prompt.ts compact branch: fires only while the last user message carries a compaction part; the inserted rebuild boundary REPLACES it as the last user message, so the same failure cannot re-enter twice — and an insert failure breaks the loop",
    description:
      "auto-compaction failed (summarizer hijacked twice → visible error); the harness inserts a model-free rebuild boundary (measured files-read ledger + recent asks) and continues instead of ending the task on the error. Bounded by construction: the boundary consumes the compaction part that gates the branch",
  },
  {
    id: "post-compaction-stall",
    fn: "(inline block — session/prompt.ts finish path, postCompactionStall detector in verify-gate.ts)",
    counter: "postCompactionContinued",
    cap: 1,
    capSource: "prompt.ts postCompactionContinued boolean — structurally at most one per runLoop",
    description:
      "work was in flight before a compaction boundary and the first post-boundary turn produced a text-only announcement with zero tool calls; one bounded re-entry steers the model to resume. The counter is a boolean, so the cap is 1 by construction; FABULA_POST_COMPACTION_CONTINUE=0 disables the edge entirely (kill-switch, not a cap parser)",
  },
]

export const REENTRY_BUDGET_ENV = "FABULA_REENTRY_BUDGET"

/** The upper bound on a LEGITIMATE turn: every registered edge firing to its cap UNDER `env`. Derived, so
 *  changing a per-edge cap — in source OR by env override — moves this automatically instead of silently
 *  invalidating a magic number. NB it is an upper BOUND, not a reachable worst case: `structured-output-retry`
 *  only fires for a `json_schema` request, which does not co-occur with a normal explicit-`/goal` main turn,
 *  so a realistic maximum is ~29 (~20 auto-armed). Bounding above is the correct side to err on. */
export function sumOfCaps(
  edges: readonly ReEntryEdge[] = RE_ENTRY_EDGES,
  env: Record<string, string | undefined> = {},
): number {
  return edges.reduce((n, e) => n + resolveEdgeCap(e, env), 0)
}

/** The shared per-turn ceiling on the TOTAL of all edges. Set to `sumOfCaps()` — the exact worst case a
 *  legitimate turn can reach (31: every edge at its cap, with an explicit `/goal`). Once wired it would
 *  never cut a turn whose gates are each behaving within their own bound — it would refuse only re-entry
 *  number 32, which under today's caps is reachable ONLY if some counter is re-armed mid-turn. That makes it
 *  a BACKSTOP against a bound violation, not a tightener of normal behavior, and it is worth stating that
 *  way rather than claiming it bounds the composition today. A budget BELOW this value would truncate
 *  legitimate work (the first audit proposed 16, which would have cut an explicit `/goal` turn roughly in
 *  half). NOTE: this constant is evaluated once from the source-literal caps; `reentryBudget(env)` resolves
 *  the caps from the actual environment, which is the value any wiring must use. */
export const DEFAULT_REENTRY_BUDGET = sumOfCaps()

/** Total, defensive parse: any unusable value falls back to the default; "0" explicitly DISABLES the budget
 *  (per-edge caps only — today's behavior). Always a finite, non-negative integer. */
export function reentryBudget(env: Record<string, string | undefined>): number {
  const raw = (env[REENTRY_BUDGET_ENV] ?? "").trim()
  // The fallback is resolved AGAINST THIS ENV, not the static default: raising a per-edge cap
  // (e.g. FABULA_NGRAM_MAX_RECOVERY=10) legitimately raises the worst case, and a budget frozen at the
  // source-literal sum would then truncate work that is behaving perfectly within its own bounds.
  const derived = sumOfCaps(RE_ENTRY_EDGES, env)
  if (raw === "") return derived
  const n = Number(raw)
  if (!Number.isFinite(n)) return derived
  const i = Math.floor(n)
  if (i < 0) return derived
  return i
}

export interface ReEntryState {
  /** 0 = disabled */
  budget: number
  /** re-entries charged this turn, across ALL edges */
  total: number
  /** per-edge tallies — only edges that actually fired appear */
  perEdge: Record<string, number>
}

/** One state per TURN (never module-level: concurrent sessions must not share a tally). */
export function initReentry(budget: number): ReEntryState {
  return { budget, total: 0, perEdge: {} }
}

function tallyText(state: ReEntryState): string {
  const parts = Object.entries(state.perEdge)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, n]) => `${id}:${n}`)
  return parts.join(", ")
}

function exhaustedReason(state: ReEntryState): string {
  return `the shared re-entry budget for this turn is spent (${state.total}/${state.budget} re-entries; ${tallyText(state)})`
}

/**
 * Charge one re-entry to the shared budget. Returns `allowed:false` once the budget is spent — the caller
 * must then STOP the turn honestly instead of continuing. An unknown edge id is still counted (never a free
 * pass): an unregistered edge must not be able to spend re-entries invisibly. Refusal is sticky: the total
 * stays at the ceiling, so every later charge is refused too. Never resets within a turn.
 */
export function chargeReentry(
  state: ReEntryState,
  edgeId: string,
): { allowed: boolean; total: number; reason?: string } {
  if (state.budget <= 0) {
    // Disabled: still counted (so the tally stays honest/observable), never refused.
    state.total += 1
    state.perEdge[edgeId] = (state.perEdge[edgeId] ?? 0) + 1
    return { allowed: true, total: state.total }
  }
  if (state.total >= state.budget) return { allowed: false, total: state.total, reason: exhaustedReason(state) }
  state.total += 1
  state.perEdge[edgeId] = (state.perEdge[edgeId] ?? 0) + 1
  return { allowed: true, total: state.total }
}

/** The honest terminal message when the budget ends a turn — a run must never stop on a silent budget kill. */
export function renderBudgetExhausted(state: ReEntryState): string {
  return [
    `— ⛔ RE-ENTRY BUDGET EXHAUSTED: this turn used ${state.total} of ${state.budget} allowed harness re-entries`,
    `(${tallyText(state)}).`,
    "The gates kept re-entering without reaching a proven result, so the turn is ended rather than spun further.",
    "Treat this as NOT DONE: report honestly what was attempted and what still fails.",
  ].join(" ")
}
