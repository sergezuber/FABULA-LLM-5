// Wiring test for the REAL buddy plugin — no mocks. Writes genuine Proof-of-Done receipts (+ the witness
// side-car) to disk, hatches + feeds through the plugin's own tools, and drives the auto-feed hook with a
// real green-verify event. Asserts the FABULA invariant: growth comes ONLY from PASSED receipts, and the
// legendary upgrade needs three receipts each attested by ≥3 witnesses. Pure logic is lib/buddy.test.ts.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { FabulaBuddy } from "../fabula-buddy"

let dir: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fab-buddy-"))
  for (const k of ["FABULA_PLUGIN_STATE", "FABULA_DISABLE", "FABULA_BUDDY_USER", "FABULA_BUDDY_AUTO"]) saved[k] = process.env[k]
  const stateFile = path.join(dir, "pstate.json")
  writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["buddy"] }))
  process.env.FABULA_PLUGIN_STATE = stateFile
  delete process.env.FABULA_DISABLE
  delete process.env.FABULA_BUDDY_AUTO
  process.env.FABULA_BUDDY_USER = "test-user-fixed" // deterministic bones
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(dir, { recursive: true, force: true })
})

// Write .fabula/receipts/latest.json (+ its patch) with the given pass/gates/task/patch bytes.
function writeReceipt(passed: boolean, opts: { gates?: string[]; task?: string; patch?: string } = {}) {
  const recDir = path.join(dir, ".fabula", "receipts")
  mkdirSync(recDir, { recursive: true })
  const patch = opts.patch ?? "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-0\n+1\n"
  writeFileSync(path.join(recDir, "latest.json.patch"), patch)
  writeFileSync(path.join(recDir, "latest.json"), JSON.stringify({
    version: "fabula-receipt/v0",
    model: { id: "qwen3.6-35b", host: "local" },
    task: `"${opts.task ?? "fix the thing"}"`,
    base: "abc123",
    gates: (opts.gates ?? ["verify"]).map((id) => ({ id })),
    artifact: { kind: "git-diff", patch: path.join(".fabula", "receipts", "latest.json.patch") },
    verification: { cmd: "bun test .", exitCode: passed ? 0 : 1, passed },
  }))
}

// Write the witness side-car with N confirmed (+ optional disputed) attestations.
function writeWitnesses(confirmed: number, disputed = 0) {
  const recDir = path.join(dir, ".fabula", "receipts")
  mkdirSync(recDir, { recursive: true })
  const witnesses = [
    ...Array.from({ length: confirmed }, (_, i) => ({ providerId: `p${i}`, model: `m${i}`, verdict: "confirmed", at: i })),
    ...Array.from({ length: disputed }, (_, i) => ({ providerId: `d${i}`, model: `dm${i}`, verdict: "disputed", at: 100 + i })),
  ]
  writeFileSync(path.join(recDir, "witnesses.json"), JSON.stringify({ diffSha: "deadbeef", task: "t", updatedAt: 1, witnesses }))
}

async function plugin() {
  const hooks = (await FabulaBuddy({ directory: dir } as any)) as any
  expect(hooks.tool).toBeDefined()
  return hooks
}
const readState = () => JSON.parse(readFileSync(path.join(dir, ".fabula", "buddy", "state.json"), "utf8"))

test("hatch → status card shows the named companion", async () => {
  const h = await plugin()
  expect(String(await h.tool.buddy.execute({}, {} as any))).toContain("no companion yet")
  const out = String(await h.tool.buddy_hatch.execute({ name: "Sir Quacks", personality: "grumpy debugger" }, {} as any))
  expect(out).toContain("Hatched")
  expect(out).toContain("Sir Quacks")
  expect(out).toContain("grumpy debugger")
  expect(out).toContain("Lv.1")
  // buddy now shows it
  expect(String(await h.tool.buddy.execute({}, {} as any))).toContain("Sir Quacks")
})

