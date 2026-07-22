import { test, expect } from "bun:test"
import { typeClaim, bindLoadBearing, reconcileDecompositions } from "./claims"
import type { Claim, Contract } from "./types"

test("typeClaim: surface form → hard types", () => {
  expect(typeClaim('The text says «Кружка тёплая сама по себе.»')).toBe("citation")
  expect(typeClaim("All 45 tests pass and it compiles clean")).toBe("execution")
  expect(typeClaim("прошли тесты, без регрессий")).toBe("execution")
  expect(typeClaim("Read all 29 chapter files")).toBe("process")
  expect(typeClaim("Прочитаны все 29 файлов глав")).toBe("process")
  expect(typeClaim("9 analysts over 47 years reached the same result")).toBe("measurement")
  expect(typeClaim("correlation climbs 0.94 → 0.9999")).toBe("measurement")
  expect(typeClaim("total is $4200 for the trip")).toBe("measurement")
})

test("typeClaim: soft types", () => {
  expect(typeClaim("the tactile density recalls Borges")).toBe("analogy")
  expect(typeClaim("плотность как у Чехова")).toBe("analogy")
  expect(typeClaim("this indicates a mechanism, not an organism")).toBe("inference")
  expect(typeClaim("это указывает на механизм, а не организм")).toBe("inference")
  expect(typeClaim("the novel is masterful and profound")).toBe("judgment")
  expect(typeClaim("роман великолепен")).toBe("judgment")
})

test("typeClaim STICKY (BUG-3 fix): a quote framed as an inference stays citation — can't dodge the check", () => {
  // fabrication dressed as a soft inference, but it carries quote marks → hard citation, checkable
  expect(typeClaim('This indicates «a fabricated verbatim line» about the theme')).toBe("citation")
  // a number dressed with an inference verb stays measurement
  expect(typeClaim("This suggests 0.9999 correlation")).toBe("measurement")
})

test("typeClaim: a bare identifier number is NOT a measurement (routes to soft, avoids false hard-confirm)", () => {
  expect(typeClaim("Office 519 on the fifth floor")).not.toBe("measurement")
})

test("bindLoadBearing: with conclusions, lexical support decides", () => {
  const c: Contract = { verifiable: true, conclusions: ["the correlation reaches near one"], criteria: [], terminals: ["verified"] }
  const claims: Claim[] = [
    { id: "1", text: "correlation reaches 0.9999", type: "measurement", loadBearing: false },
    { id: "2", text: "the cup was warm", type: "citation", loadBearing: false },
  ]
  const out = bindLoadBearing(claims, c)
  expect(out.find((x) => x.id === "1")!.loadBearing).toBe(true) // shares "correlation"
  expect(out.find((x) => x.id === "2")!.loadBearing).toBe(false) // no overlap with any conclusion
})

test("bindLoadBearing: no conclusions → hard types are load-bearing, judgment is not", () => {
  const c: Contract = { verifiable: true, conclusions: [], criteria: [], terminals: ["verified"] }
  const out = bindLoadBearing(
    [
      { id: "1", text: "9 analysts", type: "measurement", loadBearing: false },
      { id: "2", text: "it is beautiful", type: "judgment", loadBearing: false },
    ],
    c,
  )
  expect(out.find((x) => x.id === "1")!.loadBearing).toBe(true)
  expect(out.find((x) => x.id === "2")!.loadBearing).toBe(false)
})

test("reconcileDecompositions (BUG-7 fix): a claim present in only ONE pass survives (union, not intersection)", () => {
  const a: Claim[] = [
    { id: "a1", text: "The room is 519", type: "citation", loadBearing: false },
    { id: "a2", text: "correlation is 0.9999", type: "measurement", loadBearing: false },
  ]
  const b: Claim[] = [
    { id: "b1", text: "the room is 519", type: "citation", loadBearing: false }, // dup of a1 (normalized)
    { id: "b2", text: "nine analysts worked there", type: "measurement", loadBearing: false }, // only in b
  ]
  const merged = reconcileDecompositions(a, b)
  const texts = merged.map((x) => x.text.toLowerCase())
  expect(merged.length).toBe(3) // a1≈b1 deduped; a2 and b2 both kept
  expect(texts.some((t) => t.includes("correlation"))).toBe(true) // only-in-a survived
  expect(texts.some((t) => t.includes("nine analysts"))).toBe(true) // only-in-b survived
})
