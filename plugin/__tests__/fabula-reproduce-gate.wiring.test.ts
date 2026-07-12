// Wiring test: invokes the REAL reproduce-gate hooks with the engine's exact input/output contract.
// verify_done resolves { output: verifyReport(...), metadata: { passed, ... } }; appending to
// output.output reaches the model. This proves the glue records edits and downgrades a green
// verify_done when no reproduction test was written.
import { test, expect } from "bun:test"
import { FabulaReproduceGate } from "../fabula-reproduce-gate"

async function hooks() {
  return (await FabulaReproduceGate({} as any)) as any
}
// mimic verifyReport's green header so the downgrade replace() has a target
const GREEN = "✅ VERIFIED DONE — `pytest` (pytest) passed.\n\n--- output ---\nall good"

test("plugin is enabled by default and exposes the hooks", async () => {
  const h = await hooks()
  expect(typeof h["chat.message"]).toBe("function")
  expect(typeof h["tool.execute.after"]).toBe("function")
})

test("green verify_done after a SOURCE edit with NO test → downgraded + reproduce steer", async () => {
  const h = await hooks()
  const sid = "s-norepro"
  await h["chat.message"]({ sessionID: sid })
  // agent edits source only
  await h["tool.execute.after"](
    { tool: "str_replace", sessionID: sid, args: { file_path: "qutebrowser/misc/elf.py" } },
    { output: "ok", metadata: {} },
  )
  // verify_done comes back green
  const o = { output: GREEN, metadata: { passed: true, exitCode: 0, cmd: "pytest" } }
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
  expect(o.output).toContain("NOT YET DONE (reproduce-first gate)")
  expect(o.output).toContain("reproduction test")
  expect(o.output).not.toContain("✅ VERIFIED DONE")
  expect(o.metadata.reproduceGate).toBe("steered")
})

test("SWE-bench contract (task forbids test edits) → gate stands down: green verify NOT steered", async () => {
  const h = await hooks()
  const sid = "s-forbidden"
  // the REAL engine shape: chat.message fires with (hookInput, { message, parts }) — feed the exact
  // bench-runner contract line so taskForbidsTests() sees it
  await h["chat.message"](
    { sessionID: sid },
    { message: { id: "m1", role: "user" }, parts: [{ type: "text", text:
      "You are working in the ansible/ansible Python repository. Fix the issue below by editing the " +
      "SOURCE code only (never edit or add test files).\n\n=== ISSUE ===\nmin/max kwargs" }] },
  )
  await h["tool.execute.after"](
    { tool: "str_replace", sessionID: sid, args: { file_path: "lib/ansible/plugins/filter/mathstuff.py" } },
    { output: "ok", metadata: {} },
  )
  const o = { output: GREEN, metadata: { passed: true, exitCode: 0, cmd: "pytest" } }
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
  expect(o.output).toBe(GREEN)                       // untouched — no downgrade
  expect((o.metadata as any).reproduceGate).toBeUndefined()
})

test("normal task (no prohibition) still steers — the stand-down is scoped to forbidding tasks only", async () => {
  const h = await hooks()
  const sid = "s-normal-task"
  await h["chat.message"](
    { sessionID: sid },
    { message: { id: "m1", role: "user" }, parts: [{ type: "text", text: "Fix the ELF parsing bug in qutebrowser." }] },
  )
  await h["tool.execute.after"](
    { tool: "str_replace", sessionID: sid, args: { file_path: "qutebrowser/misc/elf.py" } },
    { output: "ok", metadata: {} },
  )
  const o = { output: GREEN, metadata: { passed: true } }
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
  expect(o.output).toContain("NOT YET DONE (reproduce-first gate)")
  expect(o.output).toContain("NEW scratch file")     // the steer now names a scratch file
  expect((o.metadata as any).reproduceGate).toBe("steered")
})

test("green verify_done WITH a reproduction test written → done stands, untouched", async () => {
  const h = await hooks()
  const sid = "s-withrepro"
  await h["chat.message"]({ sessionID: sid })
  await h["tool.execute.after"](
    { tool: "str_replace", sessionID: sid, args: { file_path: "qutebrowser/misc/elf.py" } },
    { output: "ok", metadata: {} },
  )
  await h["tool.execute.after"](
    { tool: "create_file", sessionID: sid, args: { file_path: "tests/unit/misc/test_elf.py" } },
    { output: "ok", metadata: {} },
  )
  const o = { output: GREEN, metadata: { passed: true } }
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
  expect(o.output).toBe(GREEN)
  expect(o.metadata.reproduceGate).toBeUndefined()
})

test("FAILED verify_done is never touched (verifyReport already says NOT DONE)", async () => {
  const h = await hooks()
  const sid = "s-fail"
  await h["chat.message"]({ sessionID: sid })
  await h["tool.execute.after"](
    { tool: "str_replace", sessionID: sid, args: { file_path: "src/foo.ts" } },
    { output: "ok", metadata: {} },
  )
  const red = "❌ NOT DONE — `pytest` FAILED."
  const o = { output: red, metadata: { passed: false } }
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
  expect(o.output).toBe(red)
})

test("chat.message resets the change set (new task) so a stale source edit doesn't nag", async () => {
  const h = await hooks()
  const sid = "s-reset"
  await h["chat.message"]({ sessionID: sid })
  await h["tool.execute.after"](
    { tool: "str_replace", sessionID: sid, args: { file_path: "src/foo.ts" } },
    { output: "ok", metadata: {} },
  )
  await h["chat.message"]({ sessionID: sid }) // new turn wipes the change set
  const o = { output: GREEN, metadata: { passed: true } }
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
  expect(o.output).toBe(GREEN) // no source recorded this turn → no steer
})

test("docs-only edit does not trigger the gate", async () => {
  const h = await hooks()
  const sid = "s-docs"
  await h["chat.message"]({ sessionID: sid })
  await h["tool.execute.after"](
    { tool: "create_file", sessionID: sid, args: { file_path: "README.md" } },
    { output: "ok", metadata: {} },
  )
  const o = { output: GREEN, metadata: { passed: true } }
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
  expect(o.output).toBe(GREEN)
})

test("apply_patch (the gpt-class edit path) is tracked: blind green after a patch-only source edit is downgraded", async () => {
  const h = await hooks()
  const sid = "s-apply-patch"
  await h["chat.message"]({ sessionID: sid })
  // the model edits SOURCE via apply_patch — the tool gpt-style models route ALL edits through
  const patch = "*** Begin Patch\n*** Update File: src/export.ts\n@@\n-a\n+b\n*** End Patch"
  await h["tool.execute.after"](
    { tool: "apply_patch", sessionID: sid, args: { patch_text: patch } },
    { output: "ok", metadata: {} },
  )
  const o = { output: GREEN, metadata: { passed: true, exitCode: 0, cmd: "bun test" } }
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
  expect(o.output).toContain("NOT YET DONE (reproduce-first gate)")   // was INVISIBLE before edittools
})
