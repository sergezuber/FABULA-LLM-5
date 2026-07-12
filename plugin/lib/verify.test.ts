import { test, expect } from "bun:test"
import { fileState } from "./filestate"
import { findMatch, checkEscapeDrift } from "./fuzzymatch"
import { detectVerifyCommand, verifyReport } from "./verifycmd"

// ───────────────────────── 3.1 file-state ─────────────────────────
test("checkStale: never-read file is flagged", () => {
  const v = fileState.checkStale("s1", "/a/new.ts", 1000)
  expect(v.neverRead).toBe(true)
})
test("checkStale: read then edit (same mtime) is clean", () => {
  fileState.recordRead("s2", "/a/f.ts", 5000, false)
  const v = fileState.checkStale("s2", "/a/f.ts", 5000)
  expect(v.neverRead).toBe(false)
  expect(v.stale).toBe(false)
  expect(v.note).toBe("")
})
test("checkStale: external modification since read is detected", () => {
  fileState.recordRead("s3", "/a/f.ts", 5000, false)
  const v = fileState.checkStale("s3", "/a/f.ts", 9000) // mtime advanced
  expect(v.stale).toBe(true)
  expect(v.note).toContain("changed on disk")
})
test("checkStale: partial read is noted", () => {
  fileState.recordRead("s4", "/a/big.ts", 5000, true) // partial
  const v = fileState.checkStale("s4", "/a/big.ts", 5000)
  expect(v.partialOnly).toBe(true)
  expect(v.note).toContain("only read PART")
})
test("noteWrite refreshes state (post-write not stale)", () => {
  fileState.recordRead("s5", "/a/f.ts", 5000, false)
  fileState.noteWrite("s5", "/a/f.ts", 8000)
  expect(fileState.checkStale("s5", "/a/f.ts", 8000).stale).toBe(false)
})
test("sessions isolated + dropSession", () => {
  fileState.recordRead("sa", "/x", 1, false)
  expect(fileState.checkStale("sb", "/x", 1).neverRead).toBe(true)
  fileState.dropSession("sa")
  expect(fileState.checkStale("sa", "/x", 1).neverRead).toBe(true)
})

// ───────────────────────── 3.4 fuzzy match ─────────────────────────
const FILE = `function add(a, b) {
  return a + b
}

function sub(a, b) {
  return a - b
}
`
test("exact unique match", () => {
  const m = findMatch(FILE, "return a + b")
  expect(m.ok).toBe(true); expect(m.strategy).toBe("exact"); expect(m.matched).toBe("return a + b")
})
test("exact ambiguous match is refused", () => {
  const m = findMatch("x\nx\n", "x")
  expect(m.ok).toBe(false); expect(m.count).toBe(2)
})
test("trailing-whitespace drift still matches uniquely", () => {
  const m = findMatch(FILE, "  return a - b   ") // extra trailing spaces
  expect(m.ok).toBe(true)
  expect(m.matched).toBe("  return a - b") // original (exact) span returned
})
test("re-indented old_str matches via strip_indent", () => {
  const m = findMatch(FILE, "      return a - b") // WRONG indent (6 spaces) → not an exact substring
  expect(m.ok).toBe(true)
  expect(["strip_indent", "collapse_ws"]).toContain(m.strategy)
  expect(m.matched).toBe("  return a - b") // original (correctly-indented) span returned
})
test("smart-quotes normalize to ascii", () => {
  const f = `const s = "hello"\n`
  const m = findMatch(f, "const s = “hello”") // curly quotes in needle
  expect(m.ok).toBe(true)
  expect(m.matched).toBe('const s = "hello"')
})
test("block-anchor matches a multi-line span by its ends", () => {
  const m = findMatch(FILE, "function sub(a, b) {\n  return a MINUS b\n}")
  expect(m.ok).toBe(true)
  expect(m.strategy).toBe("block_anchor")
  expect(m.matched).toBe("function sub(a, b) {\n  return a - b\n}")
})
test("no match → not ok", () => {
  expect(findMatch(FILE, "totally absent line").ok).toBe(false)
})
test("escape-drift detected (literal \\n, no real newlines)", () => {
  const d = checkEscapeDrift("line1\\nline2\\nline3")
  expect(d.drift).toBe(true)
  expect(d.fixed).toBe("line1\nline2\nline3")
})
test("escape-drift NOT flagged for normal multiline / single literal", () => {
  expect(checkEscapeDrift("real\nnewlines\nhere").drift).toBe(false)
  expect(checkEscapeDrift('printf("done\\n")').drift).toBe(false) // single literal in a string is fine
})

// ───────────────────────── 3.3 verify-command detection ─────────────────────────
test("detectVerifyCommand: package test script", () => {
  expect(detectVerifyCommand(["package.json"], { test: "jest" })?.cmd).toBe("npm test")
  expect(detectVerifyCommand(["package.json", "bun.lockb"], { test: "jest" })?.cmd).toBe("bun test")
  expect(detectVerifyCommand(["package.json", "bunfig.toml"], { test: "bun test ." })?.cmd).toBe("bun test") // bun project without a lockfile (zero deps)
  expect(detectVerifyCommand(["package.json", "yarn.lock"], { test: "jest" })?.cmd).toBe("yarn test")
})
test("detectVerifyCommand: ignores npm default 'no test specified'", () => {
  const d = detectVerifyCommand(["package.json"], { test: 'echo "Error: no test specified" && exit 1' })
  expect(d?.cmd).not.toBe("npm test") // falls through (no real test) → null here
  expect(d).toBe(null)
})
test("detectVerifyCommand: language-native", () => {
  expect(detectVerifyCommand(["pyproject.toml"])?.cmd).toBe("python -m pytest -q")
  expect(detectVerifyCommand(["go.mod"])?.label).toBe("go build+test")
  expect(detectVerifyCommand(["Cargo.toml"])?.cmd).toBe("cargo test")
  expect(detectVerifyCommand(["Makefile"])?.cmd).toBe("make test")
  expect(detectVerifyCommand(["README.md"])).toBe(null)
})
test("verifyReport: pass vs fail wording", () => {
  expect(verifyReport(true, "pytest", "pytest", "12 passed")).toContain("VERIFIED DONE")
  const fail = verifyReport(false, "pytest", "pytest", "1 failed")
  expect(fail).toContain("NOT DONE")
  expect(fail).toContain("NOT complete")
})
