import { test, expect } from "bun:test"
import { buildDecomposePrompt, parseDecompose } from "./decompose"

test("parseDecompose: splits claim @@ attribution, drops preamble/empties, caps at 40", () => {
  const aux = [
    "Here are the claims:", // preamble → dropped
    "The cup was warm on its own. @@ глава_01",
    "Correlation reaches 0.9999. @@ глава_11",
    "- 9 analysts over 47 years @@ NONE", // bullet + NONE attribution
    "hi", // too short → dropped
  ].join("\n")
  const out = parseDecompose(aux)
  expect(out.length).toBe(3)
  expect(out[0]).toEqual({ text: "The cup was warm on its own.", attribution: "глава_01" })
  expect(out[2].attribution).toBeUndefined() // NONE → no attribution
  expect(out[2].text).toBe("9 analysts over 47 years") // leading bullet stripped
})

test("parseDecompose: a line with no @@ keeps the whole text, no attribution", () => {
  const out = parseDecompose("The building is described as alive.")
  expect(out.length).toBe(1)
  expect(out[0].text).toBe("The building is described as alive.")
  expect(out[0].attribution).toBeUndefined()
})

test("parseDecompose: empty/garbage input → no claims", () => {
  expect(parseDecompose("")).toEqual([])
  expect(parseDecompose("...\n\n").length).toBe(0)
})

test("buildDecomposePrompt: embeds the deliverable + the claim-line format + a cap", () => {
  const p = buildDecomposePrompt("A written analysis with «a quote» and 0.9999.")
  expect(p).toContain("@@")
  expect(p).toContain("Max 40")
  expect(p).toContain("a quote")
})
