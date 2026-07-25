import { describe, expect, test } from "bun:test"
import { decideExhausted, exhaustedAnswer, MIN_ATTEMPTS, MIN_ANSWER_CHARS } from "./exhausted"

const base = { queries: ["a", "b", "c", "d"], blocked: true, finalText: "", outcome: "completed" }

describe("decideExhausted", () => {
  // The live defect: fourteen near-identical searches, three blocks, then "Thinking" and nothing at all.
  test("budget spent and the model said nothing → the harness answers", () => {
    const v = decideExhausted(base)
    expect(v.answer).toBeTruthy()
    expect(v.answer).toContain("could not find")
    expect(v.reason).toContain("exhausted")
  })

  test("a turn that DID answer is never spoken over", () => {
    const v = decideExhausted({ ...base, finalText: "x".repeat(MIN_ANSWER_CHARS + 1) })
    expect(v.answer).toBeNull()
    expect(v.reason).toBe("turn answered")
  })

  test("nothing was blocked → an ordinary quiet turn is left alone", () => {
    expect(decideExhausted({ ...base, blocked: false }).answer).toBeNull()
  })

  test("too few attempts → a short turn is not exhaustion", () => {
    const few = Array.from({ length: MIN_ATTEMPTS - 1 }, (_, i) => `q${i}`)
    expect(decideExhausted({ ...base, queries: few }).answer).toBeNull()
  })

  test("a cancelled or errored turn keeps its own report — no talking over it", () => {
    expect(decideExhausted({ ...base, outcome: "cancelled" }).answer).toBeNull()
    expect(decideExhausted({ ...base, outcome: "error" }).answer).toBeNull()
  })

  test("whitespace-only text counts as no answer; blank queries do not count as attempts", () => {
    expect(decideExhausted({ ...base, finalText: "   \n  " }).answer).toBeTruthy()
    expect(decideExhausted({ ...base, queries: ["a", "  ", ""] }).answer).toBeNull()
  })

  test("malformed input never throws", () => {
    expect(() => decideExhausted({} as any)).not.toThrow()
    expect(decideExhausted({} as any).answer).toBeNull()
  })
})

describe("exhaustedAnswer", () => {
  test("names what was tried, caps the list, and offers a way forward", () => {
    const qs = Array.from({ length: 14 }, (_, i) => `query number ${i}`)
    const a = exhaustedAnswer(qs)
    expect(a).toContain("14 different ways")
    expect(a).toContain("query number 0")
    expect(a).toContain("and 8 more") // 6 shown of 14
    expect(a.split("\n").filter((l) => l.startsWith("- ")).length).toBe(7) // 6 + the "more" line
    expect(a).toMatch(/title|author|link/)
  })

  test("a short list is shown whole, with no dangling remainder line", () => {
    const a = exhaustedAnswer(["one", "two"])
    expect(a).toContain("- one")
    expect(a).not.toContain("more")
  })
})
