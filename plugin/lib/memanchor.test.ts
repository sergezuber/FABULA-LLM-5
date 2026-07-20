// Durable guards for the code anchor.
//
// The property most worth defending is the one an independent verifier proved could regress SILENTLY:
// degrading the symbol-span hash to a whole-file hash left the frozen acceptance suite fully green. That
// degradation would not break anything visibly — it would simply make every memory about an actively
// edited file report stale on every unrelated commit, and a staleness signal that fires constantly is one
// that gets switched off within a week. So it is guarded here, in the tracked tree, where a refactor
// meets it.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import { anchorFor, verifyAnchor, anchorStale, gitBlobSha, symbolSpan } from "./memanchor"

let root: string
const F = "src/mod.ts"
const ORIGINAL = `// header comment
export function untouched() {
  return "leave me alone"
}

export function target() {
  const a = 1
  return a + 1
}

export const tail = 42
`
function write(body: string) {
  writeFileSync(path.join(root, F), body)
}
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "anchor-"))
  mkdirSync(path.join(root, "src"), { recursive: true })
  write(ORIGINAL)
})
afterEach(() => { try { rmSync(root, { recursive: true, force: true }) } catch {} })

test("the blob sha is git's own — not a lookalike", () => {
  // If this drifts from git, every claim about "the exact bytes at write time" becomes unverifiable by
  // anyone outside this module.
  const real = execFileSync("git", ["hash-object", path.join(root, F)], { encoding: "utf8" }).trim()
  expect(gitBlobSha(ORIGINAL)).toBe(real)
})

test("an anchor is bound to the SYMBOL, not the whole file", () => {
  const a = anchorFor(F, "target", root)!
  expect(a.kind).toBe("symbol")
  expect(a.symbolSha).toBeTruthy()
  expect(a.symbolSha).not.toBe(a.sha) // the span hash is not the file hash
})

test("an edit ELSEWHERE in the file does not invalidate a symbol anchor", () => {
  // THE point of symbol scope. A file-blob anchor makes this go stale, which on an active file means
  // everything is always stale.
  const a = anchorFor(F, "target", root)!
  write(ORIGINAL.replace('"leave me alone"', '"edited, but not the anchored symbol"'))
  const v = verifyAnchor(a, root)
  expect(v.ok).toBe(true)
})

test("adding a line ABOVE the symbol does not invalidate it", () => {
  const a = anchorFor(F, "target", root)!
  write("// a new first line\n" + ORIGINAL)
  expect(verifyAnchor(a, root).ok).toBe(true)
})

test("an edit INSIDE the symbol DOES invalidate it", () => {
  const a = anchorFor(F, "target", root)!
  write(ORIGINAL.replace("return a + 1", "return a + 999"))
  const v = verifyAnchor(a, root)
  expect(v.ok).toBe(false)
  expect(v.changed).toBe("symbol")
  expect(anchorStale(a, root)).toBe(true)
})

test("deleting the symbol is reported as its own condition, not as a generic mismatch", () => {
  const a = anchorFor(F, "target", root)!
  write(ORIGINAL.replace(/export function target\(\)[\s\S]*?\n}\n/, ""))
  expect(verifyAnchor(a, root).changed).toBe("symbol-gone")
})

test("deleting the file is reported as missing", () => {
  const a = anchorFor(F, "target", root)!
  rmSync(path.join(root, F))
  expect(verifyAnchor(a, root).changed).toBe("missing")
})

test("with no symbol named, the anchor falls back to the file and says so", () => {
  const a = anchorFor(F, undefined, root)!
  expect(a.kind).toBe("file")
  expect(verifyAnchor(a, root).ok).toBe(true)
  write(ORIGINAL + "\n// any change at all\n")
  expect(verifyAnchor(a, root).ok).toBe(false)
})

test("an unlocatable symbol degrades to file scope rather than inventing a span", () => {
  const a = anchorFor(F, "no_such_symbol", root)!
  expect(a.kind).toBe("file")
  expect(a.symbolSha).toBeUndefined()
})

test("python indent blocks are bounded by indentation, not braces", () => {
  const py = "def keep():\n    return 1\n\ndef target():\n    x = 2\n    return x\n\ndef after():\n    return 3\n"
  writeFileSync(path.join(root, "m.py"), py)
  const a = anchorFor("m.py", "target", root)!
  expect(a.kind).toBe("symbol")
  writeFileSync(path.join(root, "m.py"), py.replace("return 3", "return 300"))
  expect(verifyAnchor(a, root).ok).toBe(true) // a sibling function moved; ours did not
  writeFileSync(path.join(root, "m.py"), py.replace("x = 2", "x = 22"))
  expect(verifyAnchor(a, root).ok).toBe(false)
})

test("the span is found by DECLARATION, not by a bare mention of the name", () => {
  const s = symbolSpan("// target is mentioned here\nexport function target() {\n  return 1\n}\n", "target")
  expect(s).not.toBeNull()
  expect(s!.start).toBe(1) // the declaration line, not the comment
})

test("verification never asks a model and never leaves the filesystem", () => {
  // Determinism is the whole argument: the same bytes give the same answer every time, which is what a
  // model-judged freshness check cannot promise.
  const a = anchorFor(F, "target", root)!
  const runs = Array.from({ length: 5 }, () => JSON.stringify(verifyAnchor(a, root)))
  expect(new Set(runs).size).toBe(1)
})

test("a missing or malformed anchor is refused, never treated as fresh", () => {
  for (const bad of [null, undefined, {}, { path: "" }, "nonsense"]) {
    expect(verifyAnchor(bad as any, root).ok).toBe(false)
  }
})
