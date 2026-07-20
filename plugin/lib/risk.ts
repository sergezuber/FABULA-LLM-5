// W6 — WHEN to give up locally and ask for help, decided from measured evidence instead of a counter.
//
// Before this, the whole decision was three constants and one number: `redStreak >= 2` rewinds,
// `>= 4` is terminal. Two runs a human would judge completely differently — one red on a fresh file
// versus one red after four attempts churning the SAME file, with duplicate tool calls and twenty
// minutes burned — were indistinguishable to the harness, because it had nowhere to put the evidence.
//
// arXiv:2605.16604 (teaching a small model when to ask for help) says the trigger should be a calibrated
// per-step risk signal over features the harness already observes, not a heuristic counter. That is what
// this module is. It is deliberately a TRANSPARENT hand-derived function, not a trained one: every weight
// is visible, the score is replayable from a ledger record, and there is no model in the loop deciding
// whether to trust a model.
//
// SAFETY DIRECTION (the property that matters most): today's constants are a FLOOR, never a ceiling.
// The score may fire EARLIER when independent signals corroborate, but it may never carry a run PAST the
// point where the constants would already have called NOT DONE. Escalating late costs time; refusing to
// ever stop is the failure this project has already paid for once.

import { REWIND_THRESHOLD, NOTDONE_THRESHOLD, REWIND_MAX } from "./rewind"

/** Harness-observable evidence about the current failing streak. Every field is optional: a caller that
 *  cannot measure a signal must not be forced to invent one (a fabricated zero is a lie, a missing key
 *  is honest). Model-agnostic by construction — nothing here knows which model is in the socket. */
export interface RiskFeatures {
  /** consecutive RED verifies with no green between */
  redStreak?: number
  /** REPEAT edits to one path — how many times an attempt went back to a file it had already changed.
   *  Not the number of distinct files touched: the harness fed exactly that inversion at first, so a run
   *  thrashing one file ten times scored 1 while a healthy broad edit across six files scored 6. */
  sameFileChurn?: number
  /** near-duplicate tool calls seen by the loop-guard */
  nearDuplicates?: number
  /** fraction of tool calls that errored, in [0,1] */
  toolErrorRate?: number
  /** wall-clock burned on the current red streak */
  elapsedMs?: number
  /** how many times the harness already reverted to the last green (see-saw detection) */
  rewinds?: number
  /** whether a green state exists to return to */
  hasGreenAnchor?: boolean
  [k: string]: unknown
}

/** Accepted spellings per feature. Callers across the harness (and its tests) name these differently;
 *  refusing an alias would silently read the feature as zero, which is the quietest possible bug. */
const ALIASES: Record<string, string[]> = {
  redStreak: ["redStreak", "reds", "redCount", "consecutiveReds", "consecutiveRedVerifies", "redVerifies", "failStreak"],
  sameFileChurn: ["sameFileChurn", "churn", "fileChurn", "editChurn", "sameFileEdits", "churnCount"],
  nearDuplicates: ["nearDuplicates", "dups", "nearDups", "duplicates", "nearDupCount", "loopGuardNearDups"],
  toolErrorRate: ["toolErrorRate", "errRate", "errorRate", "toolErrors", "errorFraction"],
  elapsedMs: ["elapsedMs", "elapsed", "streakElapsedMs", "durationMs", "wallClockMs", "elapsedMillis"],
  rewinds: ["rewinds", "rewindCount", "restores"],
}

/** Read a numeric feature by any accepted alias. Absurd values (NaN, ±Infinity, negative) are treated as
 *  "no evidence" rather than propagated: a garbage input must never be able to move a safety decision. */
function num(f: RiskFeatures | undefined | null, key: string, fallbackSeconds?: string): number {
  if (!f || typeof f !== "object") return 0
  for (const a of ALIASES[key] ?? [key]) {
    const v = (f as Record<string, unknown>)[a]
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v
  }
  // elapsed is also commonly carried in seconds
  if (fallbackSeconds) {
    for (const a of [fallbackSeconds, "elapsedSec", "elapsedSeconds", "durationSec", "seconds"]) {
      const v = (f as Record<string, unknown>)[a]
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v * 1000
    }
  }
  return 0
}

/** Is this feature CARRIED by the caller at all? A key that is absent means "not measured"; a key that
 *  is present but unusable (NaN, negative) is treated as absent too, for the same reason. */
function hasFeature(f: RiskFeatures | undefined | null, key: string): boolean {
  if (!f || typeof f !== "object") return false
  for (const a of ALIASES[key] ?? [key]) {
    const v = (f as Record<string, unknown>)[a]
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return true
  }
  if (key === "elapsedMs") {
    for (const a of ["elapsedSec", "elapsedSeconds", "durationSec", "seconds"]) {
      const v = (f as Record<string, unknown>)[a]
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return true
    }
  }
  return false
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)
/** Saturating normalizer: linear up to `full`, flat after. Monotone non-decreasing by construction, which
 *  is what makes the whole score monotone — worse evidence can never lower the risk. */
const sat = (x: number, full: number) => clamp01(full > 0 ? x / full : 0)

