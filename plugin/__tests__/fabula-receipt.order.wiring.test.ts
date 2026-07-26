// Wiring test for the receipt's ORDER-INDEPENDENT mint gating. Plugins load in glob order
// (fabula-receipt BEFORE fabula-reproduce-gate), so on the same verify_done event the receipt's
// after-hook sees the output BEFORE the reproduce-gate rewrites it. A naive receipt would mint a
// Proof-of-Done for a green suite that never exercised the fix. This drives BOTH real hooks in real
// glob order against a REAL git workspace and proves: (1) blind green → no mint; (2) after the test
// is written → mint, and the receipt's gates[] records that the reproduce requirement was forced.
import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from "node:fs"
import { execSync } from "node:child_process"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { FabulaReceipt } from "../fabula-receipt"
import { FabulaReproduceGate } from "../fabula-reproduce-gate"
import { FabulaChangeQuiz } from "../fabula-change-quiz"

function repo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fab-rcpt-")))
  execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: dir })
  writeFileSync(path.join(dir, "export.ts"), "export const ok = 1\n")
  execSync("git add -A && git -c user.email=t@t -c user.name=t commit -q -m base", { cwd: dir })
  return dir
}

const GREEN = "✅ VERIFIED DONE — `bun test` (package test script) passed.\n\n--- output ---\nall good"

test("glob order: blind green mints NOTHING; test-backed green mints with the reproduce gate recorded", async () => {
  const ws = repo()
  // real glob order: fabula-receipt.ts < fabula-reproduce-gate.ts
  const receipt = (await FabulaReceipt({ directory: ws } as any)) as any
  const repro = (await FabulaReproduceGate({ directory: ws } as any)) as any
  const sid = "s-order"
  // an agentic run fires chat.message before EVERY inference step with the SAME last user message —
  // the receipt state must survive these repeats (only a NEW user message resets it)
  // REAL engine shape: { message: info, parts } once per user prompt (repeats are same messageID)
  const step = async () => {
    await receipt["chat.message"](
      { sessionID: sid, messageID: "msg-1", model: "qwen-test-35b" },
      { message: { id: "msg-1", sessionID: sid, role: "user" }, parts: [{ type: "text", text: "Fix the export bug" }] },
    )
  }
  const run = async (tool: string, args: any, out: any) => {
    await step()
    await receipt["tool.execute.after"]({ tool, sessionID: sid, args }, out)   // receipt FIRST (glob order)
    await repro["tool.execute.after"]({ tool, sessionID: sid, args }, out)
    return out
  }
  await repro["chat.message"]({ sessionID: sid })
  await step()
  // the engine hands the resolved model to chat.params on every request — authoritative identity
  await receipt["chat.params"]({ sessionID: sid, model: { id: "qwen-test-35b", providerID: "lmstudio" } }, {})

  // 1) the model edits SOURCE only, then verify comes back green (suite never covered the change)
  writeFileSync(path.join(ws, "export.ts"), "export const ok = 2\n")
  await run("str_replace", { file_path: path.join(ws, "export.ts") }, { output: "ok", metadata: {} })
  const o1 = await run("verify_done", {}, { output: GREEN, metadata: { passed: true, exitCode: 0, cmd: "bun test" } })

  // receipt did NOT mint on the unproven green…
  expect(String(o1.output)).not.toContain("receipt minted")
  expect(existsSync(path.join(ws, ".fabula", "receipts", "latest.json"))).toBe(false)
  // …while the reproduce-gate (running after) downgraded the same output
  expect(String(o1.output)).toContain("NOT YET DONE")

  // 2) the model writes the reproducing test; verify green again — STILL no mint: the change-quiz
  // gate (active by default) hasn't passed, and its hook order vs ours is unspecified
  writeFileSync(path.join(ws, "export.test.ts"), "// boundary repro\n")
  await run("create_file", { file_path: path.join(ws, "export.test.ts") }, { output: "ok", metadata: {} })
  const o2a = await run("verify_done", {}, { output: GREEN, metadata: { passed: true, exitCode: 0, cmd: "bun test" } })
  expect(String(o2a.output)).not.toContain("receipt minted")

  // 3) the quiz PASSes — the receipt mints RIGHT ON the pass, from the stored gated green
  // (a local model reliably stops after "you may claim done" without re-running verify; the mint
  // must not depend on that initiative)
  const o2 = await run("change_quiz", {}, { output: "✅ change_quiz PASS — you understand your change", metadata: { passed: true } })

  expect(String(o2.output)).toContain("Proof-of-Done receipt minted")
  const latest = path.join(ws, ".fabula", "receipts", "latest.json")
  expect(existsSync(latest)).toBe(true)
  const r = JSON.parse(readFileSync(latest, "utf8"))
  const gateIds = (r.gates || []).map((g: any) => g.id)
  expect(gateIds).toContain("verify")
  expect(gateIds).toContain("reproduce")            // the forced requirement is part of the evidence
  expect(gateIds).toContain("comprehension")        // the quiz PASS is recorded too
  expect(r.model.id).toBe("qwen-test-35b")          // model captured (chat.params is authoritative)
  expect(r.task).toContain("Fix the export bug")    // the task text is part of the evidence
  // the patch (untracked test file included) is real
  const patch = readFileSync(path.join(ws, r.artifact.patch), "utf8")
  expect(patch).toContain("export.test.ts")
  expect(patch).toContain("export.ts")

  rmSync(ws, { recursive: true, force: true })
})

