import { describe, expect, test } from "bun:test"
import { residencyDecision, residencyFile, parseServed } from "./residency"

// MEASURED 2026-08-20: switching the session's model while the previous one was still held produced
// "Cannot load kat-coder-v2.5-dev-optiq: projected memory 44.97GB would exceed the metal_cap memory
// ceiling 37.44GB (current: 23.52GB, model: 21.45GB)" and the turn failed outright. The runtime advertises
// LRU memory management but its guard refuses before the pool evicts, so the harness has to make room.
describe("one model resident at a time", () => {
  test("MEASURED: switching models evicts the previous one first", () => {
    const d = residencyDecision({ target: "kat-coder", lastServed: "heretic", residentCount: 1 })
    expect(d.evict).toBe(true)
    expect(d.reason).toContain("heretic")
    expect(d.reason).toContain("kat-coder")
  })

  test("the same model again is left warm — evicting it would only cost a reload", () => {
    expect(residencyDecision({ target: "kat-coder", lastServed: "kat-coder", residentCount: 1 }).evict).toBe(false)
  })

  test("a runtime holding nothing is not restarted", () => {
    expect(residencyDecision({ target: "kat-coder", lastServed: "heretic", residentCount: 0 }).evict).toBe(false)
  })

  test("an unknown past counts as another model — one reload beats a failed turn", () => {
    const d = residencyDecision({ target: "kat-coder", residentCount: 1 })
    expect(d.evict).toBe(true)
    expect(d.reason).toContain("does not know")
  })

  test("no target named — nothing to make room for", () => {
    expect(residencyDecision({ target: "", lastServed: "heretic", residentCount: 2 }).evict).toBe(false)
  })

  test("several held models are still one decision", () => {
    expect(residencyDecision({ target: "a", lastServed: "b", residentCount: 3 }).evict).toBe(true)
  })
})

describe("the record", () => {
  test("lives under the engine's own data root and follows MIMOCODE_HOME", () => {
    expect(residencyFile({ MIMOCODE_HOME: "/srv/fab" } as any)).toBe("/srv/fab/residency-dflash.json")
    expect(residencyFile({ XDG_DATA_HOME: "/d", HOME: "/h" } as any)).toBe("/d/fabula/residency-dflash.json")
    expect(residencyFile({ HOME: "/h" } as any)).toBe("/h/.local/share/fabula/residency-dflash.json")
  })

  test("a relative MIMOCODE_HOME is refused, exactly as the engine refuses it", () => {
    expect(residencyFile({ MIMOCODE_HOME: "rel", HOME: "/h" } as any)).toBe("/h/.local/share/fabula/residency-dflash.json")
  })

  test("an absent, empty or broken record reads as an unknown past", () => {
    expect(parseServed(undefined)).toBeUndefined()
    expect(parseServed("")).toBeUndefined()
    expect(parseServed("{oops")).toBeUndefined()
    expect(parseServed(JSON.stringify({ lastServed: "  " }))).toBeUndefined()
    expect(parseServed(JSON.stringify({ lastServed: "kat" }))).toBe("kat")
  })
})

// A pure test stays green against a plugin that computes the decision and then ignores it.
describe("the runtime plugin acts on the decision", () => {
  const src = require("node:fs").readFileSync(new URL("../fabula-dflash.ts", import.meta.url), "utf8") as string

  test("it asks before dispatching, not after a failure", () => {
    expect(src).toContain("residencyDecision({")
    expect(src.indexOf("residencyDecision({")).toBeLessThan(src.indexOf("await starting"))
  })

  test("an eviction really restarts the runtime rather than only being logged", () => {
    const block = src.slice(src.indexOf("const decision = residencyDecision"), src.indexOf("if (target)"))
    expect(block).toContain("decision.evict")
    expect(block).toContain("bringUp()")
  })

  // Scoped to the dflash branch on purpose: there are two writes now (the other clears the record when
  // this runtime is freed for another provider), and an unanchored indexOf would compare the wrong one.
  test("the record is written only after the runtime came up", () => {
    const branch = src.slice(src.indexOf("const decision = residencyDecision"))
    expect(branch.indexOf("await starting")).toBeLessThan(branch.indexOf("writeFile(residencyFile()"))
  })

  test("freeing this runtime for another provider clears the record", () => {
    const other = src.slice(src.indexOf("if (provider !== PROVIDER_ID)"), src.indexOf("const decision ="))
    expect(other).toContain("freeThisRuntime()")
    expect(other).toContain("writeFile(residencyFile()")
  })

  test("the count comes from the runtime, not from a guess", () => {
    expect(src).toContain("engine_pool?.loaded_count")
  })
})
