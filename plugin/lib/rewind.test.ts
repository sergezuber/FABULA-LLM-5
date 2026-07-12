import { test, expect } from "bun:test"
import { initRewind, updateRewind, REWIND_THRESHOLD, NOTDONE_THRESHOLD, REWIND_MAX } from "./rewind"

test("green verify resets streak and records the checkpoint", () => {
  let s = initRewind()
  const r = updateRewind(s, { green: true, checkpoint: "ck1" })
  expect(r.action).toBeNull()
  expect(r.state.lastGreenCheckpoint).toBe("ck1")
  expect(r.state.redStreak).toBe(0)
})

test("a single red does not rewind yet", () => {
  let { state } = updateRewind(initRewind(), { green: true, checkpoint: "ck1" })
  const r = updateRewind(state, { green: false, note: "tried A" })
  expect(r.action).toBeNull()
  expect(r.state.redStreak).toBe(1)
})

test("N consecutive reds after a green trigger a rewind to that green with a summary", () => {
  let { state } = updateRewind(initRewind(), { green: true, checkpoint: "ckGood" })
  ;({ state } = updateRewind(state, { green: false, note: "tried A" }))
  const r = updateRewind(state, { green: false, note: "tried B" })
  expect(r.action).toBeTruthy()
  if (r.action!.type !== "rewind") throw new Error("expected rewind")
  expect(r.action!.toCheckpoint).toBe("ckGood")
  expect(r.action!.summary).toContain("tried A")
  expect(r.action!.summary).toContain("tried B")
  expect(r.action!.summary).toContain("DIFFERENT approach")
  // streak resets after a rewind so it doesn't fire again immediately
  expect(r.state.redStreak).toBe(0)
  expect(r.state.rewinds).toBe(1)
})

test("green between reds prevents the rewind", () => {
  let { state } = updateRewind(initRewind(), { green: true, checkpoint: "ck1" })
  ;({ state } = updateRewind(state, { green: false, note: "A" }))
  ;({ state } = updateRewind(state, { green: true, checkpoint: "ck2" })) // recovered
  const r = updateRewind(state, { green: false, note: "B" })
  expect(r.action).toBeNull()
  expect(r.state.redStreak).toBe(1)
  expect(r.state.lastGreenCheckpoint).toBe("ck2")
})

// ── terminal NOT DONE (Greenpaper §2: no silent third state) ────────────────

test("anchorless red streak reaches the terminal NOT DONE verdict (was: silent no-op forever)", () => {
  let s = initRewind()
  // reds below the notdone threshold stay quiet…
  for (let i = 0; i < NOTDONE_THRESHOLD - 1; i++) {
    const r = updateRewind(s, { green: false, note: `try ${i + 1}` })
    s = r.state
    expect(r.action).toBeNull()
  }
  // …the Nth red with no green anchor surfaces the honest verdict.
  const r = updateRewind(s, { green: false, note: "final try" })
  expect(r.action).toBeTruthy()
  if (r.action!.type !== "notdone") throw new Error("expected notdone")
  expect(r.action!.reason).toContain("none has ever passed")
  expect(r.action!.redStreak).toBe(NOTDONE_THRESHOLD)
  expect(r.action!.failedNotes).toContain("final try")
  // streak resets so the verdict re-fires only after another full streak (no per-call spam)
  expect(r.state.redStreak).toBe(0)
})

test("no premature verdict: anchorless reds below the threshold stay null", () => {
  let s = initRewind()
  for (let i = 0; i < NOTDONE_THRESHOLD - 1; i++) {
    const r = updateRewind(s, { green: false })
    s = r.state
    expect(r.action).toBeNull()
  }
})

test("see-saw exhaustion: after REWIND_MAX rewinds another full red streak is terminal NOT DONE", () => {
  // one green anchor, then keep failing: rewind, rewind, … verdict.
  let { state } = updateRewind(initRewind(), { green: true, checkpoint: "ckGood" })
  const actions: string[] = []
  for (let round = 0; round < REWIND_MAX + 1; round++) {
    for (let i = 0; i < REWIND_THRESHOLD; i++) {
      const r = updateRewind(state, { green: false, note: `round ${round} try ${i}` })
      state = r.state
      if (r.action) actions.push(r.action.type)
    }
  }
  expect(actions).toEqual([...Array(REWIND_MAX).fill("rewind"), "notdone"])
})

test("a later green fully recovers the run after a NOT DONE verdict", () => {
  let s = initRewind()
  for (let i = 0; i < NOTDONE_THRESHOLD; i++) ({ state: s } = updateRewind(s, { green: false }))
  // verdict already fired above; now the model actually fixes it
  const g = updateRewind(s, { green: true, checkpoint: "ckFixed" })
  expect(g.action).toBeNull()
  expect(g.state.lastGreenCheckpoint).toBe("ckFixed")
  expect(g.state.redStreak).toBe(0)
  // and a fresh single red after recovery is quiet again
  const r = updateRewind(g.state, { green: false })
  expect(r.action).toBeNull()
})

test("legacy state without the rewinds field is tolerated", () => {
  const legacy = { redStreak: 1, lastGreenCheckpoint: "ck1", failedNotes: ["A"] } as any
  const r = updateRewind(legacy, { green: false, note: "B" })
  expect(r.action).toBeTruthy()
  if (r.action!.type !== "rewind") throw new Error("expected rewind")
  expect(r.state.rewinds).toBe(1)
})