/** Where each signal is considered "as bad as it gets" for scoring purposes. These are scale choices, not
 *  thresholds: they set how fast a signal saturates, and every one of them is visible here rather than
 *  buried in an expression. */
export const SCALE = {
  reds: NOTDONE_THRESHOLD, // a full streak to the terminal constant
  churn: 6, // six attempts on the same file is thrashing by any reading
  dups: 8, // the loop-guard's own budget is 15/turn; half of it is already pathological
  elapsedMs: 30 * 60 * 1000, // half an hour on ONE failing streak
} as const

/** Weights sum to 1. Each is large enough to change a decision on its own somewhere in the space — a
 *  feature that is accepted and then ignored would be worse than not collecting it, because it would
 *  look measured while being decorative. */
export const WEIGHTS = {
  reds: 0.4,
  churn: 0.2,
  dups: 0.15,
  errRate: 0.15,
  elapsedMs: 0.1,
} as const

/**
 * The per-step risk that another LOCAL attempt is wasted, in [0,1]. Pure, deterministic, and total: any
 * input shape at all yields a finite bounded number, because a safety decision must never depend on the
 * caller having produced a well-formed object.
 */
export function riskScore(f: RiskFeatures | undefined | null): number {
  // A plain weighted sum over the evidence that is PRESENT. Absent evidence contributes nothing, and a
  // signal MEASURED at zero also contributes nothing — so the score is monotone ACROSS feature sets as
  // well as within one, and wiring a new producer can never lower an existing run's risk.
  //
  // Two wrong instruments were tried first and both are worth remembering. Summing all five weights
  // unconditionally scores "nobody measured this" as "measured to be zero", which made the corroboration
  // rung mathematically unreachable in production (max 0.40 against a 0.45 threshold). Normalising by the
  // present weights fixed that and introduced the mirror defect: adding a producer that reads zero DILUTES
  // the mean, so the same scenario fell 0.571 → 0.471 → 0.400 as each remaining feature was wired — the
  // mechanism un-fixing itself on the next obvious commit, while a comment right here promised it could
  // not. The magnitude is now reported evidence, not the trigger; see `corroboration` below for what
  // actually decides.
  let sum = 0
  if (hasFeature(f, "redStreak")) sum += WEIGHTS.reds * sat(num(f, "redStreak"), SCALE.reds)
  if (hasFeature(f, "sameFileChurn")) sum += WEIGHTS.churn * sat(num(f, "sameFileChurn"), SCALE.churn)
  if (hasFeature(f, "nearDuplicates")) sum += WEIGHTS.dups * sat(num(f, "nearDuplicates"), SCALE.dups)
  if (hasFeature(f, "toolErrorRate")) sum += WEIGHTS.errRate * clamp01(num(f, "toolErrorRate"))
  if (hasFeature(f, "elapsedMs")) sum += WEIGHTS.elapsedMs * sat(num(f, "elapsedMs", "elapsedSec"), SCALE.elapsedMs)
  return clamp01(sum)
}

/** Where a signal stops being noise and starts being evidence. Deliberately generous: one repeat edit IS
 *  going back to a file, one duplicate IS a repeat, and five minutes on a single failing streak is real
 *  time. These are the "is this signal saying anything at all" line, not thresholds for action. */
const SPEAKS = { churn: 1, dups: 1, errRate: 0.2, elapsedMs: 5 * 60 * 1000 } as const

/**
 * How many INDEPENDENT adverse signals agree, not counting the red streak itself.
 *
 * This is what "corroborated evidence fires earlier" actually means, and counting is immune to the
 * dilution that broke both magnitude-based attempts: a signal measured at zero simply does not
 * corroborate, and one nobody measured cannot either. Wiring a new producer can only ever ADD to this.
 */
export function corroboration(f: RiskFeatures | undefined | null): number {
  let n = 0
  if (num(f, "sameFileChurn") >= SPEAKS.churn) n++
  if (num(f, "nearDuplicates") >= SPEAKS.dups) n++
  if (num(f, "toolErrorRate") >= SPEAKS.errRate) n++
  if (num(f, "elapsedMs", "elapsedSec") >= SPEAKS.elapsedMs) n++
  return n
}

/** How many agreeing signals justify asking for help before the streak reaches the constant. Two, so a
 *  single noisy measurement can never trigger it on its own. */
export const CORROBORATION_MIN = 2

export type EscalationVerdict = "continue-locally" | "escalate" | "not-done"

export interface EscalationOptions {
  /** How many independent signals must agree for the early rung to fire. There is deliberately NO score
   *  THRESHOLD any more: the magnitude proved un-tunable across three redesigns, and a knob that is
   *  computed and never read is worse than no knob — it invites tests that prove nothing. */
  corroborationMin?: number
  /** env access, injected so the decision stays pure and testable */
  env?: Record<string, string | undefined>
  /** today's constants, injected only so a test can prove the floor tracks them rather than a copy */
  rewindThreshold?: number
  notDoneThreshold?: number
  rewindMax?: number
}

