import { describe, expect, test } from "bun:test"
import {
  autoGoalEnabled,
  autoGoalCap,
  looksLikeTask,
  autoGoalCondition,
  shouldAutoArm,
  shouldArmForProject,
} from "../../src/session/auto-goal"

describe("autoGoalEnabled", () => {
  test("off by default (engine-level opt-in; the .app ships it on)", () => {
    expect(autoGoalEnabled({})).toBe(false)
    expect(autoGoalEnabled({ FABULA_AUTO_GOAL: "" })).toBe(false)
    expect(autoGoalEnabled({ FABULA_AUTO_GOAL: "0" })).toBe(false)
    expect(autoGoalEnabled({ FABULA_AUTO_GOAL: "false" })).toBe(false)
  })
  test("explicit on", () => {
    expect(autoGoalEnabled({ FABULA_AUTO_GOAL: "1" })).toBe(true)
    expect(autoGoalEnabled({ FABULA_AUTO_GOAL: "true" })).toBe(true)
    expect(autoGoalEnabled({ FABULA_AUTO_GOAL: "on" })).toBe(true)
  })
})

describe("autoGoalCap", () => {
  test("default 3; env override; 0 valid; garbage falls back", () => {
    expect(autoGoalCap({})).toBe(3)
    expect(autoGoalCap({ FABULA_AUTO_GOAL_MAX: "7" })).toBe(7)
    expect(autoGoalCap({ FABULA_AUTO_GOAL_MAX: "0" })).toBe(0)
    expect(autoGoalCap({ FABULA_AUTO_GOAL_MAX: "-2" })).toBe(3)
    expect(autoGoalCap({ FABULA_AUTO_GOAL_MAX: "abc" })).toBe(3)
  })
})

describe("looksLikeTask", () => {
  test("tasks and substantive questions arm", () => {
    expect(looksLikeTask("почини баг в belt.ts и прогони тесты")).toBe(true)
    expect(looksLikeTask("почему модель закончила диалог?")).toBe(true)
    expect(looksLikeTask("продолжай")).toBe(true)
    expect(looksLikeTask("Fix the flaky test in prompt.ts")).toBe(true)
    expect(looksLikeTask("СТАРТУЙ!")).toBe(true)
  })
  test("acks/greetings/chatter do not arm", () => {
    expect(looksLikeTask("")).toBe(false)
    expect(looksLikeTask("   ")).toBe(false)
    expect(looksLikeTask("привет")).toBe(false)
    expect(looksLikeTask("ок, спасибо!")).toBe(false)
    expect(looksLikeTask("thanks!")).toBe(false)
    expect(looksLikeTask("да")).toBe(false)
    expect(looksLikeTask("отлично, молодец")).toBe(false)
    expect(looksLikeTask("👍")).toBe(false)
    expect(looksLikeTask("го")).toBe(false)
  })
  test("bare slash-command token (typo fallthrough) does not arm", () => {
    expect(looksLikeTask("/goall")).toBe(false)
    // but a slash command WITH arguments is a task
    expect(looksLikeTask("/deploy the staging branch")).toBe(true)
  })
})

