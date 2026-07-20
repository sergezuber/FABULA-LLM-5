// Unit tests for the escalation-economics core (lib/risk.ts).
//
// The properties asserted here are the ones three failed implementations violated in production while a
// green suite watched. Each block says which failure it exists to catch, because the value of these tests
// is entirely in the shapes they refuse — a test that only feeds well-formed evidence would have passed
// against every broken version.
import { test, expect } from "bun:test"
import {
  riskScore, corroboration, escalationDecision, attemptCost, elapsedSince,
  CORROBORATION_MIN, SCALE, WEIGHTS, RISK_ENV,
} from "./risk"
import { REWIND_THRESHOLD, NOTDONE_THRESHOLD, REWIND_MAX } from "./rewind"

const OFF = { [RISK_ENV]: "1" } as Record<string, string | undefined>

// ── the score is total: no input can make it throw or leave [0,1] ──────────────────────────────────
test("any input at all yields a finite score in [0,1]", () => {
  const junk: any[] = [
    undefined, null, {}, [], "not an object", 42,
    { redStreak: NaN }, { redStreak: -5 }, { redStreak: Infinity },
    { churn: "many" }, { elapsedMs: -1 }, { toolErrorRate: 99 },
    { redStreak: 1e12, churn: 1e12, dups: 1e12, errRate: 1e12, elapsedMs: 1e12 },
  ]
  for (const f of junk) {
    const s = riskScore(f)
    expect(Number.isFinite(s)).toBe(true)
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(1)
  }
})

test("garbage values are read as no-evidence, not propagated into a safety decision", () => {
  // A negative or NaN reading is a broken producer. It must not be able to move the score at all.
  expect(riskScore({ redStreak: NaN as any })).toBe(0)
  expect(riskScore({ redStreak: -3 as any })).toBe(0)
  expect(riskScore({ toolErrorRate: Infinity as any })).toBe(0)
})

// ── monotonicity ACROSS feature sets — the defect that broke round 2 ──────────────────────────────
test("wiring a producer that measures ZERO never lowers the score", () => {
  // Round 2 normalised by the present weights, so a newly wired feature reading zero DILUTED the mean and
  // the same run scored 0.571 → 0.471 → 0.400 as each producer landed: the mechanism un-fixing itself on
  // the next obvious commit. Adding measured-zero evidence must be a no-op, never a reduction.
  const base = { redStreak: 1, churn: 3 }
  const before = riskScore(base)
  expect(riskScore({ ...base, dups: 0 })).toBeGreaterThanOrEqual(before)
  expect(riskScore({ ...base, dups: 0, errRate: 0 })).toBeGreaterThanOrEqual(before)
  expect(riskScore({ ...base, dups: 0, errRate: 0, elapsedMs: 0 })).toBeGreaterThanOrEqual(before)
})

test("worse evidence never lowers the score", () => {
  const worse = { redStreak: 2, churn: 4, dups: 3, errRate: 0.5, elapsedMs: 10 * 60 * 1000 }
  const milder = { redStreak: 1, churn: 1, dups: 1, errRate: 0.1, elapsedMs: 60 * 1000 }
  expect(riskScore(worse)).toBeGreaterThan(riskScore(milder))
})

test("each weighted signal saturates at its scale and stops growing", () => {
  const atFull = riskScore({ churn: SCALE.churn })
  const wayPast = riskScore({ churn: SCALE.churn * 100 })
  expect(wayPast).toBeCloseTo(atFull, 10)
  expect(atFull).toBeCloseTo(WEIGHTS.churn, 10)
})

test("aliases are read, so a producer naming a feature differently is not silently zero", () => {
  // Refusing an alias reads the feature as zero — the quietest possible bug, and one this harness already
  // shipped once when the churn producer fed a differently named key.
  expect(riskScore({ sameFileChurn: 3 })).toBeCloseTo(riskScore({ churn: 3 }), 10)
  expect(riskScore({ consecutiveReds: 2 })).toBeCloseTo(riskScore({ redStreak: 2 }), 10)
  expect(riskScore({ nearDups: 4 })).toBeCloseTo(riskScore({ dups: 4 }), 10)
  // elapsed is carried in seconds by some call sites
  expect(riskScore({ elapsedSec: 600 })).toBeCloseTo(riskScore({ elapsedMs: 600_000 }), 10)
})

// ── corroboration counts, and counting is what makes it dilution-proof ────────────────────────────
test("corroboration counts agreeing signals and ignores the red streak itself", () => {
  expect(corroboration({ redStreak: 9 })).toBe(0)
  expect(corroboration({ churn: 1 })).toBe(1)
  expect(corroboration({ churn: 2, dups: 1 })).toBe(2)
  expect(corroboration({ churn: 2, dups: 1, errRate: 0.5, elapsedMs: 6 * 60 * 1000 })).toBe(4)
})

test("a signal measured at zero does not corroborate", () => {
  expect(corroboration({ churn: 0, dups: 0, errRate: 0, elapsedMs: 0 })).toBe(0)
})

// ── the floors: the score may fire EARLIER, never later ───────────────────────────────────────────
test("the terminal constant is a floor the score cannot argue with", () => {
  const r = escalationDecision({ redStreak: NOTDONE_THRESHOLD }, { env: OFF })
  expect(r.decision).toBe("not-done")
  expect(r.floored).toBe(true)
})

