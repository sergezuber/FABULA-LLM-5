// Tests for lib/toolcards.ts — the closed belt-profile registry (Context OS Phase 1).
import { describe, expect, test } from "bun:test"
import { ALWAYS_ON } from "./toolbelt"
import { GATE_REQUIRED_TOOLS } from "./toolusage"
import { BELT_PROFILES, ENGINE_BUILTIN_CARDS, buildToolCards, hideSetFor, isCodeNavServer, isWebServer, mcpServerCards } from "./toolcards"

describe("buildToolCards", () => {
  // deployment-realistic MCP server names (never hardcode "serena" — RULE #13)
  const SERVERS = ["code-go-serena", "code-structural-search", "web-search-internet", "current-time"]
  const cards = buildToolCards(SERVERS)
  test("covers engine builtins + plugin meta + LIVE mcp servers, unique ids", () => {
    const ids = cards.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain("bash") // engine
    expect(ids).toContain("verify_done") // plugin meta
    expect(ids).toContain("code-go-serena") // mcp server card from the live config names
    expect(cards.length).toBeGreaterThan(40)
  })
  test("head tools carry RU+EN utterances (router signal for both task languages)", () => {
    const bash = ENGINE_BUILTIN_CARDS.find((c) => c.id === "bash")!
    expect(bash.utterances!.some((u) => /[а-я]/.test(u))).toBe(true)
    expect(bash.utterances!.some((u) => /^[a-z ]+$/i.test(u))).toBe(true)
  })
})

describe("BELT_PROFILES — closed nested registry", () => {
  const cards = buildToolCards()
  test("exactly the three v1 profiles; full is widest and hides nothing", () => {
    expect(BELT_PROFILES.map((p) => p.id)).toEqual(["coding", "web-research", "full"])
    const full = BELT_PROFILES.find((p) => p.id === "full")!
    expect(full.hideExact()).toEqual([])
    expect(full.hideGlobs()).toEqual([])
    expect(full.visibleForScoring(cards)).toHaveLength(cards.length)
  })
  test("visible sets NEST: coding ⊆ web∪coding ⊆ full (profile switch = delta re-prefill)", () => {
    const vis = Object.fromEntries(BELT_PROFILES.map((p) => [p.id, new Set(p.visibleForScoring(cards))]))
    for (const id of vis["coding"]) expect(vis["full"].has(id)).toBe(true)
    for (const id of vis["web-research"]) expect(vis["full"].has(id)).toBe(true)
  })
  test("web-research keeps web tools that coding hides", () => {
    const web = BELT_PROFILES.find((p) => p.id === "web-research")!
    expect(web.hideExact()).not.toContain("weather_fetch")
    expect(web.hideExact()).not.toContain("image_search")
    const coding = BELT_PROFILES.find((p) => p.id === "coding")!
    expect(coding.hideExact()).toContain("weather_fetch")
  })
  test("code-nav server classifier covers deployment-style names (no hardcoded ids)", () => {
    expect(isCodeNavServer("code-go-serena")).toBe(true)
    expect(isCodeNavServer("code-structural-search")).toBe(true)
    expect(isCodeNavServer("ast-grep")).toBe(true)
    expect(isCodeNavServer("web-search-internet")).toBe(false)
    expect(isCodeNavServer("current-time")).toBe(false)
    expect(isWebServer("web-search-internet")).toBe(true)
    expect(isWebServer("current-time")).toBe(false)
  })
  test("mcpServerCards derives kind-specific routing cards from live names", () => {
    const cards = mcpServerCards(["code-go-serena", "web-search-internet", "current-time"])
    expect(cards.find((c) => c.id === "code-go-serena")!.utterances).toBeDefined()
    expect(cards.find((c) => c.id === "web-search-internet")!.tags).toContain("web")
    expect(cards.find((c) => c.id === "current-time")!.tags).toContain("mcp")
  })
})

describe("hideSetFor — the safety floor", () => {
  test("never hides gate tools or ALWAYS_ON, whatever the profile says", () => {
    for (const p of BELT_PROFILES) {
      const { exact } = hideSetFor(p.id)
      for (const g of GATE_REQUIRED_TOOLS) expect(exact).not.toContain(g)
      for (const a of ALWAYS_ON) expect(exact).not.toContain(a)
    }
  })
  test("verbatim-pinned id is removed from the hide set", () => {
    const base = hideSetFor("coding")
    expect(base.exact).toContain("weather_fetch")
    const pinned = hideSetFor("coding", ["weather_fetch"])
    expect(pinned.exact).not.toContain("weather_fetch")
  })
  test("pinned MCP server un-hides its glob (live-style server names)", () => {
    const servers = ["code-go-serena", "web-search-internet"]
    const base = hideSetFor("web-research", [], servers)
    expect(base.globs).toContain("code-go-serena_*")
    const pinned = hideSetFor("web-research", ["code-go-serena"], servers)
    expect(pinned.globs).not.toContain("code-go-serena_*")
  })
  test("unknown profile fails OPEN (hide nothing)", () => {
    expect(hideSetFor("nonexistent")).toEqual({ exact: [], globs: [] })
  })
  test("hide sets are sorted (byte-stable prefix per profile)", () => {
    const { exact } = hideSetFor("coding")
    expect(exact).toEqual([...exact].sort())
  })
})
