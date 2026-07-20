// Unit tests for the escalation-decision ledger and the metric that judges it (lib/askledger.ts).
//
// The two properties under test are the honesty ones. A ledger that counted an unknown outcome as a
// success would report a precision of 1.0 over a run where nothing had been graded yet, and a ledger that
// dropped records silently would bias every number computed from what was left without saying so.
import { test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { initLedger, appendDecision, askF1, askLedgerPath, DEFAULT_LEDGER_CAP } from "./askledger"

test("a fresh ledger reports undefined metrics, never a perfect score", () => {
  const m = askF1(initLedger())
  expect(m.precision).toBeNull()
  expect(m.recall).toBeNull()
  expect(m.f1).toBeNull()
  expect(m.support).toBe(0)
  expect(m.note).toContain("undefined")
})

test("decisions with no known outcome are EXCLUDED, not counted as successes", () => {
  // The lie this prevents: one graded record out of a hundred reading as "precision 1.0".
  let l = initLedger()
  l = appendDecision(l, { fired: true, helped: true })
  for (let i = 0; i < 99; i++) l = appendDecision(l, { fired: true, helped: null })
  const m = askF1(l)
  expect(m.support).toBe(1)
  expect(m.unknown).toBe(99)
  expect(m.precision).toBe(1)
  // …and the support is carried, so a reader can see the 1.0 is over a single decision.
  expect(m.note).toContain("1 decision")
})

test("precision, recall and F1 are the textbook quantities", () => {
  let l = initLedger()
  l = appendDecision(l, { fired: true, helped: true })   // tp
  l = appendDecision(l, { fired: true, helped: true })   // tp
  l = appendDecision(l, { fired: true, helped: false })  // fp
  l = appendDecision(l, { fired: false, helped: true })  // fn
  l = appendDecision(l, { fired: false, helped: false }) // tn
  const m = askF1(l)
  expect([m.tp, m.fp, m.fn, m.tn]).toEqual([2, 1, 1, 1])
  expect(m.precision).toBeCloseTo(2 / 3, 10)
  expect(m.recall).toBeCloseTo(2 / 3, 10)
  expect(m.f1).toBeCloseTo(2 / 3, 10)
  expect(m.support).toBe(5)
})

test("a zero denominator is null — honestly undefined, never 0 dressed as a score", () => {
  let l = initLedger()
  l = appendDecision(l, { fired: false, helped: false })
  const m = askF1(l)
  expect(m.precision).toBeNull() // nothing fired
  expect(m.recall).toBeNull()    // nothing would have helped
  expect(m.support).toBe(1)
})

test("the decision and outcome spellings the harness actually writes are all read", () => {
  let l = initLedger()
  l = appendDecision(l, { decision: "escalate", outcome: "helped" })
  l = appendDecision(l, { escalated: true, wouldHaveHelped: false })
  l = appendDecision(l, { decision: "continue-locally", outcome: "no-help" })
  const m = askF1(l)
  expect(m.tp).toBe(1)
  expect(m.fp).toBe(1)
  expect(m.tn).toBe(1)
  expect(m.unknown).toBe(0)
})

test("an outcome spelled as pending is unknown, not a failure", () => {
  let l = initLedger()
  l = appendDecision(l, { fired: true, outcome: "pending" })
  l = appendDecision(l, { fired: true, outcome: "unknown" })
  const m = askF1(l)
  expect(m.unknown).toBe(2)
  expect(m.support).toBe(0)
})

test("the ledger is bounded and DECLARES what it evicted", () => {
  // Silent truncation would make the sampling bias invisible: the retained window is the newest records,
  // so any metric over it describes a phase of the run rather than the run.
  let l = initLedger(10)
  for (let i = 0; i < 25; i++) l = appendDecision(l, { id: `d${i}`, fired: true, helped: true })
  expect(l.entries.length).toBe(10)
  expect(l.dropped).toBe(15)
  expect(l.totalSeen).toBe(25)
  expect(l.entries[0]!.id).toBe("d15") // FIFO: the newest are kept
  expect(askF1(l).note).toContain("evicted")
})

test("appendDecision does not mutate the ledger it was given", () => {
  const before = initLedger(5)
  const after = appendDecision(before, { fired: true })
  expect(before.entries.length).toBe(0)
  expect(after.entries.length).toBe(1)
})

test("a nonsense cap falls back to the default rather than disabling the bound", () => {
  for (const bad of [0, -1, NaN, Infinity] as number[]) {
    expect(initLedger(bad).cap).toBe(DEFAULT_LEDGER_CAP)
  }
})

test("a bare array of records is accepted as a ledger", () => {
  // Older call sites hand a plain array; refusing it would read as an empty ledger, which is the silent
  // failure this whole module exists to avoid.
  const m = askF1([{ fired: true, helped: true }, { fired: true, helped: false }] as any)
  expect(m.support).toBe(2)
  expect(m.precision).toBeCloseTo(0.5, 10)
})

// ── path resolution: the writer and every reader must agree, or nothing can verify anything ────────
test("the ledger path is resolved the same way for the writer and the reader", () => {
  // This drifted once: under a test runner the hook wrote a tmpdir file while the report read the live
  // store, so nothing that exercised the hook could observe the report.
  const dir = mkdtempSync(path.join(os.tmpdir(), "fab-ledger-"))
  try {
    const explicit = path.join(dir, "ask.json")
    expect(askLedgerPath({ FABULA_ASK_LEDGER_FILE: explicit })).toBe(explicit)
    // an explicitly chosen data home is honoured even under a test runner — a caller that named its data
    // directory has already decided
    expect(askLedgerPath({ XDG_DATA_HOME: dir, BUN_TEST: "1" })).toBe(path.join(dir, "fabula", "ask-ledger.json"))
    // with neither set, a test runner is kept out of the real store
    expect(askLedgerPath({ BUN_TEST: "1" })).toBe(path.join(os.tmpdir(), "fabula-ask-ledger-test.json"))
    // a relative override is NOT honoured — it would resolve against whatever cwd the caller happened to
    // have, which is exactly how the writer and the reader drift apart
    expect(askLedgerPath({ FABULA_ASK_LEDGER_FILE: "ask.json", XDG_DATA_HOME: dir })).toBe(
      path.join(dir, "fabula", "ask-ledger.json"),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
