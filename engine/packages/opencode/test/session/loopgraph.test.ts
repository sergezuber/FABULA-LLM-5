// W4 — the ALDG guard. arXiv:2607.01641: Infinite Agentic Loops come from FRAMEWORK feedback edges, so the
// harness's own re-entry edges must be enumerated and bounded. THE DURABLE GUARD is the registry-completeness
// test: adding a gate whose truthy result re-enters the turn, without registering it in RE_ENTRY_EDGES, fails
// here. The budget itself is an OUTER bound — per-edge caps still fire first.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  RE_ENTRY_EDGES,
  reentryBudget,
  initReentry,
  chargeReentry,
  renderBudgetExhausted,
  DEFAULT_REENTRY_BUDGET,
  REENTRY_BUDGET_ENV,
  sumOfCaps,
} from "../../src/session/loopgraph"

const PROMPT = readFileSync(new URL("../../src/session/prompt.ts", import.meta.url), "utf8")

/** Every gate whose truthy result re-enters the run loop: a `yield*` call directly inside a condition
 *  (`if (yield* f(` / `(yield* f(`) whose line-tail or next two lines re-enter via a bare `continue` or
 *  `return "continue" as const`. Deliberately structural, so a NEW edge is picked up automatically. */
function extractReEntryGates(src: string): string[] {
  const lines = src.split("\n")
  const found = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\(yield\*\s+([A-Za-z_$][\w$]*)\s*\(/)
    if (!m) continue
    const window = lines.slice(i, i + 3).join("\n")
    if (/\bcontinue\b\s*$|\bcontinue\b\s*[;)}]|return\s+"continue"\s+as\s+const/m.test(window)) found.add(m[1])
  }
  return [...found].sort()
}

