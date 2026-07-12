// Wiring test: fabula-learn must FIRE ITSELF — a green verify_done on top of a real multi-step change
// (>= LEARN_MIN_EDITS source edits) gets a /distill packaging nudge appended to the result. This
// proves the deterministic hook glue (no network, no aux model).
import { test, expect } from "bun:test"
import { FabulaLearn } from "../fabula-learn"
import { LEARN_MIN_EDITS } from "../lib/learn"

async function plugin() {
  return (await FabulaLearn({} as any)) as any
}
const GREEN = "✅ VERIFIED DONE — `bun test` passed.\n\n--- output ---\nok"

test("exposes the self-nudge hooks", async () => {
  const p = await plugin()
  expect(typeof p["chat.message"]).toBe("function")
  expect(typeof p["tool.execute.after"]).toBe("function")
})

test("disabled via FABULA_LEARN_NUDGE=0 → no hooks", async () => {
  process.env.FABULA_LEARN_NUDGE = "0"
  try {
    const p = await plugin()
    expect(p["tool.execute.after"]).toBeUndefined()
  } finally {
    delete process.env.FABULA_LEARN_NUDGE
  }
})

test("green verify after a real multi-step change → /distill nudge", async () => {
  const p = await plugin()
  const sid = "learn-yes"
  await p["chat.message"]({ sessionID: sid })
  for (let i = 0; i < LEARN_MIN_EDITS; i++)
    await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: `src/f${i}.ts` } }, { output: "ok", metadata: {} })
  const o = { output: GREEN, metadata: { passed: true } }
  await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
  expect(o.output).toContain("/distill")
  expect(o.metadata.learn).toBe("nudged")
})

test("green verify after a trivial change → no nudge", async () => {
  const p = await plugin()
  const sid = "learn-trivial"
  await p["chat.message"]({ sessionID: sid })
  await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "src/one.ts" } }, { output: "ok", metadata: {} })
  const o = { output: GREEN, metadata: { passed: true } }
  await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
  expect(o.output).toBe(GREEN)
})

test("nudge fires at most once per turn", async () => {
  const p = await plugin()
  const sid = "learn-once"
  await p["chat.message"]({ sessionID: sid })
  for (let i = 0; i < LEARN_MIN_EDITS; i++)
    await p["tool.execute.after"]({ tool: "write", sessionID: sid, args: { path: `src/g${i}.ts` } }, { output: "ok", metadata: {} })
  const o1 = { output: GREEN, metadata: { passed: true } }
  await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o1)
  expect(o1.output).toContain("/distill")
  const o2 = { output: GREEN, metadata: { passed: true } }
  await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o2)
  expect(o2.output).toBe(GREEN)
})