// confirmed[1]: the change-quiz plugin loads BEFORE the receipt (glob order c < r), so on the same
// green verify_done its after-hook rewrites the text to "⏳ NOT YET DONE" and stamps
// metadata.changeQuiz="steered" BEFORE the receipt sees it. The receipt used to decide whether to hold
// a pending green from that MUTATED text (isTrueGreen), so it dropped the green and NEVER minted on the
// later quiz PASS — a silent miss on every comprehension-gated task. This drives the two REAL hooks in
// the real order and proves the receipt captures the pending green from the raw metadata and mints on
// the quiz PASS.
test("change-quiz runs BEFORE the receipt: a steered green still mints on the quiz PASS", async () => {
  const ws = repo()
  const quiz = (await FabulaChangeQuiz({ directory: ws } as any)) as any   // loads FIRST (c < r)
  const receipt = (await FabulaReceipt({ directory: ws } as any)) as any
  const sid = "s-quiz-first"

  const step = async () => {
    await quiz["chat.message"]({ sessionID: sid })
    await receipt["chat.message"](
      { sessionID: sid, messageID: "m1", model: "qwen-test-35b" },
      { message: { id: "m1", sessionID: sid, role: "user" }, parts: [{ type: "text", text: "Fix the export bug" }] },
    )
  }
  // real glob order on EVERY tool event: change-quiz's after-hook, THEN the receipt's, on the SAME output
  const run = async (tool: string, args: any, out: any) => {
    await quiz["tool.execute.after"]({ tool, sessionID: sid, args }, out)
    await receipt["tool.execute.after"]({ tool, sessionID: sid, args }, out)
    return out
  }
  await step()
  await receipt["chat.params"]({ sessionID: sid, model: { id: "qwen-test-35b", providerID: "lmstudio" } }, {})

  // edit source AND write the repro test (so the reproduce gate is satisfied and ONLY the change-quiz
  // gate is holding the green — isolating the confirmed[1] scenario)
  writeFileSync(path.join(ws, "export.ts"), "export const ok = 2\n")
  await run("str_replace", { file_path: path.join(ws, "export.ts") }, { output: "ok", metadata: {} })
  writeFileSync(path.join(ws, "export.test.ts"), "// boundary repro\n")
  await run("create_file", { file_path: path.join(ws, "export.test.ts") }, { output: "ok", metadata: {} })

  // green verify — change-quiz (first) steers it to NOT YET DONE + metadata.changeQuiz="steered"
  const o1 = await run("verify_done", {}, { output: GREEN, metadata: { passed: true, exitCode: 0, cmd: "bun test" } })
  expect(String(o1.output)).toContain("NOT YET DONE")          // change-quiz downgraded the text…
  expect(o1.metadata.changeQuiz).toBe("steered")               // …and stamped its marker
  expect(String(o1.output)).not.toContain("receipt minted")    // receipt HELD (did not mint over a gated green)
  expect(existsSync(path.join(ws, ".fabula", "receipts", "latest.json"))).toBe(false)

  // the quiz PASSes — the receipt mints from the pending green it DID capture (from raw metadata, not
  // the rewritten text). Pre-fix this stayed empty forever.
  const o2 = await run("change_quiz", {}, { output: "✅ change_quiz PASS — you understand your change", metadata: { passed: true } })
  expect(String(o2.output)).toContain("Proof-of-Done receipt minted")
  const latest = path.join(ws, ".fabula", "receipts", "latest.json")
  expect(existsSync(latest)).toBe(true)
  const r = JSON.parse(readFileSync(latest, "utf8"))
  const gateIds = (r.gates || []).map((g: any) => g.id)
  expect(gateIds).toContain("verify")
  expect(gateIds).toContain("comprehension")
  expect(r.verification.passed).toBe(true)                     // the captured green is recorded as passing

  rmSync(ws, { recursive: true, force: true })
})

