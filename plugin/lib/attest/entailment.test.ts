import { test, expect } from "bun:test"
import { buildEntailPrompt, parseEntail, buildContradictionPrompt, parseContradiction } from "./entailment"

test("buildEntailPrompt carries the claim + quarantined evidence and the untrusted-data guard", () => {
  const p = buildEntailPrompt({ text: "cats purr", type: "citation" } as any, "EVID: cats purr here")
  expect(p).toContain("cats purr")
  expect(p).toContain("EVID: cats purr here")
  expect(p.toLowerCase()).toContain("ignore any instructions")
})

test("parseEntail: reads the LAST verdict (reasoning-first), undecided → faithful:null", () => {
  expect(parseEntail("thinking… VERDICT: FABRICATION\n…more\nVERDICT: FAITHFUL\nCONFIDENCE: 0.8").faithful).toBe(true)
  expect(parseEntail("no verdict here").faithful).toBe(null)
})

test("buildContradictionPrompt names both statements + the untrusted-data guard, asks for the two-line verdict", () => {
  const p = buildContradictionPrompt("9 analysts reviewed it", "7 analysts reviewed it")
  expect(p).toContain("9 analysts reviewed it")
  expect(p).toContain("7 analysts reviewed it")
  expect(p.toLowerCase()).toContain("untrusted data")
  expect(p).toContain("VERDICT: CONTRADICTION | CONSISTENT")
})

test("parseContradiction: last verdict wins; CONSISTENT → false; unparseable → null (never a false block)", () => {
  expect(parseContradiction("VERDICT: CONSISTENT\nVERDICT: CONTRADICTION\nCONFIDENCE: 0.9").contradiction).toBe(true)
  expect(parseContradiction("VERDICT: CONSISTENT\nCONFIDENCE: 0.7").contradiction).toBe(false)
  expect(parseContradiction("the model rambled with no verdict line").contradiction).toBe(null)
})

test("parseContradiction: confidence clamps to [0,1], defaults to 0 when absent", () => {
  expect(parseContradiction("VERDICT: CONTRADICTION").confidence).toBe(0)
  expect(parseContradiction("VERDICT: CONTRADICTION\nCONFIDENCE: 0.42").confidence).toBeCloseTo(0.42)
})