describe("ALDG registry", () => {
  test("every re-entering gate in prompt.ts is declared in RE_ENTRY_EDGES (add an edge ⇒ register it)", () => {
    const gates = extractReEntryGates(PROMPT)
    // The extractor must not silently match nothing — pin the edges we know are real.
    for (const known of ["taskGate", "goalGate", "autoContinueUnverified", "autoContinueOutputLength"]) {
      expect(gates).toContain(known)
    }
    const declared = new Set(RE_ENTRY_EDGES.map((e) => e.fn))
    const unregistered = gates.filter((g) => !declared.has(g))
    expect(unregistered).toEqual([]) // ← a NEW unbounded re-entry edge fails HERE
  })

  // The function-shaped extractor above CANNOT see a re-entry that isn't written as `(yield* fn(` — the
  // fact-check caught exactly that: an inline recovery block ending in a bare `continue` was a real edge
  // the guard was blind to. This is the tripwire for every OTHER shape: any change to the number of
  // re-entry constructs forces a human to classify the new one (register it as an edge, or confirm it is
  // ordinary control flow and update the constant). It counts inner-loop `continue`s too — that is the
  // deliberate trade: a noisy tripwire beats a blind spot.
  const RE_ENTRY_CONSTRUCTS = 43 // 29 bare `continue` + 14 `return "continue" as const` (2026-07-21: +1 post-compaction-stall, +1 compaction-failure-rescue — both REGISTERED in RE_ENTRY_EDGES, each cap 1 by construction)

  test("no new re-entry construct slipped in unclassified (tripwire)", () => {
    const bare = PROMPT.match(/(?<!["'])\bcontinue\b\s*(?:;|\n)/g)?.length ?? 0
    const ret = PROMPT.match(/return "continue" as const/g)?.length ?? 0
    expect(bare + ret).toBe(RE_ENTRY_CONSTRUCTS)
  })

  test("the function-less inline text-loop recovery edge still exists and is registered", () => {
    expect(PROMPT).toContain("textLoopRecoveryAttempts++") // the inline edge's own counter
    expect(RE_ENTRY_EDGES.some((e) => e.counter === "textLoopRecoveryAttempts")).toBe(true)
  })

  test("the registry is honest: ids/fns unique, declared counters and bound envs really exist", () => {
    expect(new Set(RE_ENTRY_EDGES.map((e) => e.id)).size).toBe(RE_ENTRY_EDGES.length)
    expect(new Set(RE_ENTRY_EDGES.map((e) => e.fn)).size).toBe(RE_ENTRY_EDGES.length)
    const counters = RE_ENTRY_EDGES.map((e) => e.counter).filter(Boolean) as string[]
    expect(counters.length).toBeGreaterThanOrEqual(4)
    for (const c of counters) expect(PROMPT).toContain(c)
  })
})

describe("shared re-entry budget", () => {
  // The default is DERIVED, so this asserts the derivation — not a number someone remembered. It must be
  // the MINIMAL never-truncating ceiling: a turn spending every edge's cap fits exactly, one more does not.
  test("default === sumOfCaps(): the minimal ceiling that never truncates a legitimate turn", () => {
    expect(DEFAULT_REENTRY_BUDGET).toBe(sumOfCaps())
    expect(DEFAULT_REENTRY_BUDGET).toBeGreaterThan(Math.max(...RE_ENTRY_EDGES.map((e) => e.cap)))
    expect(reentryBudget({})).toBe(DEFAULT_REENTRY_BUDGET)
    // sumOfCaps is a real function of the edge list, not a constant in a function's clothing
    expect(sumOfCaps([])).toBe(0)
    expect(sumOfCaps(RE_ENTRY_EDGES.slice(1))).toBe(sumOfCaps() - RE_ENTRY_EDGES[0].cap)
  })

  // 7 of the 9 caps are env-overridable at runtime, so a budget frozen at the source literals would
  // truncate work that is behaving perfectly within its own (raised) bounds.
  test("raising a per-edge cap by env raises the budget with it — never truncates the larger legitimate turn", () => {
    const raised = reentryBudget({ FABULA_NGRAM_MAX_RECOVERY: "10" })
    expect(raised).toBeGreaterThan(DEFAULT_REENTRY_BUDGET)
    expect(raised).toBe(sumOfCaps(RE_ENTRY_EDGES, { FABULA_NGRAM_MAX_RECOVERY: "10" }))
    // an explicit budget still wins over the derivation
    expect(reentryBudget({ FABULA_NGRAM_MAX_RECOVERY: "10", [REENTRY_BUDGET_ENV]: "5" })).toBe(5)
  })

  test("env parsing is total: unusable values fall back, \"0\" disables", () => {
    for (const bad of ["abc", "", "   ", "NaN", "Infinity", "-3"]) {
      expect(reentryBudget({ [REENTRY_BUDGET_ENV]: bad })).toBe(DEFAULT_REENTRY_BUDGET)
    }
    expect(reentryBudget({ [REENTRY_BUDGET_ENV]: "0" })).toBe(0)
    expect(reentryBudget({ [REENTRY_BUDGET_ENV]: "0007" })).toBe(7)
    expect(reentryBudget({ [REENTRY_BUDGET_ENV]: "3.7" })).toBe(3)
  })

  test("the budget bounds the COMPOSITION of distinct edges, and the refusal is sticky", () => {
    const s = initReentry(3)
    expect(chargeReentry(s, "a").allowed).toBe(true)
    expect(chargeReentry(s, "b").allowed).toBe(true)
    expect(chargeReentry(s, "c").total).toBe(3)
    const refused = chargeReentry(s, "d")
    expect(refused.allowed).toBe(false)
    expect(refused.reason).toMatch(/budget/i)
    expect(chargeReentry(s, "a").allowed).toBe(false) // sticky
  })

  test("interleaved edges never reset the shared total; the render names the per-edge split", () => {
    const s = initReentry(10)
    for (const id of ["A", "B", "A", "B"]) chargeReentry(s, id)
    expect(s.total).toBe(4)
    const text = renderBudgetExhausted(s)
    expect(text).toContain("A:2")
    expect(text).toContain("B:2")
    expect(text).toMatch(/NOT DONE/i)
  })

  test("kill-switch (budget 0) never refuses — today's per-edge-cap-only behavior", () => {
    const s = initReentry(0)
    for (let i = 0; i < 40; i++) expect(chargeReentry(s, "goal-judge").allowed).toBe(true)
    expect(s.total).toBe(40)
  })

  test("an unregistered edge id is still counted — never an invisible free re-entry", () => {
    const s = initReentry(5)
    const r = chargeReentry(s, "someBrandNewGate")
    expect(r.allowed).toBe(true)
    expect(r.total).toBe(1)
    expect(s.perEdge["someBrandNewGate"]).toBe(1)
  })

  test("state is per-turn, not module-global (concurrent turns must not share a tally)", () => {
    const a = initReentry(5), b = initReentry(5)
    chargeReentry(a, "x"); chargeReentry(a, "x")
    expect(chargeReentry(b, "x").total).toBe(1)
  })
})
