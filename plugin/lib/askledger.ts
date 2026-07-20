// W6 — the escalation decision ledger, and the metric that judges it.
//
// arXiv:2604.09408 (HiL-Bench) names the thing this harness could not do at all: nothing recorded WHEN
// the harness decided to ask for help, so there was no way — even in principle — to say whether it asks
// too often, too rarely, or at the wrong moments. A mechanism nobody can score is a mechanism nobody can
// improve, and this project's own rule is that a default must be earned by evidence.
//
// What this module delivers is the MEASUREMENT. Tuning thresholds against it is a separate change that
// has to earn its own default — writing the ledger and then quietly retuning off a handful of records
// would be exactly the unearned number the discipline forbids.
//
// TWO honesty properties are load-bearing here:
//   1. An outcome that is not yet known is EXCLUDED, never counted as a success. Otherwise a ledger with
//      one known result out of a hundred reads "precision 1.0", which is a lie with a decimal point.
//   2. The ledger is bounded, and what it dropped is DECLARED. Dropping the oldest records biases any
//      metric computed from what remains; silent truncation would make the bias invisible.

/** A single decision, as it was made. Records are append-only and self-contained so the decision can be
 *  replayed from the record alone (which is what makes the metric auditable rather than anecdotal). */
export interface DecisionRecord {
  id?: string
  ts?: number
  sessionID?: string
  /** the verdict that was taken */
  decision?: string
  /** convenience mirrors — a reader may use whichever it has */
  fired?: boolean
  escalated?: boolean
  /** the later-known outcome: true = helped, false = did not help, null/absent = NOT YET KNOWN */
  helped?: boolean | null
  wouldHaveHelped?: boolean | null
  outcome?: string | boolean | null
  /** the evidence the decision was made on */
  features?: Record<string, unknown>
  score?: number
  [k: string]: unknown
}

export interface AskLedger {
  entries: DecisionRecord[]
  /** how many records were evicted to stay inside the cap — the honesty field */
  dropped: number
  /** everything ever appended, so a reader can see the retained window is a window */
  totalSeen: number
  cap: number
}

export const DEFAULT_LEDGER_CAP = 2000
export const LEDGER_ENV = "FABULA_ASK_LEDGER"

export function initLedger(cap: number = DEFAULT_LEDGER_CAP): AskLedger {
  const c = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_LEDGER_CAP
  return { entries: [], dropped: 0, totalSeen: 0, cap: c }
}

function asLedger(l: unknown): AskLedger {
  if (l && typeof l === "object" && Array.isArray((l as AskLedger).entries)) return l as AskLedger
  if (Array.isArray(l)) return { entries: l as DecisionRecord[], dropped: 0, totalSeen: l.length, cap: DEFAULT_LEDGER_CAP }
  return initLedger()
}

/**
 * Append one decision. FIFO under the cap: the NEWEST records are retained, because a decision made
 * twenty thousand steps ago describes a different phase of the run than the one being judged now. The
 * eviction count is kept so `askF1` can say what window it is describing.
 */
export function appendDecision(ledger: unknown, rec: DecisionRecord): AskLedger {
  const l = asLedger(ledger)
  const entries = l.entries.concat([rec])
  let dropped = l.dropped
  while (entries.length > l.cap) {
    entries.shift()
    dropped++
  }
  return { entries, dropped, totalSeen: l.totalSeen + 1, cap: l.cap }
}

/** Did this record represent an escalation? Accepts the spellings the harness uses. */
function firedOf(r: DecisionRecord): boolean {
  for (const k of ["fired", "escalated", "asked", "didEscalate"]) {
    const v = (r as Record<string, unknown>)[k]
    if (typeof v === "boolean") return v
  }
  for (const k of ["decision", "verdict", "action"]) {
    const v = (r as Record<string, unknown>)[k]
    if (typeof v === "string") return /^escalat/i.test(v.trim())
  }
  return false
}

