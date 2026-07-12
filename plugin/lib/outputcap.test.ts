import { test, expect } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { capText, cursorMessage, capToolOutput } from "./outputcap"

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
