// Wiring test for the REAL coordinator plugin — no mocks. Writes genuine worker receipts to disk, joins
// them into the proof tree via the plugin, and asserts the composite verdict is honest (all-verified →
// VERIFIED; one NOT DONE → whole NOT DONE). The pure tree logic is lib/coordinator.test.ts.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { FabulaCoordinator } from "../fabula-coordinator"

let dir: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fab-coord-"))
  for (const k of ["FABULA_PLUGIN_STATE", "FABULA_DISABLE"]) saved[k] = process.env[k]
  const stateFile = path.join(dir, "state.json")
  writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["coordinator"] }))
  process.env.FABULA_PLUGIN_STATE = stateFile
  delete process.env.FABULA_DISABLE
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(dir, { recursive: true, force: true })
})

// Write a worker project dir with a receipt whose verification.passed = `passed`.
function worker(name: string, task: string, passed: boolean): string {
  const wd = path.join(dir, name)
  const recDir = path.join(wd, ".fabula", "receipts")
  mkdirSync(recDir, { recursive: true })
  const patchRel = path.join(".fabula", "receipts", "w.patch")
  writeFileSync(path.join(wd, patchRel), "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-0\n+1\n")
  writeFileSync(path.join(recDir, "latest.json"), JSON.stringify({
    version: "fabula-receipt/v0",
    model: { id: "qwen3.6-35b", host: "local" },
    task: `"${task}"`,
    base: "abc123",
    gates: [{ id: "verify" }],
    artifact: { kind: "git-diff", patch: patchRel },
    verification: { cmd: "bun test .", exitCode: passed ? 0 : 1, passed },
  }))
  return wd
}

async function tools() {
  const hooks = (await FabulaCoordinator({ directory: dir } as any)) as any
  expect(hooks.tool).toBeDefined()
  return hooks.tool
}

test("all workers VERIFIED → composite VERIFIED, tree persisted", async () => {
  worker("research", "map the export path", true)
  worker("implement", "fix the boundary", true)
  const t = await tools()

  const a = String(await t.subreceipt_add.execute({ role: "research", from: "research", overall_task: "ship export fix" }, {} as any))
  expect(a).toContain("VERIFIED")
  const b = String(await t.subreceipt_add.execute({ role: "implement", from: "implement" }, {} as any))
  expect(b).toContain("2/2 verified")
  expect(b).toContain("Composite: VERIFIED")

  const tree = JSON.parse(readFileSync(path.join(dir, ".fabula", "coordinator", "tree.json"), "utf8"))
  expect(tree.children).toHaveLength(2)

  const pt = String(await t.proof_tree.execute({}, {} as any))
  expect(pt).toContain("Composite verdict: VERIFIED")
  expect(pt).toContain("research")
  expect(pt).toContain("implement")
})

test("one worker NOT DONE → whole run NOT DONE (every step must be proven)", async () => {
  worker("impl", "fix it", true)
  worker("verify", "prove the edge case", false) // this worker's receipt failed
  const t = await tools()
  await t.subreceipt_add.execute({ role: "impl", from: "impl" }, {} as any)
  const out = String(await t.subreceipt_add.execute({ role: "verify", from: "verify" }, {} as any))
  expect(out).toContain("Composite: NOT DONE")
  const pt = String(await t.proof_tree.execute({}, {} as any))
  expect(pt).toContain("❌")
  expect(pt).toContain("Composite verdict: NOT DONE")
})

test("re-adding the same worker replaces its verdict (a re-run updates the tree)", async () => {
  worker("impl", "fix it", false)
  const t = await tools()
  await t.subreceipt_add.execute({ role: "impl", from: "impl" }, {} as any) // NOT DONE first
  // worker re-runs and now passes
  worker("impl", "fix it", true)
  const out = String(await t.subreceipt_add.execute({ role: "impl", from: "impl" }, {} as any))
  expect(out).toContain("1/1 verified")
  const tree = JSON.parse(readFileSync(path.join(dir, ".fabula", "coordinator", "tree.json"), "utf8"))
  expect(tree.children).toHaveLength(1) // replaced, not duplicated
})

test("empty tree + missing worker receipt → clear messages", async () => {
  const t = await tools()
  expect(String(await t.proof_tree.execute({}, {} as any))).toContain("no sub-receipts yet")
  expect(String(await t.subreceipt_add.execute({ role: "x", from: "nope" }, {} as any))).toContain("no receipt at")
})
