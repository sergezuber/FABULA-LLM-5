// The edge is a contract. These cover the three ways it used to break silently: a failed step arriving
// as a plausible string, a cut nobody could see, and a verdict with no consequence.

import { describe, expect, test } from "bun:test"
import { clip, stepPrompt, synthesizePrompt, verifyStep, parseGraph, closeTruncatedJson, MISSING_INPUT, MIN_STEP_CHARS, STEP_PREAMBLE, type Step } from "./graph"

const step = (over: Partial<Step> = {}): Step => ({
  id: "s2",
  role: "build",
  description: "write the thing",
  needs: ["s1"],
  ...over,
})

describe("clip — a cut that says so", () => {
  test("short text passes through untouched", () => {
    expect(clip("hello", 100)).toBe("hello")
  })

  test("a cut declares how much it removed and of what", () => {
    const out = clip("x".repeat(3400), 2000)
    expect(out).toContain("[truncated 1400 of 3400 chars]")
    // The kept part is still the head of the original, not a summary of it.
    expect(out.startsWith("x".repeat(2000))).toBe(true)
  })

  test("a step's real output size is not lost silently", () => {
    // Steps generate up to ~800 tokens ≈ 3 200 characters against a 2 000-character edge.
    expect(clip("y".repeat(3200), 2000)).toMatch(/truncated \d+ of 3200/)
  })
})

describe("a missing input is named, never fabricated", () => {
  test("a null dependency is announced as absent, with an instruction to proceed", () => {
    const p = stepPrompt(step(), { s1: null })
    expect(p).toContain(MISSING_INPUT)
    expect(p).toContain("proceed without it")
  })

  test("an empty dependency is treated as absent too", () => {
    expect(stepPrompt(step(), { s1: "" })).toContain(MISSING_INPUT)
  })

  test("a real dependency is passed as data, not as an absence", () => {
    const p = stepPrompt(step(), { s1: "the finding" })
    expect(p).toContain("the finding")
    expect(p).not.toContain(MISSING_INPUT)
  })

  test("a long dependency is clipped visibly on the edge", () => {
    expect(stepPrompt(step(), { s1: "z".repeat(3000) })).toContain("[truncated 1000 of 3000 chars]")
  })
})

describe("the synthesiser is told where the holes are", () => {
  test("a step with no output is named, with an instruction not to invent it", () => {
    const p = synthesizePrompt("task", [
      { id: "s1", role: "explore", text: null, degraded: "returned a refusal" },
      { id: "s2", role: "build", text: "the result" },
    ])
    expect(p).toContain("NO OUTPUT")
    expect(p).toContain("returned a refusal")
    expect(p).toContain("Do not invent")
    expect(p).toContain("the result")
  })

  test("a healthy run says nothing about holes", () => {
    const p = synthesizePrompt("task", [{ id: "s1", role: "build", text: "done properly" }])
    expect(p).not.toContain("NO OUTPUT")
  })

  test("synthesis input is clipped visibly as well", () => {
    const p = synthesizePrompt("task", [{ id: "s1", role: "build", text: "q".repeat(2600) }])
    expect(p).toContain("[truncated 600 of 2600 chars]")
  })
})

describe("verifyStep — what can be checked, and nothing more", () => {
  test("a substantive result passes", () => {
    expect(verifyStep(step(), "I changed the parser to accept the flat form and the suite is green.").ok).toBe(true)
  })

  test("nothing at all fails", () => {
    expect(verifyStep(step(), null).ok).toBe(false)
    expect(verifyStep(step(), "   ").ok).toBe(false)
  })

  test("an acknowledgement is not a result", () => {
    const v = verifyStep(step(), "ok")
    expect(v.ok).toBe(false)
    expect(v.note).toContain("too little")
  })

  test("a refusal is not a result", () => {
    expect(verifyStep(step(), "I cannot complete this subtask without more information.").ok).toBe(false)
    expect(verifyStep(step(), "Error: the tool was unavailable and nothing could be done here.").ok).toBe(false)
  })

  test("it no longer greps the step's own self-report", () => {
    // THE DEFECT, verbatim: the old criterion required one of verif|test|check|pass|lint|build|ran in a
    // build step's prose, so this sentence PASSED because it contains the word "check".
    const denial = "I did not check anything and ran no tests; here is my guess at the answer instead."
    expect(verifyStep(step({ role: "build" }), denial).ok).toBe(true)
    // And the mirror: a genuine result that happens to use none of those words is no longer punished.
    const silent = "The flat payload is wrapped before the strict keys are stripped, so the discriminator survives."
    expect(verifyStep(step({ role: "build" }), silent).ok).toBe(true)
  })

  test("the length floor is a named policy, not a magic number in the branch", () => {
    expect(verifyStep(step(), "x".repeat(MIN_STEP_CHARS - 1)).ok).toBe(false)
    expect(verifyStep(step(), "x".repeat(MIN_STEP_CHARS)).ok).toBe(true)
  })
})

