import { test, expect } from "bun:test"
import { brainstormPrompt, countVariations, looksLikeBrainstorm } from "./brainstorm"

test("brainstormPrompt: asks for 3-5 divergent options with belief/sketch/tradeoff", () => {
  const p = brainstormPrompt("design a rate limiter")
  expect(p).toContain("WILDLY DIFFERENT")
  expect(p).toContain("BELIEF:")
  expect(p).toContain("SKETCH:")
  expect(p).toContain("TRADEOFF:")
  expect(p).toContain("contrarian")
  expect(p).toContain("design a rate limiter")
})

test("brainstormPrompt: embeds code context when given", () => {
  expect(brainstormPrompt("x", "class Foo: ...")).toContain("class Foo:")
  expect(brainstormPrompt("x")).not.toContain("SURROUNDING CODE")
})

test("countVariations + looksLikeBrainstorm", () => {
  const reply = "### Token bucket\nBELIEF: bursts are fine\n### Fixed window\nBELIEF: simplicity wins\n### Sliding log\nBELIEF: accuracy matters"
  expect(countVariations(reply)).toBe(3)
  expect(looksLikeBrainstorm(reply)).toBe(true)
  expect(looksLikeBrainstorm("### one\nno belief here")).toBe(false) // <2 variations
  expect(looksLikeBrainstorm("just prose")).toBe(false)
  expect(countVariations(undefined as any)).toBe(0)
})
