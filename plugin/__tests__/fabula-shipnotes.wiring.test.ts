// Wiring test: the edit trail is AUTO-CAPTURED (fires itself on source edits) and implementation_note
// appends to the same per-session log — verified through implementation_note's own return count.
// pitch_packager hits git + aux (network), exercised elsewhere.
import { test, expect } from "bun:test"
import { FabulaShipnotes } from "../fabula-shipnotes"

async function plugin() { return (await FabulaShipnotes({} as any)) as any }

test("exposes implementation_note + pitch_packager tools and the hooks", async () => {
  const p = await plugin()
  expect(p.tool?.implementation_note).toBeDefined()
  expect(p.tool?.pitch_packager).toBeDefined()
  expect(typeof p["chat.message"]).toBe("function")
  expect(typeof p["tool.execute.after"]).toBe("function")
})

test("auto-captures source edits; implementation_note adds to the SAME trail", async () => {
  const p = await plugin()
  const sid = "sn-1"
  await p["chat.message"]({ sessionID: sid })
  // two source edits auto-captured (same file twice → de-duped to one)
  await p["tool.execute.after"]({ tool: "create_file", sessionID: sid, args: { file_path: "calc.py" } }, { output: "ok", metadata: {} })
  await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "util.py" } }, { output: "ok", metadata: {} })
  // a decision note
  const r = await p.tool.implementation_note.execute({ note: "kept old regex to not break 5.15" }, { sessionID: sid })
  expect(r).toContain("1 decision(s)")
  expect(r).toContain("3 entries") // 2 edits + 1 note
})

test("non-source edits are NOT auto-captured", async () => {
  const p = await plugin()
  const sid = "sn-docs"
  await p["chat.message"]({ sessionID: sid })
  await p["tool.execute.after"]({ tool: "create_file", sessionID: sid, args: { file_path: "README.md" } }, { output: "ok", metadata: {} })
  const r = await p.tool.implementation_note.execute({ note: "x" }, { sessionID: sid })
  expect(r).toContain("1 entries") // only the note; README not captured
})

test("chat.message resets the trail per task", async () => {
  const p = await plugin()
  const sid = "sn-reset"
  await p["chat.message"]({ sessionID: sid })
  await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "a.py" } }, { output: "ok", metadata: {} })
  await p["chat.message"]({ sessionID: sid }) // new task → wipe
  const r = await p.tool.implementation_note.execute({ note: "fresh" }, { sessionID: sid })
  expect(r).toContain("1 entries")
})
