import { test, expect } from "bun:test"
import { triagePrompt, parseTriage, looksUnderspecified, INTERVIEW_NUDGE } from "./interview"

test("triagePrompt: splits code-answerable vs human-only, one top question, embeds task+code", () => {
  const p = triagePrompt("add a cache", "class Store: ...")
  expect(p).toContain("CODE-ANSWERABLE")
  expect(p).toContain("HUMAN-ONLY")
  expect(p).toContain("TOP QUESTION")
  expect(p).toContain("DEFAULT IF NO ANSWER")
  expect(p).toContain("never asked of the human")
  expect(p).toContain("add a cache")
  expect(p).toContain("class Store:")
})

test("parseTriage: pulls the four sections", () => {
  const reply = [
    "CODE-ANSWERABLE:",
    "- Store uses attrs (store.py) — resolve by reading",
    "HUMAN-ONLY:",
    "- eviction policy is a product choice",
    "TOP QUESTION: Should the cache be per-user or global?",
    "DEFAULT IF NO ANSWER: global LRU, size 128",
  ].join("\n")
  const r = parseTriage(reply)
  expect(r.codeAnswerable).toContain("attrs")
  expect(r.humanOnly).toContain("eviction policy")
  expect(r.topQuestion).toBe("Should the cache be per-user or global?")
  expect(r.defaultAssumption).toContain("global LRU")
})

test("parseTriage: garbage → empty sections, never throws", () => {
  const r = parseTriage("just prose")
  expect(r.topQuestion).toBe("")
  expect(parseTriage(undefined as any).humanOnly).toBe("")
})

test("looksUnderspecified: thin implementation ask → true", () => {
  expect(looksUnderspecified("add caching to the store")).toBe(true)
  expect(looksUnderspecified("implement rate limiting")).toBe(true)
})

test("looksUnderspecified: well-anchored or long ask → false", () => {
  // two concrete anchors (path + symbol)
  expect(looksUnderspecified("add farewell() to src/farewell.py matching `greet()` in src/greet.py")).toBe(false)
  // long/detailed
  expect(looksUnderspecified("implement ".padEnd(260, "x"))).toBe(false)
})

test("looksUnderspecified: non-implementation / empty → false", () => {
  expect(looksUnderspecified("what does this function do?")).toBe(false)
  expect(looksUnderspecified("explain the architecture")).toBe(false)
  expect(looksUnderspecified("")).toBe(false)
  expect(looksUnderspecified(undefined as any)).toBe(false)
})

test("INTERVIEW_NUDGE mentions interview_me + reference_hunt", () => {
  expect(INTERVIEW_NUDGE).toContain("interview_me")
  expect(INTERVIEW_NUDGE).toContain("reference_hunt")
})