export interface EscalationResult {
  decision: EscalationVerdict
  score: number
  /** why, in one line, for the ledger and for the human reading a log */
  reason: string
  /** true when a floor (not the score) decided it — the audit trail for "we never went past the constant" */
  floored: boolean
}

export const RISK_ENV = "FABULA_RISK_SCORE"

/**
 * Map evidence to one of three rungs: keep trying locally → ask a stronger model → stop and say NOT DONE.
 *
 * The ladder ORDER is part of the contract: on an ordinary red streak the decision passes through
 * `escalate` before it can reach `not-done`. Without that, the second opinion would only ever be asked
 * for on exotic corroborated runs and the harness would declare NOT DONE having never once consulted a
 * stronger model — which is precisely what today's prose steer already promises to do.
 *
 * `FABULA_RISK_SCORE=0` restores the pre-W6 ladder exactly: the constants decide, and there is no
 * escalation rung at all.
 */
export function escalationDecision(f: RiskFeatures | undefined | null, opts: EscalationOptions = {}): EscalationResult {
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {})
  const enabled = String(env?.[RISK_ENV] ?? "1").trim().toLowerCase() !== "0"
  const rewindAt = opts.rewindThreshold ?? REWIND_THRESHOLD
  const notDoneAt = opts.notDoneThreshold ?? NOTDONE_THRESHOLD
  const maxRewinds = opts.rewindMax ?? REWIND_MAX
  const needAgree =
    typeof opts.corroborationMin === "number" && Number.isFinite(opts.corroborationMin) && opts.corroborationMin > 0
      ? Math.floor(opts.corroborationMin)
      : CORROBORATION_MIN

  const reds = num(f, "redStreak")
  const rewinds = num(f, "rewinds")
  const score = riskScore(f)

  // ── THE FLOORS. These run before the score and cannot be argued with by it. ──────────────────────
  // (a) the streak reached the terminal constant.
  if (reds >= notDoneAt) {
    return { decision: "not-done", score, floored: true,
             reason: `${reds} consecutive failed verifications reached the terminal threshold (${notDoneAt}).` }
  }
  // (b) the see-saw: the rewind budget is spent and a fresh full streak is red again. Today's ladder has
  // TWO terminal paths and flooring only on (a) would let this one run forever.
  if (rewinds >= maxRewinds && reds >= rewindAt) {
    return { decision: "not-done", score, floored: true,
             reason: `the last-green state was restored ${rewinds} time(s) and the run failed ${reds} more time(s) after it.` }
  }

  if (!enabled) {
    // Pre-W6 behaviour, exactly: the constants decide and nothing escalates.
    return { decision: "continue-locally", score, floored: true, reason: `risk scoring disabled (${RISK_ENV}=0); the fixed thresholds decide.` }
  }

  // ── the escalation rung ─────────────────────────────────────────────────────────────────────────
  // (c) the streak reached the point where the harness already tells the model to get a second opinion.
  // Making it a DECISION rather than a sentence is the whole point of this wave.
  if (reds >= rewindAt) {
    return { decision: "escalate", score, floored: true,
             reason: `${reds} consecutive failed verifications reached the rewind threshold (${rewindAt}); a second opinion is due.` }
  }
  // (d) corroborated evidence fires EARLIER than the counter would: one red is not much on its own, but
  // one red plus thrashing on the same file plus duplicate calls plus burned time is a different run.
  const agree = corroboration(f)
  if (reds >= 1 && agree >= needAgree) {
    return { decision: "escalate", score, floored: false,
             reason: `${agree} independent signals agree after ${reds} failed verification(s) (risk ${score.toFixed(2)}).` }
  }
  return { decision: "continue-locally", score, floored: false,
           reason: agree
             ? `only ${agree} corroborating signal(s) after ${reds} failed verification(s) — ${needAgree} are required to ask early (risk ${score.toFixed(2)}).`
             : score > 0
               ? `no corroborating signal yet (risk ${score.toFixed(2)}).`
               : "no adverse evidence." }
}

/**
 * What the current failing streak has already COST, in milliseconds of wall-clock.
 *
 * A FEATURE, never a timeout. Nothing here may terminate a run: a run that is slow is not the same as a
 * run that is stuck, and killing the first in order to catch the second is how a nearly-finished task
 * gets thrown away. The number exists so "cheap to retry" and "expensive to retry" can be different
 * decisions — not so that expensive can mean dead.
 *
 * Accepts either the feature object the rest of this module takes, or a bare elapsed figure, because
 * both call shapes exist across the harness.
 */
export function attemptCost(input: RiskFeatures | number | undefined | null): number {
  if (typeof input === "number") return Number.isFinite(input) && input > 0 ? input : 0
  return num(input, "elapsedMs", "elapsedSec")
}

/** Elapsed since a start marker, for callers that hold a timestamp rather than a duration. */
export function elapsedSince(startedAtMs: number | undefined | null, nowMs: number = Date.now()): number {
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs) || startedAtMs <= 0) return 0
  if (!Number.isFinite(nowMs)) return 0
  return Math.max(0, nowMs - startedAtMs)
}