test("feeding a PASSED receipt grants XP + a gate stat bump; re-feeding does nothing", async () => {
  const h = await plugin()
  await h.tool.buddy_hatch.execute({ name: "Pixel", personality: "chill" }, {} as any)
  writeReceipt(true, { gates: ["verify", "reproduce-gate"] }) // 10 + 5 = 15 XP, DEBUGGING+1
  const fed = String(await h.tool.buddy_feed.execute({}, {} as any))
  expect(fed).toContain("+15 XP")
  expect(fed).toContain("DEBUGGING+1")
  expect(readState().xp).toBe(15)
  // same receipt again → no double-dip
  const again = String(await h.tool.buddy_feed.execute({}, {} as any))
  expect(again).toContain("Already fed")
  expect(readState().xp).toBe(15)
})

test("witnesses multiply XP (confirmed only — disputed don't count)", async () => {
  const h = await plugin()
  await h.tool.buddy_hatch.execute({ name: "Ori", personality: "eager" }, {} as any)
  writeReceipt(true, { gates: ["verify"] })
  writeWitnesses(3, 2) // 3 confirmed, 2 disputed → +30 XP, base 10 → 40
  const fed = String(await h.tool.buddy_feed.execute({}, {} as any))
  expect(fed).toContain("+40 XP")
})

test("a NOT DONE receipt grants NOTHING — growth from proven work only", async () => {
  const h = await plugin()
  await h.tool.buddy_hatch.execute({ name: "Doubt", personality: "skeptical" }, {} as any)
  writeReceipt(false, { gates: ["verify"] })
  const fed = String(await h.tool.buddy_feed.execute({}, {} as any))
  expect(fed).toContain("NOT DONE")
  expect(readState().xp).toBe(0)
})

test("legendary earned from THREE distinct receipts each with ≥3 witnesses", async () => {
  const h = await plugin()
  await h.tool.buddy_hatch.execute({ name: "Myth", personality: "quiet" }, {} as any)
  writeWitnesses(3)
  let last = ""
  for (let i = 0; i < 3; i++) {
    writeReceipt(true, { gates: ["verify"], patch: `diff --git a/f${i} b/f${i}\n--- a/f${i}\n+++ b/f${i}\n@@ -1 +1 @@\n-0\n+${i}\n` })
    last = String(await h.tool.buddy_feed.execute({}, {} as any))
  }
  expect(last).toContain("LEGENDARY")
  const st = readState()
  expect(st.legendaryEarned).toBe(true)
  expect(st.legendaryReceipts.length).toBe(3)
  expect(String(await h.tool.buddy.execute({}, {} as any))).toContain("legendary")
})

test("auto-feed hook: a green verify_done grows the buddy from the latest receipt", async () => {
  const h = await plugin()
  await h.tool.buddy_hatch.execute({ name: "Auto", personality: "diligent" }, {} as any)
  writeReceipt(true, { gates: ["verify"] })
  const after = h["tool.execute.after"]
  expect(typeof after).toBe("function")
  const output: any = { metadata: { passed: true }, output: "verify green" }
  await after({ tool: "verify_done" }, output)
  expect(readState().xp).toBe(10)
  // a RED verify does not feed
  writeReceipt(true, { gates: ["verify"], patch: "diff --git a/z b/z\n--- a/z\n+++ b/z\n@@ -1 +1 @@\n-0\n+9\n" })
  await after({ tool: "verify_done" }, { metadata: { passed: false }, output: "red" })
  expect(readState().xp).toBe(10) // unchanged
})

test("auto-feed respects FABULA_BUDDY_AUTO=0 kill-switch", async () => {
  process.env.FABULA_BUDDY_AUTO = "0"
  const h = await plugin()
  await h.tool.buddy_hatch.execute({ name: "Mute", personality: "still" }, {} as any)
  writeReceipt(true, { gates: ["verify"] })
  await h["tool.execute.after"]({ tool: "verify_done" }, { metadata: { passed: true }, output: "green" })
  expect(existsSync(path.join(dir, ".fabula", "buddy", "state.json"))).toBe(true)
  expect(readState().xp).toBe(0) // auto-feed disabled
})