describe("autoGoalCondition", () => {
  test("embeds the request verbatim, collapses whitespace", () => {
    const c = autoGoalCondition("почини   баг\nи прогони тесты")
    expect(c).toContain('"почини баг и прогони тесты"')
    expect(c).toContain("not merely planned")
  })
  test("clips long requests so the final condition stays bounded and scannable", () => {
    const c = autoGoalCondition("x".repeat(1000))
    expect(c).toContain("…")
    // The comparative framing (Change 3) is a longer preamble than the old
    // absolute bar; the request is clipped so the final condition stays bounded
    // (~700, not unbounded) and readable in the TUI goal indicator.
    expect(c.length).toBeLessThan(700)
  })
  // ── Change 3 (SECONDARY): comparative framing for the judge. The condition
  // must not be an absolute "is this verified?" — for the grey zone (work was
  // done but an answer may already be complete) the judge should ask the CaRT
  // comparative: "would continuing yield a verifiable improvement, or is the
  // answer already sufficient?" This stops a same-model judge from defaulting to
  // "not satisfied" on an answer that is, in fact, complete. SOTA: CaRT
  // (arXiv:2510.08517), ablation 0.645 → 0.774. Also: an informational request
  // that asks for no verifiable artifact (a question, an explanation) IS
  // fulfilled by a direct answer.
  test("uses comparative framing (would continuation improve, or is it complete)", () => {
    const c = autoGoalCondition("explain how X works")
    expect(c).toMatch(/sufficient|already complete|would .*(continu|further)/i)
  })
  test("an informational request (no artifact expected) is fulfilled by an answer", () => {
    const c = autoGoalCondition("explain how X works")
    expect(c).toMatch(/informational|explanation|direct answer|no verifiable artifact/i)
  })
})

describe("shouldAutoArm", () => {
  const base = {
    enabled: true,
    agentID: undefined as string | undefined,
    source: "user" as string | undefined,
    noReply: undefined as boolean | undefined,
    active: undefined as { auto?: boolean } | undefined,
    text: "почини баг и прогони тесты",
  }
  test("arms for a real user task on main", () => {
    expect(shouldAutoArm(base)).toBe(true)
    expect(shouldAutoArm({ ...base, source: undefined })).toBe(true)
    expect(shouldAutoArm({ ...base, agentID: "main" })).toBe(true)
  })
  test("kill-switch, noReply, spawn/hook, non-main all skip", () => {
    expect(shouldAutoArm({ ...base, enabled: false })).toBe(false)
    expect(shouldAutoArm({ ...base, noReply: true })).toBe(false)
    expect(shouldAutoArm({ ...base, source: "spawn" })).toBe(false)
    expect(shouldAutoArm({ ...base, source: "hook" })).toBe(false)
    expect(shouldAutoArm({ ...base, agentID: "explore" })).toBe(false)
  })
  test("never clobbers an explicit /goal; replaces a stale auto goal", () => {
    expect(shouldAutoArm({ ...base, active: { auto: undefined } })).toBe(false)
    expect(shouldAutoArm({ ...base, active: { auto: false } })).toBe(false)
    expect(shouldAutoArm({ ...base, active: { auto: true } })).toBe(true)
  })
  test("conversational text skips even when everything else allows", () => {
    expect(shouldAutoArm({ ...base, text: "спасибо!" })).toBe(false)
  })
})

// ── Change 2 (PRIMARY): the goal gate is a "prove the work" gate, so it must
// not arm in a project that has nothing to prove — a non-verifiable repo (docs,
// prompts, plain Q&A) cannot satisfy a "completed AND verified" condition, so
// arming only guarantees a false judge verdict and a loop. Pure project-level
// predicate; mirrors force-verify's own no-op on non-verifiable projects
// (verify-gate.ts hasVerifyCommand). SOTA: Agentic Abstention — ANSWER is a
// terminal action; arming a verify-condition where verification is impossible
// turns a terminal answer into an unbounded loop.
describe("shouldArmForProject (arming is unconditional — the loop protections moved)", () => {
  test("arms when the project HAS a verify command", () => {
    expect(shouldArmForProject({ hasVerifyCmd: true })).toBe(true)
  })
  test("arms EVEN WITHOUT a verify command — a book/docs corpus is where long tasks die quietly", () => {
    // The old restriction disarmed the finish-the-job gate on every corpus with no test suite.
    // Measured live (2026-07-21): a "read all chapters" session ended three times at a text-only
    // "continuing in batches" announcement — nothing was armed to ask "is the job done?". The
    // conversational-loop protection this restriction once provided lives in the stop-layer now,
    // which honors a stop on any TOOL-FREE turn without calling the judge (see verify-gate tests).
    expect(shouldArmForProject({ hasVerifyCmd: false })).toBe(true)
  })
})
