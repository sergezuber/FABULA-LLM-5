import { describe, expect, test } from "bun:test"
import { planFold, estimateTokens, foldContinuation, CHARS_PER_TOKEN } from "../../src/session/compaction-fold"

/** A message of roughly n tokens, built from real serialised shape rather than a bare string. */
const msg = (n: number, role = "user") => ({ role, content: "x".repeat(Math.round(n * CHARS_PER_TOKEN)) })

describe("planFold", () => {
  // The measured case: six chapters of a book reached 188 870 units against a model holding 135 168, and
  // the serving process died allocating cache for the request.
  test("a head larger than the budget is folded, not sent whole", () => {
    const head = Array.from({ length: 6 }, () => msg(40_000))
    const p = planFold(head, 100_000)
    expect(p.slices.length).toBeGreaterThan(1)
    for (const s of p.slices) {
      const t = s.reduce((a, m) => a + estimateTokens(m), 0)
      expect(t).toBeLessThanOrEqual(100_000)
    }
    expect(p.reason).toContain("folding into")
  })

  test("a head that fits is ONE call — today's behaviour, unchanged", () => {
    const p = planFold([msg(1000), msg(1000)], 100_000)
    expect(p.slices.length).toBe(1)
    expect(p.reason).toContain("fits in one call")
  })

  test("every message survives, in order, exactly once", () => {
    const head = Array.from({ length: 17 }, (_, i) => ({ role: "user", content: `m${i}`, n: i }))
    const flat = planFold(head, 40).slices.flat()
    expect(flat.length).toBe(head.length)
    expect(flat.map((m: any) => m.n)).toEqual(head.map((m) => m.n))
  })

  test("a single message bigger than the budget gets its own pass and is COUNTED, not hidden", () => {
    const p = planFold([msg(10), msg(500_000), msg(10)], 1000)
    expect(p.slices.some((s) => s.length === 1 && estimateTokens(s[0]) > 1000)).toBe(true)
    expect(p.reason).toContain("exceed the budget alone")
  })

  test("no budget known → one call, exactly as before; a guess here could crash the server", () => {
    const p = planFold([msg(999_999)], 0)
    expect(p.slices.length).toBe(1)
    expect(p.reason).toContain("as before")
  })

  test("an empty head asks for nothing", () => {
    expect(planFold([], 1000).slices).toEqual([])
    expect(planFold(undefined as any, 1000).slices).toEqual([])
  })

  test("the size estimate counts the whole serialised shape, not just visible prose", () => {
    const bare = { content: "abc" }
    const withTool = { role: "assistant", content: "abc", tool_calls: [{ function: { name: "read", arguments: "{}" } }] }
    expect(estimateTokens(withTool)).toBeGreaterThan(estimateTokens(bare))
  })

  test("the reading rule errs SMALL — an under-estimate costs a call, an over-estimate costs the server", () => {
    // A lower chars-per-token means more tokens counted per message, so slices come out smaller.
    const head = Array.from({ length: 8 }, () => msg(1000))
    expect(planFold(head, 2000, 1).slices.length).toBeGreaterThanOrEqual(planFold(head, 2000, 10).slices.length)
  })
})

describe("foldContinuation", () => {
  test("each pass is told where it stands and what came before", () => {
    const t = foldContinuation("earlier things happened", 1, 3)
    expect(t).toContain("part 2 of 3")
    expect(t).toContain("earlier things happened")
  })

  test("the arrangement is never mentioned to the reader", () => {
    expect(foldContinuation("x", 0, 2)).toContain("Do not mention this arrangement")
  })

  test("an empty previous summary says so rather than leaving a hole", () => {
    expect(foldContinuation("", 0, 2)).toContain("(nothing yet)")
  })
})
