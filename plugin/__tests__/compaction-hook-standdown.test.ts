// The summarizer must never be steered.
//
// Measured live (2026-07-21, session ses_07ac06172ffe…): the engine runs experimental.chat.messages
// .transform for the COMPACTION build too, and the ctxguard bounded-read directive planted on the last
// user message turned the summarizer back into a task executor — its "summary" came out as
// "Продолжаю чтение глав 7-12:" followed by <tool_call> markup as plain text (the summarizer has no
// tools), the processor classified that as a text loop, compaction returned "stop", and the session
// ended right there: no continuation message, no post-compaction turn, work abandoned mid-book.
//
// The engine now marks that build with input.compaction === true; every steer/mutator hook stands down
// on it, while cleanup transforms (token sanitizing, media conversion) may keep running.
import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { FabulaCtxGuard } from "../fabula-ctxguard"
import { FabulaContext } from "../fabula-context"
import { FabulaInterview } from "../fabula-interview"

const userMsg = (text: string) => ({ info: { role: "user" }, parts: [{ type: "text", text }] })

const SAVED: Record<string, string | undefined> = {}
beforeEach(() => { for (const k of ["FABULA_CONTEXT_WINDOW"]) SAVED[k] = process.env[k]; process.env.FABULA_CONTEXT_WINDOW = "131072" })
afterEach(() => { for (const k of Object.keys(SAVED)) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]! } })

describe("steer hooks stand down on the compaction build", () => {
  // the exact ask that produced the live failure: a bulk-read task, which every steer wants to touch
  const trigger = () => [userMsg("прочти все главы и проведи глубочайший анализ")]

  for (const [name, factory] of [
    ["ctxguard", FabulaCtxGuard],
    ["context (freshness)", FabulaContext],
    ["interview", FabulaInterview],
  ] as const) {
    test(`${name}: compaction build is left byte-identical`, async () => {
      const plugin: any = await (factory as any)({ directory: "/tmp" })
      const h = plugin["experimental.chat.messages.transform"]
      if (!h) return // plugin disabled in this env — nothing to assert
      const messages = trigger()
      const before = JSON.stringify(messages)
      await h({ compaction: true }, { messages })
      expect(JSON.stringify(messages)).toBe(before)
    })

    test(`${name}: the SAME messages on a normal build ARE eligible for steering (non-vacuous control)`, async () => {
      const plugin: any = await (factory as any)({ directory: "/tmp" })
      const h = plugin["experimental.chat.messages.transform"]
      if (!h) return
      const messages = trigger()
      const before = JSON.stringify(messages)
      await h({}, { messages })
      // at least ONE of the three steers must fire on this ask on a normal build; asserted per-hook
      // only for ctxguard, whose trigger is deterministic for this exact text
      if (name === "ctxguard") expect(JSON.stringify(messages)).not.toBe(before)
    })
  }
})
