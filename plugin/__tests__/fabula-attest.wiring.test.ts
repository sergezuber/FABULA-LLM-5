// Wiring test: drives the REAL fabula-attest hooks with the engine's input/output contract, hermetically
// (under `bun test` auxChain has no endpoint, so the armed path degrades without a live model call). Proves
// the load-failure-safe contract AND the central MUTE invariant: silent on chat, engages only on an armed
// deliverable turn — and never throws.

import { test, expect, beforeAll } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// enable the default-off plugin for this test (same mechanism as the witness/relay wiring tests)
beforeAll(() => {
  const stateFile = join(tmpdir(), `attest-state-${process.pid}.json`)
  writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["attest"] }))
  process.env.FABULA_PLUGIN_STATE = stateFile
})

import { FabulaAttest } from "../fabula-attest"

async function hooks() {
  return (await FabulaAttest({} as any)) as any
}
function writeResult(text: string) {
  return { output: text, metadata: {} as any }
}

test("loads and exposes the hooks when enabled", async () => {
  const h = await hooks()
  expect(typeof h["chat.message"]).toBe("function")
  expect(typeof h["tool.execute.after"]).toBe("function")
})

test("kill-switch: FABULA_ATTEST=0 → inert ({}), no hooks", async () => {
  process.env.FABULA_ATTEST = "0"
  const h = await hooks()
  expect(h["tool.execute.after"]).toBeUndefined()
  delete process.env.FABULA_ATTEST
})

test("MUTE on a chat/opinion turn: a written file is NOT gated (fixes the chat-breakage + IAL killers)", async () => {
  const h = await hooks()
  const sid = "chat-1"
  await h["chat.message"]({ sessionID: sid, message: { text: "what do you think of this novel?" } })
  const out = writeResult("A long enough written answer ".repeat(4))
  await h["tool.execute.after"]({ sessionID: sid, tool: "create_file", args: { path: "a.md", content: out.output } }, out)
  expect(out.output).toBe("A long enough written answer ".repeat(4)) // unchanged — the gate stayed silent
  expect(out.metadata.attest).toBeUndefined()
})

test("armed deliverable turn: reads are tracked, the gate runs and degrades gracefully with no aux (never throws)", async () => {
  const h = await hooks()
  const sid = "task-1"
  await h["chat.message"]({ sessionID: sid, message: { text: "analyze the book and save a literary analysis" } })
  // a source read is tracked without throwing
  const rd = writeResult("Кружка тёплая сама по себе. Линолеум с трещиной у стены.")
  await h["tool.execute.after"]({ sessionID: sid, tool: "read", args: { path: "глава_01.md" } }, rd)
  // the deliverable write triggers the gate; under bun test aux is inert → runGate returns "" → output unchanged
  const del = writeResult("The analysis claims «Кружка тёплая сама по себе.» and correlation 0.9999. ".repeat(2))
  await expect(
    h["tool.execute.after"]({ sessionID: sid, tool: "create_file", args: { path: "analysis.md", content: del.output } }, del),
  ).resolves.toBeUndefined()
  // no crash, and with no aux the deliverable is not falsely flagged
  expect(typeof del.output).toBe("string")
})
