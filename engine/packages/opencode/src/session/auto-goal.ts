// Auto-goal — the mission default: the main loop never ends the turn until the
// user's work is actually done. Every real user task automatically arms the
// SAME goal gate that /goal uses (session/goal.ts + goalGate in prompt.ts); an
// independent judge then refuses the stop until the request is fulfilled.
//
// Pure decision logic lives here (unit-tested); prompt() wires it after
// createUserMessage. Rollout mirrors the tool router's precedent: the engine
// requires an explicit FABULA_AUTO_GOAL=1 (the .app ships it default-on), so
// tests/CI and bare `fabula serve` keep the historical stop behavior and the
// scripted-model test suite never pays a judge call.
//
// Guard rails against trapping the user:
//  - the judge is fail-open (goalGate catches judge errors and allows the stop);
//  - auto goals get their OWN re-entry cap (default 3, FABULA_AUTO_GOAL_MAX) —
//    far below /goal's MAX_GOAL_REACT=12, because the condition is derived, not
//    user-stated, and a mis-judged casual message must not spin for 12 rounds;
//  - an explicit /goal condition is never clobbered; a previous AUTO goal is
//    replaced on the next real user message (latest task wins).

export const AUTO_GOAL_ENV = "FABULA_AUTO_GOAL"
export const AUTO_GOAL_MAX_ENV = "FABULA_AUTO_GOAL_MAX"
const DEFAULT_AUTO_REACT_MAX = 3
/** Cap on the FINAL condition string (the TUI goal indicator renders it — keep
 *  it scannable). The request is clipped to whatever budget the framing leaves,
 *  so a longer preamble still yields a bounded condition. */
const CONDITION_BUDGET = 650
/** Preambles around the request; CONDITION_BUDGET minus this is the request clip. */
const CONDITION_PREAMBLE = 580

export function autoGoalEnabled(env: Record<string, string | undefined>): boolean {
  const v = (env[AUTO_GOAL_ENV] ?? "").trim().toLowerCase()
  return v === "1" || v === "true" || v === "on"
}

/** Re-entry cap for AUTO-armed goals. 0 is valid (judge runs once, never re-enters). */
export function autoGoalCap(env: Record<string, string | undefined>): number {
  const n = Number(env[AUTO_GOAL_MAX_ENV])
  if (Number.isFinite(n) && n >= 0) return Math.floor(n)
  return DEFAULT_AUTO_REACT_MAX
}

// Conversational acknowledgements / greetings — messages made ENTIRELY of these
// words carry no work to gate. Anything else (questions included: answering IS
// the work) arms the judge.
const ACK_WORDS = new Set([
  // ru
  "ок", "окей", "да", "нет", "ага", "угу", "спс", "спасибо", "благодарю", "привет",
  "здравствуй", "здравствуйте", "пока", "хорошо", "ладно", "понял", "поняла", "понятно",
  "отлично", "отличная", "работа", "супер", "круто", "класс", "молодец", "жду",
  // en
  "ok", "okay", "yes", "no", "nope", "yep", "thanks", "thank", "you", "ty", "hi", "hey",
  "hello", "bye", "fine", "nice", "cool", "great", "good", "awesome", "perfect", "lol",
  "got", "it", "sure",
])

/** Does this user message look like WORK (a task or substantive question) rather
 *  than a conversational acknowledgement? Deliberately permissive — the judge +
 *  low cap absorb false positives; a missed task breaks the mission. */
