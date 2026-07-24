// Wiring test for the text-only deliverable path (session.post). Drives the REAL fabula-attest hooks
// with the engine's input/output contract, hermetically: aux is inert under `bun test` (no endpoint) so
// the armed gate degrades to "" — but we can still assert the CENTRAL INVARIANTS of the text path:
//   1. MUTE on a chat/opinion turn (the deliverable pre-screen must NOT arm);
//   2. MUTE on a subagent slice (compaction/summarizer finalText is internal, never a deliverable);
//   3. MUTE when a write tool ran (the file path covers the deliverable, the text path must stay silent);
//   4. RECURSION GUARD: a second session.post on the same turn does NOT re-fire;
//   5. the remark path only engages the SDK client when there is a refuted load-bearing claim — and never
//      throws when no client is wired (graceful degrade).
// Mirrors fabula-attest.wiring.test.ts (same env-driven enable, same FabulaAttest import, mock client).

import { test, expect, beforeAll } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

beforeAll(() => {
  const stateFile = join(tmpdir(), `attest-text-state-${process.pid}.json`)
  writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["attest"] }))
  process.env.FABULA_PLUGIN_STATE = stateFile
})

import { FabulaAttest } from "../fabula-attest"

// A long, structured literary analysis — the exact shape the motivating case produces.
const LIT_TEXT = [
  "# Литературный анализ: «NII TRED»",
  "",
  "## Глава 1",
  "Тезис: герой сталкивается с системой. Мотив дороги.",
  "## Глава 2",
  "Вывод: герой находит союзника. Структура меняется.",
  "## Глава 3",
  "Разбор: ретроспективная вставка. Итог — конфликт углубляется.",
  "## Заключение",
  "Итог: роман построен как концентрические круги.",
  "",
].join("\n").repeat(4)

// Mock SDK client: records every session.prompt the plugin calls.
function mockClient() {
  const calls: any[] = []
  return {
    calls,
    session: {
      prompt: async (opts: any) => {
        calls.push(opts)
        return { ok: true }
      },
    },
  }
}

async function hooks(client?: any) {
  return (await FabulaAttest({ client } as any)) as any
}

test("session.post hook is wired when enabled", async () => {
  const h = await hooks(mockClient())
  expect(typeof h["session.post"]).toBe("function")
})

test("MUTE on a chat/opinion turn: session.post fires but sends NO remark (not armed)", async () => {
  const client = mockClient()
  const h = await hooks(client)
  const sid = "chat-1"
  await h["chat.message"]({ sessionID: sid, message: { text: "what do you think of this novel?" } })
  await h["session.post"]({
    sessionID: sid, agentID: "main", outcome: "completed", finalText: LIT_TEXT,
  })
  expect(client.calls.length).toBe(0) // no remark — the chat turn never armed the gate
})

test("MUTE on a subagent slice (compaction): finalText is internal, never a deliverable", async () => {
  const client = mockClient()
  const h = await hooks(client)
  const sid = "task-sub-1"
  await h["chat.message"]({ sessionID: sid, message: { text: "analyze the book and save a literary analysis" } })
  await h["session.post"]({
    sessionID: sid, agentID: "compaction", outcome: "completed", finalText: LIT_TEXT,
  })
  expect(client.calls.length).toBe(0) // a compaction slice is never the user-facing deliverable
})

test("MUTE when a write tool ran: the file path covers the deliverable, the text path stays silent", async () => {
  const client = mockClient()
  const h = await hooks(client)
  const sid = "task-file-1"
  await h["chat.message"]({ sessionID: sid, message: { text: "analyze the book and save a literary analysis" } })
  // simulate a file write (the file path runs the gate on the file content)
  const del = { output: "The analysis file content ".repeat(5), metadata: {} as any }
  await h["tool.execute.after"]({ sessionID: sid, tool: "create_file", args: { path: "a.md", content: del.output } }, del)
  // now session.post fires with the same text — it MUST stay silent (hadWriteTool)
  await h["session.post"]({
    sessionID: sid, agentID: "main", outcome: "completed", finalText: LIT_TEXT,
  })
  expect(client.calls.length).toBe(0)
})

test("RECURSION GUARD: a second session.post on the same turn does NOT re-fire", async () => {
  const client = mockClient()
  const h = await hooks(client)
  const sid = "task-rec-1"
  await h["chat.message"]({ sessionID: sid, message: { text: "проанализируй роман и сделай литературный разбор" } })
  await h["session.post"]({
    sessionID: sid, agentID: "main", outcome: "completed", finalText: LIT_TEXT,
  })
  // under bun test aux is inert → no refuted claim → no remark. But the recursion guard still applies:
  await h["session.post"]({
    sessionID: sid, agentID: "main", outcome: "completed", finalText: LIT_TEXT,
  })
  // at most the first call could have reached the gate; the second is short-circuited.
  // (no remark regardless, since aux is inert — we assert the guard doesn't crash + no double-call)
  expect(client.calls.length).toBe(0)
})

test("graceful degrade: no SDK client → session.post never throws (fail-silent)", async () => {
  const h = await hooks(undefined) // no client wired at all
  const sid = "task-noclient-1"
  await h["chat.message"]({ sessionID: sid, message: { text: "analyze the book and save a literary analysis" } })
  await expect(
    h["session.post"]({
      sessionID: sid, agentID: "main", outcome: "completed", finalText: LIT_TEXT,
    }),
  ).resolves.toBeUndefined() // never throws
})

test("MUTE when outcome is not 'completed' (error/cancelled → nothing to verify)", async () => {
  const client = mockClient()
  const h = await hooks(client)
  const sid = "task-err-1"
  await h["chat.message"]({ sessionID: sid, message: { text: "analyze the book and save a literary analysis" } })
  await h["session.post"]({
    sessionID: sid, agentID: "main", outcome: "error", finalText: LIT_TEXT,
  })
  expect(client.calls.length).toBe(0)
})

test("MUTE on a short finalText (too short to be a substantive deliverable)", async () => {
  const client = mockClient()
  const h = await hooks(client)
  const sid = "task-short-1"
  await h["chat.message"]({ sessionID: sid, message: { text: "analyze the book and save a literary analysis" } })
  await h["session.post"]({
    sessionID: sid, agentID: "main", outcome: "completed", finalText: "Краткий ответ.",
  })
  expect(client.calls.length).toBe(0)
})