describe("prefix-cache layout — constant first, variable last", () => {
  test("every step opens with the same bytes, whatever its role", () => {
    const a = stepPrompt({ id: "s1", role: "explore", description: "look", needs: [] }, {})
    const b = stepPrompt({ id: "s2", role: "build", description: "make", needs: [] }, {})
    expect(a.startsWith(STEP_PREAMBLE)).toBe(true)
    expect(b.startsWith(STEP_PREAMBLE)).toBe(true)
  })

  test("the shared opening is substantial, not a token or two", () => {
    const a = stepPrompt({ id: "s1", role: "explore", description: "look", needs: [] }, {})
    const b = stepPrompt({ id: "s2", role: "build", description: "make", needs: [] }, {})
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    expect(i).toBeGreaterThanOrEqual(STEP_PREAMBLE.length)
  })

  test("what varies stays at the tail: the subtask never appears before the constant block ends", () => {
    const p = stepPrompt({ id: "s1", role: "build", description: "UNIQUEMARKER", needs: [] }, {})
    expect(p.indexOf("UNIQUEMARKER")).toBeGreaterThan(STEP_PREAMBLE.length)
  })
})

// MEASURED 2026-08-01: a full workflow_graph run reported "1 step(s)" — the silent fallback — while the
// planner had emitted a valid 4-step diamond whose reply was ONE closing brace short. Across four planner
// calls, three parsed (4, 5, 4 steps) and the fourth returned null; `parseGraph(raw + "}")` parsed it
// into 5 steps. So about one run in four lost its entire orchestration and the trace read as though one
// step had been intended. This function's own comment promised "parse loosely"; it was a plain JSON.parse.
describe("a planner reply cut one bracket short still becomes a graph", () => {
  const FULL = JSON.stringify({
    steps: [
      { id: "s1", role: "explore", description: "read the contract" },
      { id: "s2", role: "build", description: "implement A", needs: ["s1"] },
      { id: "s3", role: "build", description: "implement B", needs: ["s1"] },
      { id: "s4", role: "verify", description: "synthesise", needs: ["s1", "s2", "s3"] },
    ],
  })

  test("the complete reply parses, as it always did", () => {
    expect(parseGraph(FULL).graph?.steps.length).toBe(4)
  })

  test("the SAME reply missing its last brace parses to the same graph", () => {
    const cut = FULL.slice(0, -1) // exactly the measured failure: one closing brace short
    expect(parseGraph(cut).graph?.steps.length).toBe(4)
    expect(parseGraph(cut).graph?.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"])
  })

  test("missing several closers is still recoverable", () => {
    expect(parseGraph(FULL.slice(0, -3)).graph?.steps.length).toBeGreaterThan(0)
  })

  test("a cut landing MID-STRING is refused — no word is invented to finish it", () => {
    const midString = '{"steps":[{"id":"s1","role":"build","description":"implement the thin'
    expect(closeTruncatedJson(midString)).toBeNull()
  })

  test("text that is not JSON at all still fails, exactly as before", () => {
    expect(parseGraph("I thought about it and decided to do it in one step.").graph).toBeNull()
    expect(closeTruncatedJson("no json here")).toBeNull()
  })

  test("already-balanced JSON is left alone — the repair only ever adds what is missing", () => {
    expect(closeTruncatedJson(FULL)).toBeNull()
  })

  test("more closers than openers is malformed, not truncated", () => {
    expect(closeTruncatedJson('{"steps":[]}}')).toBeNull()
  })
})
