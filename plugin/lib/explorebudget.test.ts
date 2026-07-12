import { test, expect } from "bun:test"
import { newExploreState, observeExplore, exploreSteer, MAX_STEERS } from "./explorebudget"

test("no budget (0 / unset) → never steers, never counts", () => {
  const st = newExploreState()
  for (let i = 0; i < 50; i++) expect(observeExplore(st, "read", 0)).toBeNull()
  expect(st.reads).toBe(0)
})

test("crossing the budget fires the steer exactly at the multiple (the 68-reads-0-edits disease)", () => {
  const st = newExploreState()
  const notes: string[] = []
  for (let i = 0; i < 25; i++) {
    const n = observeExplore(st, i % 2 ? "glob" : "read", 10)
    if (n) notes.push(n)
  }
  expect(notes.length).toBe(2) // at 10 and 20
  expect(notes[0]).toContain("EXPLORATION BUDGET")
  expect(notes[0]).toContain("verify_done")
})

test("an EDIT resets the counter — steady explore→edit cycles never steer", () => {
  const st = newExploreState()
  for (let cycle = 0; cycle < 6; cycle++) {
    for (let i = 0; i < 8; i++) expect(observeExplore(st, "read", 10)).toBeNull()
    expect(observeExplore(st, "str_replace", 10)).toBeNull() // edit resets
    expect(st.reads).toBe(0)
  }
})

test("verify_done resets too — a verify-iterate loop is the GOAL, not exploration", () => {
  const st = newExploreState()
  for (let i = 0; i < 9; i++) observeExplore(st, "read", 10)
  expect(observeExplore(st, "verify_done", 10)).toBeNull()
  expect(st.reads).toBe(0)
})

test("bash: tree-mutating command resets; read-only shell consumes budget", () => {
  const st = newExploreState()
  for (let i = 0; i < 9; i++) observeExplore(st, "read", 10)
  // read-only bash consumes → crosses 10 → steer
  expect(observeExplore(st, "bash", 10, "cat setup.py && ls tests/")).toContain("EXPLORATION BUDGET")
  // a sed -i (tree edit) resets
  expect(observeExplore(st, "bash", 10, "sed -i 's/a/b/' src/x.py")).toBeNull()
  expect(st.reads).toBe(0)
})

test("neutral tools neither consume nor reset", () => {
  const st = newExploreState()
  for (let i = 0; i < 9; i++) observeExplore(st, "read", 10)
  expect(observeExplore(st, "change_quiz", 10)).toBeNull()
  expect(st.reads).toBe(9) // unchanged
})

test("nag-proofing: at most MAX_STEERS steers per turn", () => {
  const st = newExploreState()
  let n = 0
  for (let i = 0; i < 10 * (MAX_STEERS + 3); i++) if (observeExplore(st, "read", 10)) n++
  expect(n).toBe(MAX_STEERS)
})

test("steer text is actionable: names the requirements and the first-edit directive", () => {
  const s = exploreSteer(25, 25)
  expect(s).toContain("REQUIREMENTS")
  expect(s).toContain("IMPLEMENT")
})
