// Wiring test: interview auto-nudge must FIRE ITSELF — an underspecified implementation task gets the
// interview nudge appended to that turn's user message; a well-specified one is left alone. Tool triage
// hits the aux model (network); here we prove the deterministic nudge glue.
import { test, expect } from "bun:test"
import { FabulaInterview } from "../fabula-interview"
import { INTERVIEW_NUDGE } from "../lib/interview"

async function plugin() { return (await FabulaInterview({} as any)) as any }
const mk = (text: string) => ({ messages: [{ role: "user", content: text }] })

test("exposes interview_me tool + the messages-transform nudge hook", async () => {
  const p = await plugin()
  expect(p.tool?.interview_me).toBeDefined()
  expect(typeof p["experimental.chat.messages.transform"]).toBe("function")
})

test("underspecified implementation task → interview nudge appended", async () => {
  const p = await plugin()
  const out = mk("add caching to the store")
  await p["experimental.chat.messages.transform"]({ sessionID: "iv-1" }, out)
  expect(out.messages[0].content).toContain("interview-me")
  expect(out.messages[0].content).toContain("add caching to the store") // original preserved
})

test("well-specified task (path + symbol) → left alone", async () => {
  const p = await plugin()
  const out = mk("add farewell() to src/farewell.py matching `greet()` in src/greet.py")
  await p["experimental.chat.messages.transform"]({ sessionID: "iv-2" }, out)
  expect(out.messages[0].content).not.toContain("interview-me")
})

test("non-implementation question → left alone", async () => {
  const p = await plugin()
  const out = mk("what does _find_versions do?")
  await p["experimental.chat.messages.transform"]({ sessionID: "iv-3" }, out)
  expect(out.messages[0].content).not.toContain("interview-me")
})

test("nudges the same task only once", async () => {
  const p = await plugin()
  const sid = "iv-once"
  const o1 = mk("implement rate limiting")
  await p["experimental.chat.messages.transform"]({ sessionID: sid }, o1)
  expect(o1.messages[0].content).toContain("interview-me")
  const o2 = mk("implement rate limiting") // same task text again
  await p["experimental.chat.messages.transform"]({ sessionID: sid }, o2)
  expect(o2.messages[0].content).toBe("implement rate limiting") // not re-nudged
})

test("array-of-parts content → nudge pushed as a text part", async () => {
  const p = await plugin()
  const out: any = { messages: [{ role: "user", content: [{ type: "text", text: "add pagination" }] }] }
  await p["experimental.chat.messages.transform"]({ sessionID: "iv-parts" }, out)
  const joined = out.messages[0].content.map((x: any) => x.text).join(" ")
  expect(joined).toContain("interview-me")
})

test("kill-switch FABULA_INTERVIEW_NUDGE=0 silences the nudge (tool stays)", async () => {
  const prev = process.env.FABULA_INTERVIEW_NUDGE
  process.env.FABULA_INTERVIEW_NUDGE = "0"
  try {
    const p = await plugin()
    const out = mk("add caching to the store")
    await p["experimental.chat.messages.transform"]({ sessionID: "iv-off" }, out)
    expect(out.messages[0].content).toBe("add caching to the store")
    expect(p.tool?.interview_me).toBeDefined() // tool still available
  } finally {
    if (prev === undefined) delete process.env.FABULA_INTERVIEW_NUDGE
    else process.env.FABULA_INTERVIEW_NUDGE = prev
  }
})