/** The later-known outcome, or null when it is genuinely not known yet. */
function outcomeOf(r: DecisionRecord): boolean | null {
  for (const k of ["helped", "wouldHaveHelped", "helpful", "correct"]) {
    const v = (r as Record<string, unknown>)[k]
    if (typeof v === "boolean") return v
    if (v === null) return null
  }
  for (const k of ["outcome", "result", "label"]) {
    const v = (r as Record<string, unknown>)[k]
    if (typeof v === "string") {
      const s = v.trim().toLowerCase()
      if (/unknown|pending|n\/a|not-?known/.test(s)) return null
      if (/^(helped|help|true|yes|good|success)/.test(s)) return true
      if (/^(not-?helped|no-?help|false|no|bad|fail)/.test(s)) return false
    }
    if (typeof v === "boolean") return v
  }
  return null
}

export interface AskF1 {
  precision: number | null
  recall: number | null
  f1: number | null
  tp: number
  fp: number
  fn: number
  tn: number
  /** decisions with a KNOWN outcome — the only ones the numbers above are computed from */
  support: number
  /** records present but excluded because the outcome is not yet known */
  unknown: number
  /** the window this describes: how many records are retained, and how many were evicted */
  retained: number
  dropped: number
  totalSeen: number
  note: string
}

/**
 * Precision/recall/F1 over escalation decisions, in the textbook sense: a fired decision that helped is a
 * true positive, a fired decision that did not is a false positive, a decision NOT fired where escalating
 * would have helped is a false negative.
 *
 * A zero denominator returns `null` — honestly undefined — never 0 dressed as a score and never 1.0.
 * `support` is part of the result on purpose: a precision of 1.0 over two known outcomes is not a claim,
 * and a reader who cannot see the support cannot tell the difference.
 */
export function askF1(ledger: unknown): AskF1 {
  const l = asLedger(ledger)
  let tp = 0, fp = 0, fn = 0, tn = 0, unknown = 0
  for (const r of l.entries) {
    const o = outcomeOf(r)
    if (o === null) {
      unknown++
      continue
    }
    const fired = firedOf(r)
    if (fired && o) tp++
    else if (fired && !o) fp++
    else if (!fired && o) fn++
    else tn++
  }
  const support = tp + fp + fn + tn
  const ratio = (a: number, b: number) => (b > 0 ? a / b : null)
  const precision = ratio(tp, tp + fp)
  const recall = ratio(tp, tp + fn)
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? precision === null || recall === null
        ? null
        : 0
      : (2 * precision * recall) / (precision + recall)
  return {
    precision, recall, f1, tp, fp, fn, tn, support, unknown,
    retained: l.entries.length,
    dropped: l.dropped,
    totalSeen: l.totalSeen,
    note:
      support === 0
        ? "no decision has a known outcome yet — precision/recall are undefined, not perfect"
        : `computed over ${support} decision(s) with known outcomes` +
          (l.dropped > 0 ? `; ${l.dropped} older record(s) were evicted, so this describes the retained window` : ""),
  }
}


/**
 * Where the decision ledger lives. Exported so the writer (the rewind hook) and every reader (the
 * report tool) resolve it the SAME way — a second copy of this logic had already drifted: under a test
 * runner the hook wrote a tmpdir file while the report read the live store, so nothing that drove the
 * hook could ever verify the report.
 *
 * Order: an absolute override wins; then an explicitly chosen XDG_DATA_HOME, honoured even under a test
 * runner because a caller that named its data directory has already decided; then, with neither set, a
 * test runner is kept out of the user's real store; then the default.
 */
export function askLedgerPath(env: Record<string, string | undefined> = process.env as any): string {
  const nodePath = require("node:path") as typeof import("node:path")
  const nodeOs = require("node:os") as typeof import("node:os")
  const override = (env.FABULA_ASK_LEDGER_FILE || "").trim()
  if (override && nodePath.isAbsolute(override)) return override
  const xdg = (env.XDG_DATA_HOME || "").trim()
  if (!xdg && (env.NODE_ENV === "test" || env.BUN_TEST || env.FABULA_TEST)) {
    return nodePath.join(nodeOs.tmpdir(), "fabula-ask-ledger-test.json")
  }
  return nodePath.join(xdg || nodePath.join(nodeOs.homedir(), ".local", "share"), "fabula", "ask-ledger.json")
}
