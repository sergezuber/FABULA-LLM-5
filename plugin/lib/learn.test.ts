import { test, expect } from "bun:test"
import { newLearnState, shouldNudgeLearn, LEARN_MIN_EDITS, LEARN_NUDGE } from "./learn"

test("fresh state nudges nothing", () => {
  expect(shouldNudgeLearn(newLearnState())).toBe(false)
})

test("verified but too few edits → no nudge", () => {
  const st = newLearnState()
  st.verified = true
  st.edits = LEARN_MIN_EDITS - 1
  expect(shouldNudgeLearn(st)).toBe(false)
})

test("verified + enough edits → nudge", () => {
  const st = newLearnState()
  st.verified = true
  st.edits = LEARN_MIN_EDITS
  expect(shouldNudgeLearn(st)).toBe(true)
})

test("edits without a green verify → no nudge", () => {
  const st = newLearnState()
  st.edits = 10
  expect(shouldNudgeLearn(st)).toBe(false)
})

test("fires at most once (nudged guard)", () => {
  const st = newLearnState()
  st.verified = true
  st.edits = 5
  st.nudged = true
  expect(shouldNudgeLearn(st)).toBe(false)
})

test("nudge points at distill", () => {
  expect(LEARN_NUDGE).toContain("/distill")
})
