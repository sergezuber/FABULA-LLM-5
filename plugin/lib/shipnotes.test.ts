import { test, expect } from "bun:test"
import { newNotesLog, describeEdit, addNote, renderNotes, pitchPrompt } from "./shipnotes"

test("describeEdit: created vs edited, from path variants", () => {
  expect(describeEdit("create_file", { file_path: "a.py" })).toBe("created a.py")
  expect(describeEdit("write", { path: "b.ts" })).toBe("created b.ts")
  expect(describeEdit("str_replace", { path: "c.go" })).toBe("edited c.go")
  expect(describeEdit("str_replace", {})).toBeNull()
})

test("addNote: appends, de-dupes consecutive identical edits, skips empty", () => {
  const log = newNotesLog()
  addNote(log, "edit", "edited a.py")
  addNote(log, "edit", "edited a.py") // consecutive dup → skipped
  addNote(log, "edit", "edited b.py")
  addNote(log, "note", "chose LRU over LFU")
  addNote(log, "note", "  ") // empty → skipped
  expect(log.notes.length).toBe(3)
  expect(log.notes[2]).toEqual({ kind: "note", text: "chose LRU over LFU" })
})

test("renderNotes: decisions vs edits, empty case", () => {
  const log = newNotesLog()
  expect(renderNotes(log)).toContain("no notes logged")
  addNote(log, "edit", "edited a.py")
  addNote(log, "note", "kept the old regex to not break 5.15")
  const r = renderNotes(log)
  expect(r).toContain("· edited a.py")
  expect(r).toContain("• DECISION: kept the old regex")
})

test("pitchPrompt: demo-first structure, embeds diff + notes", () => {
  const p = pitchPrompt("add subtract", "diff body", "· edited calc.py")
  expect(p).toContain("DEMO-FIRST")
  expect(p).toContain("## What it does")
  expect(p).toContain("## Why")
  expect(p).toContain("## Notable decisions")
  expect(p).toContain("## Risks")
  expect(p).toContain("Lead with the demo")
  expect(p).toContain("diff body")
  expect(p).toContain("edited calc.py")
})
