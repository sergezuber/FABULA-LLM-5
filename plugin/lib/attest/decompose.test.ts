import { test, expect } from "bun:test"
import { buildDecomposePrompt, parseDecompose, parseDecomposeFull } from "./decompose"

test("parseDecomposeFull: object form carries the task's conclusions AND the deliverable's claims", () => {
  const aux = JSON.stringify({
    conclusions: ["cover every chapter", "give a final total", "  "],
    claims: [
      { text: "The cup was warm on its own.", src: "ch01" },
      { text: "correlation reached 0.9999", src: null },
      { text: "The cup was warm on its own.", src: "ch01" }, // dup
    ],
  })
  const out = parseDecomposeFull(aux)
  expect(out.conclusions).toEqual(["cover every chapter", "give a final total"]) // empty dropped
  expect(out.claims.length).toBe(2) // deduped
  expect(out.claims[0].attribution).toBe("ch01")
})

test("parseDecomposeFull: bare array (no conclusions) → conclusions [] + claims", () => {
  const out = parseDecomposeFull(JSON.stringify([{ text: "9 analysts over 47 years", src: "ch05" }]))
  expect(out.conclusions).toEqual([])
  expect(out.claims.length).toBe(1)
})

test("buildDecomposePrompt: with a task, asks for {conclusions, claims}; without, a plain claims array", () => {
  const withTask = buildDecomposePrompt("the deliverable text here", "analyze the book")
  expect(withTask).toContain('"conclusions"')
  expect(withTask).toContain("TASK:")
  const noTask = buildDecomposePrompt("the deliverable text here")
  expect(noTask).toContain("JSON array")
  expect(noTask).not.toContain('"conclusions"')
})

test("parseDecompose: JSON array (the primary path)", () => {
  const aux = JSON.stringify([
    { text: "The cup was warm on its own.", src: "ch01" },
    { text: "9 analysts over 47 years", src: null },
    { text: "correlation reached 0.9999", src: "ch11" },
  ])
  const out = parseDecompose(aux)
  expect(out.length).toBe(3)
  expect(out[0]).toEqual({ text: "The cup was warm on its own.", attribution: "ch01" })
  expect(out[1].attribution).toBeUndefined() // null src → no attribution
  expect(out[2].attribution).toBe("ch11")
})

test("parseDecompose: JSON buried in a reasoning-model trace → lifts the LAST array, ignores the ramble (live 2026-07-22)", () => {
  const polluted =
    "Here's a thinking process:\n**Analyze User Input:** extract claims...\n" +
    'Draft: [{"text":"wrong early draft","src":null}]\n' +
    "Wait, let me refine. Line 1: The text says...\nSelf-Correction: keep exact wording.\n" +
    'Final answer:\n[{"text":"The cup was warm on its own.","src":"ch01"},{"text":"correlation reached 0.9999","src":"ch01"},{"text":"the corridor is 14 steps","src":"ch01"}]'
  const out = parseDecompose(polluted)
  const texts = out.map((c) => c.text)
  expect(out.length).toBe(3) // the FINAL array, not the early draft, not the reasoning lines
  expect(texts).toContain("The cup was warm on its own.")
  expect(texts.some((t) => /0\.9999/.test(t))).toBe(true)
  expect(texts.some((t) => /wrong early draft|thinking process|Self-Correction/i.test(t))).toBe(false)
})

test("parseDecompose: dedupes repeated claims in the JSON", () => {
  const aux = JSON.stringify([
    { text: "The cup was warm on its own." },
    { text: "The cup was warm on its own." },
    { text: "correlation reached 0.9999" },
  ])
  expect(parseDecompose(aux).length).toBe(2)
})

test("parseDecompose: line fallback (no JSON) — strips reasoning + dedupes", () => {
  const lines = [
    "Here's a thinking process:",
    "**Task:** extract claims",
    'The text says «The cup was warm on its own.» @@ ch01',
    "correlation reached 0.9999 @@ ch01",
    'Claim 2: The text says «The cup was warm on its own.» @@ ch01', // dup
    "Check against constraints:",
  ].join("\n")
  const out = parseDecompose(lines)
  expect(out.filter((c) => /cup was warm/i.test(c.text)).length).toBe(1)
  expect(out.some((c) => /0\.9999/.test(c.text))).toBe(true)
  expect(out.some((c) => /thinking process|Task|Check against/i.test(c.text))).toBe(false)
})

test("parseDecompose: empty / pure-meta reasoning → no claims", () => {
  expect(parseDecompose("")).toEqual([])
  // lines that are all reasoning scaffolding (META) or too short carry no claim
  expect(parseDecompose("Here's my plan:\n**Task:** do it\nLet's go.\nokay")).toEqual([])
})

test("buildDecomposePrompt: asks for a JSON array + embeds the deliverable", () => {
  const p = buildDecomposePrompt("A written analysis with «a quote» and 0.9999.")
  expect(p).toContain("JSON array")
  expect(p).toContain('"text"')
  expect(p).toContain("a quote")
})
