// Wiring test: real FabulaUnknowns hooks with the engine's contract. The reference-first steer must
// FIRE ITSELF on the first source edit made with no prior reference/unknowns pass, and stay quiet once
// a pass happened. Tool execution hits the aux model (network) so it's exercised elsewhere; here we
// prove the deterministic gate glue.
import { test, expect } from "bun:test"
import { FabulaUnknowns } from "../fabula-unknowns"

async function plugin() {
  return (await FabulaUnknowns({} as any)) as any
}

test("plugin exposes reference_hunt + surface_unknowns tools and the gate hooks", async () => {
  const p = await plugin()
  expect(p.tool?.reference_hunt).toBeDefined()
  expect(p.tool?.surface_unknowns).toBeDefined()
  expect(typeof p["chat.message"]).toBe("function")
  expect(typeof p["tool.execute.after"]).toBe("function")
})

test("reference-first steer fires on the FIRST source edit with no prior reference pass", async () => {
  const p = await plugin()
  const sid = "s-noref"
  await p["chat.message"]({ sessionID: sid })
  const o = { output: "Created qutebrowser/misc/elf.py (200 bytes).", metadata: {} }
  await p["tool.execute.after"]({ tool: "create_file", sessionID: sid, args: { file_path: "qutebrowser/misc/elf.py" } }, o)
  expect(o.output).toContain("REFERENCE-FIRST")
  expect(o.output).toContain("reference_hunt")
  expect(o.metadata.referenceFirst).toBe("steered")
})

test("no steer after a reference pass (reference_hunt was called)", async () => {
  const p = await plugin()
  const sid = "s-ref"
  await p["chat.message"]({ sessionID: sid })
  // simulate the tool having run (the after-hook marks the pass)
  await p["tool.execute.after"]({ tool: "reference_hunt", sessionID: sid, args: {} }, { output: "…contract…", metadata: {} })
  const o = { output: "Edited src/store.ts", metadata: {} }
  await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "src/store.ts" } }, o)
  expect(o.output).toBe("Edited src/store.ts")
  expect(o.metadata.referenceFirst).toBeUndefined()
})

test("steer fires only ONCE per task (no nagging on later edits)", async () => {
  const p = await plugin()
  const sid = "s-once"
  await p["chat.message"]({ sessionID: sid })
  const o1 = { output: "Edited a.ts", metadata: {} }
  await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "a.ts" } }, o1)
  expect(o1.output).toContain("REFERENCE-FIRST") // first edit → steer
  const o2 = { output: "Edited b.ts", metadata: {} }
  await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "b.ts" } }, o2)
  expect(o2.output).toBe("Edited b.ts") // second edit → quiet
})

test("no steer on a non-source edit (docs/config)", async () => {
  const p = await plugin()
  const sid = "s-docs"
  await p["chat.message"]({ sessionID: sid })
  const o = { output: "Created README.md", metadata: {} }
  await p["tool.execute.after"]({ tool: "create_file", sessionID: sid, args: { file_path: "README.md" } }, o)
  expect(o.output).toBe("Created README.md")
})

test("kill-switch FABULA_REFERENCE_FIRST=0 silences the steer", async () => {
  const prev = process.env.FABULA_REFERENCE_FIRST
  process.env.FABULA_REFERENCE_FIRST = "0"
  try {
    const p = await plugin()
    const sid = "s-off"
    await p["chat.message"]({ sessionID: sid })
    const o = { output: "Edited x.ts", metadata: {} }
    await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "x.ts" } }, o)
    expect(o.output).toBe("Edited x.ts")
  } finally {
    if (prev === undefined) delete process.env.FABULA_REFERENCE_FIRST
    else process.env.FABULA_REFERENCE_FIRST = prev
  }
})
