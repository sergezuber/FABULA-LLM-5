// Drives the REAL fabula-ctxguard hook against real message arrays — the pure core is unit-tested
// separately; here we prove the wired hook mutates the right part, only when it should, and never twice.
//
// The load-bearing assertion is the EFFICIENCY CONTRACT: on an ordinary turn below the high-water mark the
// hook leaves the messages BYTE-IDENTICAL, so the static prefix stays cache-warm and normal work pays
// nothing. It is a mutation test: it would fail if the guard ever fired on a normal turn.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { FabulaCtxGuard } from "../fabula-ctxguard"
import { CONSOLIDATE_MARKER, BOUNDED_MARKER } from "../lib/ctxguard"

const userMsg = (text: string) => ({ info: { role: "user" }, parts: [{ type: "text", text }] })
const asstMsg = (text: string) => ({ info: { role: "assistant" }, parts: [{ type: "text", text }] })

async function hook() {
  const plugin: any = await FabulaCtxGuard({} as any)
  return plugin["experimental.chat.messages.transform"] as (i: any, o: any) => Promise<void>
}

const SAVED: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of ["FABULA_CONTEXT_WINDOW", "FABULA_CTX_HIGH_WATER", "FABULA_CTX_CHARS_PER_TOKEN", "FABULA_CTX_GUARD", "FABULA_DISABLE"]) SAVED[k] = process.env[k]
})
afterEach(() => {
  for (const k of Object.keys(SAVED)) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]! }
})

test("EFFICIENCY CONTRACT: an ordinary turn below high-water is left byte-identical", async () => {
  process.env.FABULA_CONTEXT_WINDOW = "131072"
  const h = await hook()
  const messages = [asstMsg("earlier reply"), userMsg("fix the failing test in utils.ts")]
  const before = JSON.stringify(messages)
  await h({}, { messages })
  expect(JSON.stringify(messages)).toBe(before) // no mutation → no cache break → no cost
})

test("a bulk-read ask below the ceiling gets the bounded-read steer on the user turn", async () => {
  process.env.FABULA_CONTEXT_WINDOW = "131072"
  const h = await hook()
  const messages = [userMsg("прочти все главы и проведи глубочайший анализ")]
  await h({}, { messages })
  const text = messages[0].parts[0].text
  expect(text).toContain(BOUNDED_MARKER)
  expect(text.startsWith("прочти все главы")).toBe(true) // original ask preserved, directive appended
})

test("a near-ceiling context gets the consolidate steer regardless of the ask", async () => {
  process.env.FABULA_CONTEXT_WINDOW = "1000"
  process.env.FABULA_CTX_HIGH_WATER = "0.75"
  process.env.FABULA_CTX_CHARS_PER_TOKEN = "1"
  const h = await hook()
  // a fat prior tool result pushes the estimate over 750 tokens; the ask itself is ordinary
  const messages = [asstMsg("z".repeat(4000)), userMsg("keep going")]
  await h({}, { messages })
  expect(messages[1].parts[0].text).toContain(CONSOLIDATE_MARKER)
})

test("idempotent: running the hook twice does not append the directive twice", async () => {
  process.env.FABULA_CONTEXT_WINDOW = "131072"
  const h = await hook()
  const messages = [userMsg("review every file in the repo")]
  await h({}, { messages })
  const once = messages[0].parts[0].text
  await h({}, { messages })
  expect(messages[0].parts[0].text).toBe(once) // second pass sees its own marker and returns
})

test("kill-switch FABULA_CTX_GUARD=0 makes the hook inert even on a bulk-read ask", async () => {
  process.env.FABULA_CONTEXT_WINDOW = "131072"
  process.env.FABULA_CTX_GUARD = "0"
  const h = await hook()
  const messages = [userMsg("read all chapters and analyze")]
  const before = JSON.stringify(messages)
  await h({}, { messages })
  expect(JSON.stringify(messages)).toBe(before)
})

test("disabled plugin returns no hook", async () => {
  process.env.FABULA_DISABLE = "ctxguard"
  const plugin: any = await FabulaCtxGuard({} as any)
  expect(plugin["experimental.chat.messages.transform"]).toBeUndefined()
})