// ── The zero-artifact rule (measured defect, 2026-07-26) ─────────────────────
// A background checkpoint-writer minted a receipt reading "VERIFIED" over the tracked public demo:
// artifact 0 files / 0 bytes, a 0-byte patch, and its `task` was the writer's own system-reminder.
// The manual `mint_receipt` had refused an empty diff since the beginning; the AUTO path never asked,
// and nothing anywhere looked at which agent was driving.
test("a green verify with NOTHING changed mints no receipt", async () => {
  const ws = repo()
  const receipt = (await FabulaReceipt({ directory: ws } as any)) as any
  const sid = "s-empty"
  await receipt["chat.message"](
    { sessionID: sid, messageID: "m", model: "qwen-test-35b", agent: "build" },
    { message: { id: "m", sessionID: sid, role: "user" }, parts: [{ type: "text", text: "run the suite" }] },
  )
  // No edit at all — the tree is exactly the base commit, so `git diff HEAD` is empty.
  const out = await receipt["tool.execute.after"](
    { tool: "verify_done", sessionID: sid, args: {} },
    { output: GREEN, metadata: { passed: true, exitCode: 0, cmd: "bun test" } },
  )
  void out
  expect(existsSync(path.join(ws, ".fabula", "receipts", "latest.json"))).toBe(false)
})

test("a background writer's session mints no receipt, even with a real change", async () => {
  const ws = repo()
  const receipt = (await FabulaReceipt({ directory: ws } as any)) as any
  const sid = "s-writer"
  // The engine hands the driving agent to chat.message; a checkpoint-writer is housekeeping, not work.
  await receipt["chat.message"](
    { sessionID: sid, messageID: "m", model: "qwen-test-35b", agent: "checkpoint-writer" },
    { message: { id: "m", sessionID: sid, role: "user" }, parts: [{ type: "text", text: "<system-reminder> checkpoint-writer mode" }] },
  )
  // A REAL diff, so the empty-artifact rule alone cannot explain a refusal — only the agent can.
  writeFileSync(path.join(ws, "export.ts"), "export const ok = 3\n")
  await receipt["tool.execute.after"](
    { tool: "verify_done", sessionID: sid, args: {} },
    { output: GREEN, metadata: { passed: true, exitCode: 0, cmd: "bun test" } },
  )
  expect(existsSync(path.join(ws, ".fabula", "receipts", "latest.json"))).toBe(false)
})

test("the main agent with a real change still mints — the guard is not a blanket off switch", async () => {
  // The comprehension and reproduce gates have their own coverage above; switch them off so this case
  // isolates the rule under test. Without this the control passes for the WRONG reason — a refusal by a
  // different gate would look exactly like the new one working.
  const quiz = process.env.FABULA_CHANGE_QUIZ, repro2 = process.env.FABULA_REPRODUCE_GATE
  process.env.FABULA_CHANGE_QUIZ = "0"
  process.env.FABULA_REPRODUCE_GATE = "0"
  const ws = repo()
  const receipt = (await FabulaReceipt({ directory: ws } as any)) as any
  const sid = "s-main"
  await receipt["chat.message"](
    { sessionID: sid, messageID: "m", model: "qwen-test-35b", agent: "build" },
    { message: { id: "m", sessionID: sid, role: "user" }, parts: [{ type: "text", text: "Fix the export bug" }] },
  )
  writeFileSync(path.join(ws, "export.ts"), "export const ok = 4\n")
  writeFileSync(path.join(ws, "export.test.ts"), "test('x',()=>{})\n")
  await receipt["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { file_path: path.join(ws, "export.ts") } }, { output: "ok", metadata: {} })
  await receipt["tool.execute.after"]({ tool: "create_file", sessionID: sid, args: { file_path: path.join(ws, "export.test.ts") } }, { output: "ok", metadata: {} })
  await receipt["tool.execute.after"](
    { tool: "verify_done", sessionID: sid, args: {} },
    { output: GREEN, metadata: { passed: true, exitCode: 0, cmd: "bun test" } },
  )
  const minted = existsSync(path.join(ws, ".fabula", "receipts", "latest.json"))
  if (quiz === undefined) delete process.env.FABULA_CHANGE_QUIZ; else process.env.FABULA_CHANGE_QUIZ = quiz
  if (repro2 === undefined) delete process.env.FABULA_REPRODUCE_GATE; else process.env.FABULA_REPRODUCE_GATE = repro2
  expect(minted).toBe(true)
})
