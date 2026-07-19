// Pure unit coverage for the W1 strict verdict (lib/reprogate.ts strictGateVerdict). No IO: the probe
// facts are fed directly, so this pins the DECISION TABLE independent of the real fail-to-pass execution
// (which the wiring suites exercise). Mirrors the corner cases in the frozen acceptance suite.
import { test, expect } from "bun:test"
import { newReproState, recordEdit, strictGateVerdict, type StrictInputs, type ReproState } from "./reprogate"

function inputs(over: Partial<StrictInputs> = {}): StrictInputs {
  return {
    freezeReArmed: false, hasSourceChange: true, hasNewTest: true, noChangePasses: false,
    ftpRan: true, ftpReason: undefined, preExit: 1, postExit: 0, siblingPassed: null, ...over,
  }
}
function withEdits(source: string[], tests: string[]): ReproState {
  const st = newReproState()
  for (const s of source) recordEdit(st, s)
  for (const t of tests) recordEdit(st, t)
  return st
}

test("RED verify is never overridden", () => {
  expect(strictGateVerdict(false, withEdits(["a.py"], ["test_t.py"]), inputs()).done).toBe(false)
})

test("testsForbidden stands down (invariant): done, no marks, no steer", () => {
  const st = withEdits(["a.py"], []); st.testsForbidden = true
  const v = strictGateVerdict(true, st, inputs({ hasNewTest: false }))
  expect(v).toEqual({ done: true, note: null, marks: {} })
})

test("freeze re-arm → NOT DONE + freeze mark (checked before everything but stand-down)", () => {
  const v = strictGateVerdict(true, withEdits(["a.py"], ["test_t.py"]), inputs({ freezeReArmed: true }))
  expect(v.done).toBe(false)
  expect(v.marks.freeze).toBe("re-armed")
})

test("no-change terminal: no source + a passing test → verified NO-CHANGE done", () => {
  const st = withEdits([], ["test_t.py"])
  const v = strictGateVerdict(true, st, inputs({ hasSourceChange: false, hasNewTest: true, noChangePasses: true }))
  expect(v.done).toBe(true)
  expect(v.marks.failToPass).toMatch(/no.?change/i)
  expect(v.marks.noChange).toBe("verified")
})

test("no source change + a test that does not pass → left green, no no-change claim", () => {
  const v = strictGateVerdict(true, withEdits([], ["test_t.py"]), inputs({ hasSourceChange: false, noChangePasses: false }))
  expect(v).toEqual({ done: true, note: null, marks: {} })
})

test("source changed, no test → reproduce steer (permissive fallback preserved)", () => {
  const v = strictGateVerdict(true, withEdits(["a.py"], []), inputs({ hasNewTest: false }))
  expect(v.done).toBe(false)
  expect(v.note).toMatch(/reproduction test/i)
})

test("degrade (probe could not run) → done + honest not-validated marker, never traps", () => {
  for (const reason of ["no base", "docker-only", "unsupported runner", "probe error"]) {
    const v = strictGateVerdict(true, withEdits(["a.py"], ["test_t.py"]), inputs({ ftpRan: false, ftpReason: reason }))
    expect(v.done).toBe(true)
    expect(v.marks.failToPass).toBe(`not-validated (${reason})`)
  }
})

test("fake repro (passes-pre AND passes-post) → NOT DONE + fake marker", () => {
  const v = strictGateVerdict(true, withEdits(["a.py"], ["test_t.py"]), inputs({ preExit: 0, postExit: 0 }))
  expect(v.done).toBe(false)
  expect(v.marks.failToPass).toBe("fake (passes on base)")
})

test("new test still fails on the current tree → NOT DONE", () => {
  const v = strictGateVerdict(true, withEdits(["a.py"], ["test_t.py"]), inputs({ preExit: 1, postExit: 1 }))
  expect(v.done).toBe(false)
  expect(v.marks.failToPass).toBe("post-fails")
})

test("validated real repro, siblings green → DONE + validated marker", () => {
  for (const sib of [true, null]) {
    const v = strictGateVerdict(true, withEdits(["a.py"], ["test_t.py"]), inputs({ preExit: 1, postExit: 0, siblingPassed: sib as any }))
    expect(v.done).toBe(true)
    expect(v.marks.failToPass).toBe("validated")
  }
})

test("validated real repro but a sibling regressed → NOT DONE + pass-to-pass marker", () => {
  const v = strictGateVerdict(true, withEdits(["a.py"], ["test_t.py"]), inputs({ preExit: 1, postExit: 0, siblingPassed: false }))
  expect(v.done).toBe(false)
  expect(v.marks.passToPass).toBe("sibling-failed")
  expect(v.marks.failToPass).toBe("validated") // the repro itself IS valid; the regression is the blocker
})
