import { test, expect } from "bun:test"
import { quizPrompt, gradePrompt, parseGrade, newQuizState, shouldSteerQuiz, shouldInjectQuizReminder, CHANGE_QUIZ_STEER, CHANGE_QUIZ_REMINDER } from "./changequiz"

test("shouldInjectQuizReminder: deterministic 2nd trigger — fires once after a source change, no verify_done needed", () => {
  const st = newQuizState()
  expect(shouldInjectQuizReminder(st)).toBe(false)  // no source change
  st.sourceChanged = true
  expect(shouldInjectQuizReminder(st)).toBe(true)   // source changed → inject (independent of verify_done)
  st.injected = true
  expect(shouldInjectQuizReminder(st)).toBe(false)  // once per task
  const st2 = newQuizState(); st2.sourceChanged = true; st2.passed = true
  expect(shouldInjectQuizReminder(st2)).toBe(false) // already passed → no reminder
  expect(CHANGE_QUIZ_REMINDER).toContain("change_quiz")
})

test("quizPrompt: 3 diff-grounded questions, no answers, embeds diff", () => {
  const p = quizPrompt("--- a/x.py\n+++ b/x.py\n+def f(): pass")
  expect(p).toContain("COMPREHENSION QUIZ")
  expect(p).toContain("Q1.")
  expect(p).toContain("Q2.")
  expect(p).toContain("Q3.")
  expect(p).toContain("No answers")
  expect(p).toContain("def f(): pass")
})

test("gradePrompt: strict, machine-readable verdict, embeds diff + answers", () => {
  const p = gradePrompt("diff here", "my answers")
  expect(p).toContain("STRICTLY grading")
  expect(p).toContain("VERDICT: PASS")
  expect(p).toContain("diff here")
  expect(p).toContain("my answers")
})

test("parseGrade: PASS / FAIL / fail-closed", () => {
  expect(parseGrade("VERDICT: PASS\nWHY: all correct").passed).toBe(true)
  expect(parseGrade("VERDICT: FAIL\nWHY: Q2 wrong").passed).toBe(false)
  expect(parseGrade("VERDICT: PASS").detail).toBe("VERDICT: PASS") // no WHY → whole text
  expect(parseGrade("garbage, no verdict").passed).toBe(false)     // fail-closed
  expect(parseGrade(undefined as any).passed).toBe(false)
})

test("parseGrade: extracts WHY detail", () => {
  const g = parseGrade("VERDICT: FAIL\nWHY: Q1 ok\nQ3 vague")
  expect(g.passed).toBe(false)
  expect(g.detail).toContain("Q1 ok")
})

test("shouldSteerQuiz: fires when source changed, not passed, not yet steered", () => {
  const st = newQuizState()
  expect(shouldSteerQuiz(st)).toBe(false)      // no source change yet
  st.sourceChanged = true
  expect(shouldSteerQuiz(st)).toBe(true)       // source changed, not passed → steer
  st.passed = true
  expect(shouldSteerQuiz(st)).toBe(false)      // quiz passed → done stands
})

test("shouldSteerQuiz: does not nag twice", () => {
  const st = newQuizState()
  st.sourceChanged = true
  st.steered = true
  expect(shouldSteerQuiz(st)).toBe(false)
  expect(CHANGE_QUIZ_STEER).toContain("change_quiz")
  expect(CHANGE_QUIZ_STEER).toContain("PASS")
})

// ── Terseness is part of the CONTRACT between the two prompts (2026-08-16) ────────────────────────
// The questions demand one-sentence answers; the grader is told terse-but-correct passes and to emit
// ONLY the verdict lines. Measured before the change: ~1,800 tokens of quiz answers across two failed
// cycles on one task — more than its code edit — plus prose before every verdict, all generated at
// model speed. These pins hold BOTH halves: drop either one and the pair punishes what it asks for.
import { describe as d2, expect as e2, test as t2 } from "bun:test"

d2("quiz prompts demand terseness on both sides", () => {
  t2("the questions ask for one-sentence answers", () => {
    e2(quizPrompt("--- a\n+++ b")).toContain("ONE sentence")
  })
  t2("the grader is told substance, never length", () => {
    e2(gradePrompt("--- a\n+++ b", "a1")).toContain("grade substance, never length")
  })
  t2("the grader is told the verdict is the whole reply", () => {
    e2(gradePrompt("--- a\n+++ b", "a1")).toContain("ONLY the two lines")
  })
})

// ── The tri-state verdict, pinned by the 2026-08-16 forensics ────────────────────────────────────
// 27 of 27 "fails" in one bench window were TRUNCATIONS (an output clamp below the model's
// un-switchable reasoning), several cut mid-sentence while approving the answers; the binary parser
// filed each as FAIL and the agent open-looped to the watchdog. A missing verdict is "unreadable" —
// never a fail. A PRESENT "VERDICT: FAIL" stays a real, fail-closed fail.
d2("parseGrade distinguishes a real fail from a truncated grade", () => {
  t2("explicit FAIL is a fail", () => {
    const g = parseGrade("VERDICT: FAIL\nWHY: Q1 wrong")
    e2(g.verdict).toBe("fail"); e2(g.passed).toBe(false)
  })
  t2("a truncated no-verdict reply is unreadable, not a fail", () => {
    const g = parseGrade("Looking at the answers, Q1 correctly identifies the pop()→")
    e2(g.verdict).toBe("unreadable"); e2(g.passed).toBe(false)
  })
  t2("explicit PASS still passes", () => {
    e2(parseGrade("VERDICT: PASS\nWHY: all correct").verdict).toBe("pass")
  })
})