export function looksLikeTask(text: string): boolean {
  const t = text.trim()
  if (t.length === 0) return false
  // a bare slash-command token that fell through command dispatch (typo'd command)
  if (/^\/\S+$/.test(t)) return false
  const words = t.toLowerCase().split(/[\s.,:;!?…()"'«»„“”—–-]+/).filter(Boolean)
  if (words.length === 0) return false
  if (words.every((w) => ACK_WORDS.has(w) || /^[\p{Emoji}\p{P}+]+$/u.test(w))) return false
    // a single very short token ("go", "hm") is chatter; a single real word ("continue") is a task
  if (words.length === 1 && words[0].length < 4) return false
  return true
}

/** Build the judge condition from the user's request. The judge system prompt
 *  already frames "has this stopping condition been satisfied"; the condition
 *  adds the done-means-done bar (completed + verified, not planned/promised).
 *
 *  Change 3 (SECONDARY): the bar is COMPARATIVE, not absolute. The judge must
 *  ask "would continuing yield a verifiable improvement, or is the answer
 *  already sufficient?" rather than the rigid "is this verified?" — otherwise a
 *  same-model judge defaults to "not satisfied" on an answer that is, in fact,
 *  complete (the grey zone: work was done, an answer may already stand). SOTA:
 *  CaRT (arXiv:2510.08517), ablation 0.645 → 0.774. And an informational
 *  request that asks for no verifiable artifact (a question, an explanation) IS
 *  fulfilled by a direct answer — "verified where verification was possible"
 *  collapses to "answered" when no artifact is expected. */
export function autoGoalCondition(text: string): string {
  const t = text.trim().replace(/\s+/g, " ")
  // Clip the request so the FINAL condition stays scannable in the TUI. The
  // comparative framing (Change 3) is a longer preamble, so the request budget
  // is whatever CONDITION_BUDGET leaves after it — bounded, never unbounded.
  const clip = Math.max(80, CONDITION_BUDGET - CONDITION_PREAMBLE)
  const clipped = t.length > clip ? t.slice(0, clip).trimEnd() + "…" : t
  return [
    `The user's request below is genuinely fulfilled: the work was actually completed in this conversation`,
    `(and verified where verification was possible) — not merely planned, described, or promised.`,
    `Judge COMPARATIVELY, not absolutely: an informational request or explanation that asks for no`,
    `verifiable artifact IS fulfilled by a direct answer — "verified where verification was possible"`,
    `means "answered" when no artifact is expected. For work with an artifact, ask whether continuing`,
    `would yield a verifiable improvement, or whether the answer is already sufficient and complete.`,
    `Request: "${clipped}"`,
  ].join(" ")
}

/** THE arming decision, pure. `active` is the session's current goal (if any). */
export function shouldAutoArm(input: {
  enabled: boolean
  agentID: string | undefined
  source: string | undefined
  noReply: boolean | undefined
  active: { auto?: boolean } | undefined
  text: string
}): boolean {
  if (!input.enabled) return false
  if (input.noReply === true) return false
  // spawn/hook prompts are harness-internal turns, not user work requests
  if (input.source === "spawn" || input.source === "hook") return false
  // the gate itself is main-agent-only; arming elsewhere would strand the goal
  if ((input.agentID ?? "main") !== "main") return false
  // never clobber an explicit /goal; replace a stale AUTO goal (latest task wins)
  if (input.active && input.active.auto !== true) return false
  return looksLikeTask(input.text)
}

/**
 * Project-level guard for the AUTO goal (Change 2, PRIMARY). The goal gate is a
 * "prove the work" gate, so it must not arm in a project that has nothing to
 * prove: a non-verifiable repo (docs, prompts, plain Q&A) cannot satisfy a
 * "completed AND verified" condition, so arming only guarantees a false judge
 * verdict and an unbounded loop. Mirrors force-verify's own no-op on
 * non-verifiable projects (verify-gate.ts hasVerifyCommand) so the two gates
 * agree. SOTA: Agentic Abstention (arXiv:2606.28733) — ANSWER is a terminal
 * action; arming a verify-condition where verification is impossible turns a
 * terminal answer into an Infinite Agentic Loop (arXiv:2607.01641).
 *
 * `hasVerifyCmd` is the same signal the prompt() wiring computes from the
 * project tree (readdir + hasVerifyCommand), kept pure here for unit testing.
 */
export function shouldArmForProject(input: { hasVerifyCmd: boolean }): boolean {
  return input.hasVerifyCmd
}