test("no evidence at all can carry a run past the terminal constant", () => {
  // The one direction that must never be possible: a rich-looking feature set arguing a doomed run onward.
  const r = escalationDecision(
    { redStreak: NOTDONE_THRESHOLD + 3, churn: 0, dups: 0, errRate: 0, elapsedMs: 0, hasGreenAnchor: true },
    { env: OFF },
  )
  expect(r.decision).toBe("not-done")
})

test("the see-saw is terminal too: rewind budget spent and red again", () => {
  const r = escalationDecision({ redStreak: REWIND_THRESHOLD, rewinds: REWIND_MAX }, { env: OFF })
  expect(r.decision).toBe("not-done")
  expect(r.floored).toBe(true)
})

test("the floors track the real constants, not a private copy of them", () => {
  // Injected thresholds prove the decision reads them rather than re-declaring the numbers here.
  const r = escalationDecision({ redStreak: 3 }, { env: OFF, notDoneThreshold: 3, rewindThreshold: 2 })
  expect(r.decision).toBe("not-done")
  const s = escalationDecision({ redStreak: 3 }, { env: OFF, notDoneThreshold: 99, rewindThreshold: 2 })
  expect(s.decision).toBe("escalate")
})

// ── ladder ORDER: a second opinion is always reached before NOT DONE ──────────────────────────────
test("an ordinary red streak passes through escalate before it can reach not-done", () => {
  const seen: string[] = []
  for (let reds = 0; reds <= NOTDONE_THRESHOLD; reds++) {
    seen.push(escalationDecision({ redStreak: reds }, { env: OFF }).decision)
  }
  expect(seen.indexOf("escalate")).toBeGreaterThan(-1)
  expect(seen.indexOf("escalate")).toBeLessThan(seen.indexOf("not-done"))
})

// ── the early rung: reachable in production, which is what rounds 1-3 were not ─────────────────────
test("corroborated evidence escalates on the FIRST red", () => {
  // Rounds 1-3 all left this unreachable while the suite stayed green — twice by arithmetic, once because
  // the elapsed clock started at the moment it was read. Assert it fires on evidence a real run can carry.
  const r = escalationDecision({ redStreak: 1, churn: 2, elapsedMs: 6 * 60 * 1000 }, { env: OFF })
  expect(r.decision).toBe("escalate")
  expect(r.floored).toBe(false)
})

test("one lone signal is not enough to ask early", () => {
  const r = escalationDecision({ redStreak: 1, churn: 2 }, { env: OFF })
  expect(r.decision).toBe("continue-locally")
  expect(corroboration({ redStreak: 1, churn: 2 })).toBeLessThan(CORROBORATION_MIN)
})

test("corroboration without any red does not escalate", () => {
  // Nothing has failed yet; a run that has not gone red has nothing to get a second opinion about.
  const r = escalationDecision({ redStreak: 0, churn: 5, dups: 5, errRate: 0.9, elapsedMs: 60 * 60 * 1000 }, { env: OFF })
  expect(r.decision).toBe("continue-locally")
})

test("the agreement bar is configurable and actually read", () => {
  const f = { redStreak: 1, churn: 2, elapsedMs: 6 * 60 * 1000 }
  expect(escalationDecision(f, { env: OFF, corroborationMin: 4 }).decision).toBe("continue-locally")
  expect(escalationDecision(f, { env: OFF, corroborationMin: 1 }).decision).toBe("escalate")
})

// ── the kill-switch restores the pre-W6 ladder exactly ────────────────────────────────────────────
test("FABULA_RISK_SCORE=0 removes the escalation rung but keeps both terminal floors", () => {
  const off = { [RISK_ENV]: "0" }
  expect(escalationDecision({ redStreak: 1, churn: 3, elapsedMs: 9e5 }, { env: off }).decision).toBe("continue-locally")
  expect(escalationDecision({ redStreak: REWIND_THRESHOLD }, { env: off }).decision).toBe("continue-locally")
  // …but a run that reached the terminal constant still stops. Disabling a scoring refinement must never
  // disable the stop condition underneath it.
  expect(escalationDecision({ redStreak: NOTDONE_THRESHOLD }, { env: off }).decision).toBe("not-done")
})

test("every decision carries a reason a human can read in a log", () => {
  for (const f of [{ redStreak: 0 }, { redStreak: 1, churn: 2 }, { redStreak: NOTDONE_THRESHOLD }]) {
    const r = escalationDecision(f, { env: OFF })
    expect(r.reason.length).toBeGreaterThan(10)
    expect(Number.isFinite(r.score)).toBe(true)
  }
})

// ── attempt cost is a feature, never a timeout ────────────────────────────────────────────────────
test("attemptCost reports elapsed time and never decides anything", () => {
  expect(attemptCost(5000)).toBe(5000)
  expect(attemptCost({ elapsedMs: 7000 })).toBe(7000)
  expect(attemptCost({ elapsedSec: 7 })).toBe(7000)
  expect(attemptCost(undefined)).toBe(0)
  expect(attemptCost(-1)).toBe(0)
  // An enormous cost is still just a number: no input to this function produces a terminal verdict.
  const huge = escalationDecision({ redStreak: 0, elapsedMs: 100 * 60 * 60 * 1000 }, { env: OFF })
  expect(huge.decision).toBe("continue-locally")
})

test("elapsedSince is zero rather than negative or NaN for unusable markers", () => {
  expect(elapsedSince(1000, 4000)).toBe(3000)
  expect(elapsedSince(undefined)).toBe(0)
  expect(elapsedSince(0)).toBe(0)
  expect(elapsedSince(5000, 1000)).toBe(0)
  expect(elapsedSince(NaN as any, 1000)).toBe(0)
})
