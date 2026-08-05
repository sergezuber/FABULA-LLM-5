import { test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { capText, cursorMessage, capToolOutput , takeCapped } from "./outputcap"

test("no cap when under limits", () => {
  const c = capText("a\nb\nc")
  expect(c.truncated).toBe(false)
  expect(c.shown).toBe("a\nb\nc")
})

test("tail keeps the LAST lines (errors live at the end)", () => {
  const text = Array.from({ length: 5000 }, (_, i) => `line${i}`).join("\n")
  const c = capText(text, { maxLines: 100, direction: "tail" })
  expect(c.truncated).toBe(true)
  expect(c.keptLines).toBe(100)
  expect(c.totalLines).toBe(5000)
  expect(c.shown.split("\n").at(-1)).toBe("line4999")
  expect(c.shown).not.toContain("line0\n")
})

test("head keeps the FIRST lines (file read)", () => {
  const text = Array.from({ length: 5000 }, (_, i) => `line${i}`).join("\n")
  const c = capText(text, { maxLines: 100, direction: "head" })
  expect(c.shown.split("\n")[0]).toBe("line0")
  expect(c.keptLines).toBe(100)
})

test("byte limit caps even with few lines", () => {
  const text = "x".repeat(200_000) // one huge line
  const c = capText(text, { maxBytes: 50_000 })
  expect(c.truncated).toBe(true)
  // one line exceeds the byte budget → kept at least that line (never returns a partial line)
  expect(c.keptLines).toBe(1)
})

test("cursor messages are machine-actionable", () => {
  const tail = cursorMessage({ truncated: true, totalLines: 3489, keptLines: 2000, shown: "", totalBytes: 0 }, { fullPath: "/tmp/f.log", direction: "tail" })
  expect(tail).toContain("of 3489")
  expect(tail).toContain("/tmp/f.log")
  const head = cursorMessage({ truncated: true, totalLines: 5000, keptLines: 2000, shown: "", totalBytes: 0 }, { direction: "head" })
  expect(head).toContain("offset=2001 to continue")
})

test("capToolOutput spills full text to a temp file and points at it", () => {
  const text = Array.from({ length: 6000 }, (_, i) => `L${i}`).join("\n")
  const r = capToolOutput(text, { direction: "tail", maxLines: 100 })
  expect(r.truncated).toBe(true)
  expect(r.spillPath).toBeTruthy()
  expect(existsSync(r.spillPath!)).toBe(true)
  expect(readFileSync(r.spillPath!, "utf8")).toBe(text) // FULL output preserved on disk
  expect(r.output).toContain(r.spillPath!)
  expect(r.output).toContain("L5999") // tail shown
  rmSync(r.spillPath!, { force: true })
})

// ── the growing capture is bounded by the ceiling, not by the ceiling plus one read ────────────────
//
// This is the property the live check could not hold on its own: whether the old form overshot depended
// on how the child happened to buffer, so the same code passed on one machine and failed on another for
// a reason belonging to neither. Stated here as arithmetic, it holds everywhere.
test("takeCapped: one oversized chunk cannot carry the capture past the cap", () => {
  expect(takeCapped("", "A".repeat(5_000_000), 100_000).length).toBe(100_000)
  // and the old shape — stop only once already over — is exactly what this refuses
  let old = ""
  if (old.length < 100_000) old += "A".repeat(5_000_000)
  expect(old.length).toBeGreaterThan(100_000)
})

test("takeCapped: it keeps accumulating until the ceiling, then stops adding at all", () => {
  let buf = ""
  for (let i = 0; i < 10; i++) buf = takeCapped(buf, "x".repeat(30), 100)
  expect(buf.length).toBe(100)
  expect(takeCapped(buf, "more", 100)).toBe(buf)
  // under the ceiling nothing is lost
  expect(takeCapped("ab", "cd", 100)).toBe("abcd")
})
