import { test, expect, describe } from "bun:test"
import {
  DEFAULT_BUDGET,
  budgetFromEnv,
  ESCALATION_LADDER,
  nextRung,
  withinBudget,
  relayMessages,
  parseDiff,
  attemptEntry,
} from "./relay"

describe("escalation ladder", () => {
  test("climbs local → cloud advice → cloud direct-work → need-input", () => {
    expect(ESCALATION_LADDER.map((r) => r.strategy)).toEqual(["direct", "rewind-retry", "advice", "with-hint", "direct-work", "need-input"])
    expect(ESCALATION_LADDER.find((r) => r.strategy === "direct-work")?.actor).toBe("cloud")
  })
  test("nextRung advances, null at the top", () => {
    expect(nextRung(0)?.strategy).toBe("rewind-retry")
    expect(nextRung(ESCALATION_LADDER.length - 1)).toBeNull()
  })
})

describe("budget", () => {
  test("env override + defaults", () => {
    expect(budgetFromEnv({}).maxAttempts).toBe(DEFAULT_BUDGET.maxAttempts)
    expect(budgetFromEnv({ FABULA_RELAY_MAX_ATTEMPTS: "3", FABULA_RELAY_MAX_COST_USD: "2.5", FABULA_RELAY_MAX_TIME_MIN: "10" })).toEqual({ maxAttempts: 3, maxCostUsd: 2.5, maxTimeMs: 600000 })
  })
  test("within budget until a ceiling is hit", () => {
    const b = { maxAttempts: 3, maxCostUsd: 1, maxTimeMs: 1000 }
    expect(withinBudget({ attempts: 2, costUsd: 0.5, elapsedMs: 500 }, b).ok).toBe(true)
    expect(withinBudget({ attempts: 3, costUsd: 0, elapsedMs: 0 }, b)).toMatchObject({ ok: false })
    expect(withinBudget({ attempts: 0, costUsd: 1, elapsedMs: 0 }, b).reason).toContain("cost")
    expect(withinBudget({ attempts: 0, costUsd: 0, elapsedMs: 1000 }, b).reason).toContain("time")
  })
})

describe("relayMessages", () => {
  const m = relayMessages("fix export", "tried A", "code B")
  test("demands ONLY a unified diff and states the patch is gated", () => {
    expect(m[0].content).toContain("UNIFIED DIFF")
    expect(m[0].content).toContain("NOT trusted")
    expect(m[0].content).toContain("verify/reproduce/change-quiz")
  })
  test("carries task/tried/context", () => {
    expect(m[1].content).toContain("fix export")
    expect(m[1].content).toContain("tried A")
    expect(m[1].content).toContain("code B")
  })
})

const DIFF = `diff --git a/x.txt b/x.txt
index e69..d00 100644
--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-0
+1`

describe("parseDiff", () => {
  test("bare diff", () => {
    const r = parseDiff(DIFF)
    expect("diff" in r && r.diff).toContain("@@ -1 +1 @@")
    expect("diff" in r && r.diff.endsWith("\n")).toBe(true)
  })
  test("fenced ```diff block", () => {
    const r = parseDiff("Here is the fix:\n\n```diff\n" + DIFF + "\n```\nDone.")
    expect("diff" in r).toBe(true)
  })
  test("leading prose before a bare diff", () => {
    expect("diff" in parseDiff("Sure — apply this:\n\n" + DIFF)).toBe(true)
  })
  test("NO PATCH → error with the reason", () => {
    const r = parseDiff("NO PATCH: the task is underspecified")
    expect("error" in r && r.error).toContain("underspecified")
  })
  test("prose with no diff → error", () => {
    expect("error" in parseDiff("I think you should refactor the module.")).toBe(true)
  })
  test("fence without a real diff → error", () => {
    expect("error" in parseDiff("```\njust some text\n```")).toBe(true)
  })
})

describe("attemptEntry — receipt history record", () => {
  test("shape", () => {
    const rung = ESCALATION_LADDER[4]
    expect(attemptEntry(3, rung, "verified", 99, { model: "kimi-k2", reason: "green" })).toEqual({
      attempt: 3, actor: "cloud", strategy: "direct-work", model: "kimi-k2", result: "verified", reason: "green", at: 99,
    })
  })
})
