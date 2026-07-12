// Tests for lib/toolusage.ts — Context OS Phase 0 tiering (pure).
import { describe, expect, test } from "bun:test"
import {
  GATE_REQUIRED_TOOLS,
  computeTiers,
  mapImportedName,
  renderTiers,
  usageHistogram,
  type UsageRow,
} from "./toolusage"

function rows(spec: Record<string, string[]>): UsageRow[] {
  // spec: tool -> list of sessionIds (one call per entry; repeat a session for multiple calls)
  const out: UsageRow[] = []
  for (const [tool, sess] of Object.entries(spec)) for (const s of sess) out.push({ sessionId: s, tool })
  return out
}

describe("usageHistogram", () => {
  test("counts calls, distinct sessions, shares; sorted by calls desc", () => {
    const h = usageHistogram(
      rows({
        bash: ["s1", "s1", "s2", "s3"], // 4 calls, 3 sessions
        edit: ["s1", "s2"], // 2 calls, 2 sessions
        weather_fetch: ["s3"], // 1 call, 1 session
      }),
    )
    expect(h.map((s) => s.tool)).toEqual(["bash", "edit", "weather_fetch"])
    expect(h[0]).toMatchObject({ calls: 4, sessions: 3 })
    expect(h[0].callShare).toBeCloseTo(4 / 7)
    expect(h[0].sessionShare).toBeCloseTo(1) // present in all 3 of 3 sessions
    expect(h[2].sessionShare).toBeCloseTo(1 / 3)
  })

  test("deterministic tie-break by tool name", () => {
    const h = usageHistogram(rows({ b: ["s1"], a: ["s2"] }))
    expect(h.map((s) => s.tool)).toEqual(["a", "b"])
  })

  test("empty input → empty histogram", () => {
    expect(usageHistogram([])).toEqual([])
  })

  test("rows with empty tool name are ignored", () => {
    const h = usageHistogram([{ sessionId: "s", tool: "" }, { sessionId: "s", tool: "bash" }])
    expect(h).toHaveLength(1)
  })
})

describe("computeTiers", () => {
  test("session-share rule (a) pins ubiquitous tools to T0", () => {
    const t = computeTiers(
      rows({
        bash: ["s1", "s2", "s3", "s4"], // 100% of sessions
        rare: ["s1"],
      }),
      { t0CumulativeCalls: 0 }, // disable rule (b) to isolate (a)
    )
    expect(t.t0).toContain("bash")
    expect(t.t0).not.toContain("rare")
  })

  test("cumulative-calls rule (b) pins the head that covers ≥80% of calls", () => {
    // heavy: 8 calls of 10 (80%); mid: 1; tail: 1 — heavy alone crosses the threshold
    const t = computeTiers(
      rows({
        heavy: ["a", "a", "a", "a", "b", "b", "b", "b"],
        mid: ["c"],
        tail: ["d"],
      }),
      { t0SessionShare: 2 }, // disable rule (a)
    )
    expect(t.t0).toContain("heavy")
    expect(t.t0).not.toContain("mid")
  })

  test("gate-required tools are in T0 even with ZERO usage", () => {
    const t = computeTiers(rows({ bash: ["s1"] }))
    for (const g of GATE_REQUIRED_TOOLS) expect(t.t0).toContain(g)
  })

  test("T2 catches the long tail; T1 gets the middle; no overlap with T0", () => {
    // 100 sessions; looper appears in 20 (20% > 5% → T1); oddball in 1 session 1 call (<5% sess, <1% calls → T2)
    const spec: Record<string, string[]> = { main: [], looper: [], oddball: ["s0"] }
    for (let i = 0; i < 100; i++) spec.main.push(`s${i}`, `s${i}`) // 200 calls everywhere
    for (let i = 0; i < 20; i++) spec.looper.push(`s${i}`)
    const t = computeTiers(rows(spec))
    expect(t.t0).toContain("main")
    expect(t.t1).toContain("looper")
    expect(t.t2).toContain("oddball")
    const all = new Set([...t.t0, ...t.t1, ...t.t2])
    expect(all.size).toBe(t.t0.length + t.t1.length + t.t2.length) // disjoint
  })

  test("extraT0 unions in", () => {
    const t = computeTiers([], { extraT0: ["my_special"] })
    expect(t.t0).toContain("my_special")
  })

  test("empty rows → T0 is exactly the structural set", () => {
    const t = computeTiers([])
    expect(t.t0.sort()).toEqual([...GATE_REQUIRED_TOOLS].sort())
    expect(t.t1).toEqual([])
    expect(t.t2).toEqual([])
  })
})

describe("mapImportedName", () => {
  test("known import-format names map to native ids", () => {
    expect(mapImportedName("Bash")).toBe("bash")
    expect(mapImportedName("Edit")).toBe("edit")
    expect(mapImportedName("Task")).toBe("actor")
  })
  test("unknown names return null — never guessed", () => {
    expect(mapImportedName("SomethingNew")).toBeNull()
    expect(mapImportedName("bash")).toBeNull() // native ids are not import names
  })
})

describe("renderTiers", () => {
  test("renders counts and tier lists", () => {
    const t = computeTiers(rows({ bash: ["s1", "s2"] }))
    const s = renderTiers(t)
    expect(s).toContain("T0 (resident,")
    expect(s).toContain("bash")
    expect(s).toContain("verify_done")
  })
})
