// change-quiz — a COMPREHENSION gate (Thariq Shihipar's "a quiz you must pass before merge"), built
// active per RULE #9. After a green verify with SOURCE changes, the agent must prove it understands
// its OWN diff before "done" stands. Catches the #1 local-model failure: copying a plausible pattern
// without grasping it (a change that passes tests but the agent can't explain is a change it can't
// safely own). Verification is grounded in the ACTUAL diff (via the aux model), not self-assessment —
// no theater. PURE core: prompt builders + grade parser + gate state.

/** Prompt: from a unified diff, generate exactly 3 comprehension questions an author must be able to
 * answer — what the change DOES, what it deliberately did NOT touch, and the riskiest edge case. */
export function quizPrompt(diff: string): string {
  return [
    "You are writing a 3-question COMPREHENSION QUIZ about the code change below (a unified diff).",
    "The questions must be answerable ONLY by someone who truly understands THIS change — not generic.",
    "Ask exactly these three, specialized to the diff:",
    "  Q1. What does this change actually DO — the behavior difference, concretely?",
    "  Q2. What did it deliberately NOT change / preserve (an existing behavior a careless edit would break)?",
    "  Q3. What is the riskiest edge case or input for this change, and how does it behave there?",
    "Output ONLY the three questions, numbered Q1/Q2/Q3, each specialized to the actual diff. No answers.",
    "",
    "=== DIFF ===",
    (diff || "(empty diff)").trim().slice(0, 12000),
  ].join("\n")
}

/** Prompt: grade the agent's ANSWERS against the diff. Must be strict — a vague/generic/wrong answer
 * fails. Verdict token is machine-readable. */
export function gradePrompt(diff: string, answers: string): string {
  return [
    "You are STRICTLY grading whether these answers prove real understanding of the code change (diff).",
    "Grade against the DIFF, not plausibility. An answer that is vague, generic, or contradicts the diff",
    "FAILS. All three must be substantively correct and specific to THIS change to pass.",
    "Reply EXACTLY in this shape:",
    "VERDICT: PASS   (or)   VERDICT: FAIL",
    "WHY: <one line per question: correct / what's wrong>",
    "",
    "=== DIFF ===",
    (diff || "(empty diff)").trim().slice(0, 10000),
    "",
    "=== ANSWERS ===",
    (answers || "(no answers given)").trim().slice(0, 6000),
  ].join("\n")
}

/** Parse the grade reply → { passed, detail }. Fail-closed: no clear PASS ⇒ not passed. */
export function parseGrade(text: string): { passed: boolean; detail: string } {
  const t = typeof text === "string" ? text : ""
  const m = t.match(/VERDICT:\s*(PASS|FAIL)/i)
  const passed = !!m && m[1].toUpperCase() === "PASS"
  const wm = t.match(/WHY:\s*([\s\S]*)$/i)
  return { passed, detail: (wm ? wm[1] : t).trim().slice(0, 800) }
}

export const CHANGE_QUIZ_STEER =
  "\n\n⚠️ CHANGE-QUIZ GATE: tests are green, but a change you cannot explain is a change you cannot own " +
  "(a plausible pattern copied without understanding is the #1 way a local-first patch is subtly wrong). " +
  "Before you claim done: call `change_quiz` (it asks 3 questions about YOUR diff), answer them, then call " +
  "`change_quiz` again with your `answers`. Done is NOT accepted until change_quiz returns PASS."

export interface QuizState {
  sourceChanged: boolean // a source file was edited this task
  passed: boolean        // change_quiz returned PASS this task
  steered: boolean       // the verify_done gate steer already fired once
  injected: boolean      // the per-turn reminder was injected once this task
}
export function newQuizState(): QuizState {
  return { sourceChanged: false, passed: false, steered: false, injected: false }
}

/** The verify_done gate steer fires when a green verify lands, source changed, the quiz hasn't passed,
 * and we haven't already nagged this task. */
export function shouldSteerQuiz(st: QuizState): boolean {
  return st.sourceChanged && !st.passed && !st.steered
}

/** SECOND, deterministic trigger (RULE #9): a local model may declare done WITHOUT ever calling
 * verify_done, so the verify_done-only gate never fires. On each model turn, once source has been
 * changed and the quiz hasn't passed, plant the requirement into the turn — no reliance on the model
 * choosing to verify. Fires once per task (the reminder then lives in context). */
export function shouldInjectQuizReminder(st: QuizState): boolean {
  return st.sourceChanged && !st.passed && !st.injected
}

export const CHANGE_QUIZ_REMINDER =
  "\n\n[FABULA change-quiz] You have changed source in this task. Do NOT declare it done until you have " +
  "passed `change_quiz`: call `change_quiz` (it asks 3 questions about your diff), answer them, then call " +
  "`change_quiz` again with your `answers` and get a PASS. A change you can't explain is a change you " +
  "can't safely ship."
