import { test, expect } from "bun:test"
import {
  refHuntTerms, refDigestPrompt, blindspotPrompt, parseBlindspot,
  isSourceFile, newUnknownsState, shouldSteerReferenceFirst, REFERENCE_FIRST_STEER,
} from "./unknowns"

test("refHuntTerms: pulls identifiers, dotted names, quoted strings; drops filler", () => {
  const terms = refHuntTerms("implement `_find_versions` like qutebrowser.misc.elf, should handle ParseError")
  expect(terms).toContain("_find_versions")
  expect(terms).toContain("qutebrowser.misc.elf")
  expect(terms).toContain("ParseError")
  expect(terms).not.toContain("implement") // stop word
  expect(terms).not.toContain("should")
})

test("refHuntTerms: empty / non-string → []", () => {
  expect(refHuntTerms("")).toEqual([])
  expect(refHuntTerms(undefined as any)).toEqual([])
})

test("refDigestPrompt: directs a semantics summary of reference code, not a rewrite", () => {
  const p = refDigestPrompt("reimplement the parser", "def parse(): ...")
  expect(p).toContain("SPECIFICATION")
  expect(p).toContain("SEMANTICS SUMMARY")
  expect(p).toContain("Do NOT rewrite")
  expect(p).toContain("reimplement the parser")
  expect(p).toContain("def parse():")
})

test("blindspotPrompt: asks for grounded unknowns + a refined task, embeds task & code", () => {
  const p = blindspotPrompt("add caching", "class Store: ...")
  expect(p).toContain("BLINDSPOT PASS")
  expect(p).toContain("unknown-unknowns")
  expect(p).toContain("UNKNOWNS:")
  expect(p).toContain("REFINED TASK:")
  expect(p).toContain("add caching")
  expect(p).toContain("class Store:")
})

test("parseBlindspot: splits unknowns and refined task", () => {
  const reply = "UNKNOWNS:\n- uses attrs not dataclass (models.py)\n- errors wrap ParseError\nREFINED TASK:\nAdd an LRU cache to Store.get keyed by id, attrs-style."
  const { unknowns, refined } = parseBlindspot(reply)
  expect(unknowns).toContain("uses attrs not dataclass")
  expect(refined).toBe("Add an LRU cache to Store.get keyed by id, attrs-style.")
})

test("parseBlindspot: garbage/no markers → whole text as unknowns, empty refined", () => {
  const { unknowns, refined } = parseBlindspot("just some prose")
  expect(unknowns).toBe("just some prose")
  expect(refined).toBe("")
  expect(parseBlindspot(undefined as any).unknowns).toBe("")
})

test("isSourceFile: source vs test vs other", () => {
  expect(isSourceFile("qutebrowser/misc/elf.py")).toBe(true)
  expect(isSourceFile("src/store.ts")).toBe(true)
  expect(isSourceFile("tests/unit/test_elf.py")).toBe(false) // test dir
  expect(isSourceFile("src/store.test.ts")).toBe(false)      // test file
  expect(isSourceFile("README.md")).toBe(false)              // not code
  expect(isSourceFile("")).toBe(false)
})

test("shouldSteerReferenceFirst: fires once on a source edit with no prior reference pass", () => {
  const st = newUnknownsState()
  expect(shouldSteerReferenceFirst(st, "src/store.ts")).toBe(true)   // 1st source edit, no pass → steer
  expect(shouldSteerReferenceFirst(st, "README.md")).toBe(false)     // not source
  st.didReferencePass = true
  expect(shouldSteerReferenceFirst(st, "src/store.ts")).toBe(false)  // reference pass done → no steer
})

test("shouldSteerReferenceFirst: does not nag after it already steered once", () => {
  const st = newUnknownsState()
  st.steered = true
  expect(shouldSteerReferenceFirst(st, "src/store.ts")).toBe(false)
  expect(REFERENCE_FIRST_STEER).toContain("reference_hunt")
  expect(REFERENCE_FIRST_STEER).toContain("surface_unknowns")
})
