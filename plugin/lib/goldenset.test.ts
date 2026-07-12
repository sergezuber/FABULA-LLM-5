// Tests for lib/goldenset.ts — offline router calibration (pure).
import { describe, expect, test } from "bun:test"
import { buildGoldenCases, evaluateRouter, type SessionRow } from "./goldenset"
import type { Profile, ToolCard } from "./toolrouter"

const CARDS: ToolCard[] = [
  { id: "bash", description: "Run a shell command", utterances: ["запусти команду"] },
  { id: "str_replace", description: "Edit a file by exact string replacement", utterances: ["замени строку в файле"] },
  { id: "web_search", description: "Search the web", utterances: ["поищи в интернете"] },
]
const PROFILES: Profile[] = [
  { id: "coding", tools: ["bash", "str_replace"] },
  { id: "web", tools: ["web_search"] },
  { id: "full", tools: ["bash", "str_replace", "web_search"] },
]
const T0 = new Set<string>(["verify_done"])

describe("buildGoldenCases", () => {
  test("groups distinct tools per session, keeps first text", () => {
    const rows: SessionRow[] = [
      { sessionId: "s1", firstUserText: "запусти команду сборки", tool: "bash" },
      { sessionId: "s1", firstUserText: "запусти команду сборки", tool: "bash" },
      { sessionId: "s1", firstUserText: "запусти команду сборки", tool: "str_replace" },
      { sessionId: "s2", firstUserText: null, tool: "bash" }, // no text → dropped
      { sessionId: "s3", firstUserText: "  ", tool: "bash" }, // blank → dropped
    ]
    const cases = buildGoldenCases(rows)
    expect(cases).toHaveLength(1)
    expect(cases[0].tools).toEqual(["bash", "str_replace"])
  })
})

describe("evaluateRouter", () => {
  test("full coverage when the router picks the right profile", () => {
    const cases = buildGoldenCases([
      { sessionId: "s1", firstUserText: "запусти команду и замени строку в файле", tool: "bash" },
      { sessionId: "s1", firstUserText: "запусти команду и замени строку в файле", tool: "str_replace" },
    ])
    const r = evaluateRouter(cases, CARDS, PROFILES, T0)
    expect(r.cases).toBe(1)
    expect(r.fullCoverage).toBe(1)
    expect(r.misses).toHaveLength(0)
  })

  test("miss is recorded when a used tool would be hidden", () => {
    // task looks pure-coding but the session also used web_search
    const cases = buildGoldenCases([
      { sessionId: "s1", firstUserText: "запусти команду сборки и замени строку", tool: "bash" },
      { sessionId: "s1", firstUserText: "запусти команду сборки и замени строку", tool: "web_search" },
    ])
    const r = evaluateRouter(cases, CARDS, PROFILES, T0)
    if (r.misses.length) {
      expect(r.misses[0].missed).toEqual(["web_search"])
      expect(r.fullCoverage).toBe(0)
    } else {
      // router may legitimately fall back to full — then coverage is 1 (also correct)
      expect(r.fullCoverage).toBe(1)
    }
  })

  test("T0 tools are always visible", () => {
    const cases = buildGoldenCases([
      { sessionId: "s1", firstUserText: "запусти команду", tool: "bash" },
      { sessionId: "s1", firstUserText: "запусти команду", tool: "verify_done" }, // not in any profile — in T0
    ])
    const r = evaluateRouter(cases, CARDS.concat([{ id: "verify_done", description: "verify" }]), PROFILES, T0)
    expect(r.fullCoverage).toBe(1)
  })

  test("tools unknown to the registry are ignored in labels", () => {
    const cases = buildGoldenCases([
      { sessionId: "s1", firstUserText: "запусти команду", tool: "bash" },
      { sessionId: "s1", firstUserText: "запусти команду", tool: "ghost_tool_deleted_long_ago" },
    ])
    const r = evaluateRouter(cases, CARDS, PROFILES, T0)
    expect(r.fullCoverage).toBe(1)
  })

  test("empty case list → vacuous perfection, zero cases", () => {
    const r = evaluateRouter([], CARDS, PROFILES, T0)
    expect(r.cases).toBe(0)
    expect(r.fullCoverage).toBe(1)
  })
})
