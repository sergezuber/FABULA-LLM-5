// Wiring test for the REAL daemon plugin — no mocks. Exercises the tools + the system-prompt injection
// hermetically (the `sleep` pacing tool, the KAIROS posture gated on FABULA_DAEMON, and the PR-poll's
// clean failure when gh isn't reachable). The pure pacing/posture/PR-diff logic is lib/daemon.test.ts.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { FabulaDaemon } from "../fabula-daemon"

const saved: Record<string, string | undefined> = {}
let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "fab-daemon-"))
  for (const k of ["FABULA_PLUGIN_STATE", "FABULA_DISABLE", "FABULA_DAEMON", "FABULA_TERMINAL_FOCUS"]) saved[k] = process.env[k]
  const stateFile = path.join(stateDir, "state.json")
  writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["daemon"] }))
  process.env.FABULA_PLUGIN_STATE = stateFile
  delete process.env.FABULA_DISABLE
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(stateDir, { recursive: true, force: true })
})

async function daemon() {
  const hooks = (await FabulaDaemon({ directory: stateDir } as any)) as any
  expect(hooks.tool).toBeDefined() // gate passed
  return hooks
}

test("sleep tool returns cache-aware advice + a tick number", async () => {
  const h = await daemon()
  const out = String(await h.tool.sleep.execute({ duration_ms: 120000 }, {} as any))
  expect(out).toContain("120000ms")
  expect(out).toContain("warm prompt cache")
  expect(out).toMatch(/tick \d+/)
})

test("sleep over the cache window warns about the uncached wake", async () => {
  const h = await daemon()
  const out = String(await h.tool.sleep.execute({ duration_ms: 1800000 }, {} as any))
  expect(out).toContain("uncached")
})

test("system.transform injects KAIROS posture ONLY when FABULA_DAEMON=1", async () => {
  const h = await daemon()
  // off by default
  delete process.env.FABULA_DAEMON
  const off = { system: ["base"] as string[] }
  await h["experimental.chat.system.transform"]({}, off)
  expect(off.system).toHaveLength(1)

  // on with unfocused terminal
  process.env.FABULA_DAEMON = "1"
  process.env.FABULA_TERMINAL_FOCUS = "unfocused"
  const on = { system: ["base"] as string[] }
  await h["experimental.chat.system.transform"]({}, on)
  expect(on.system).toHaveLength(2)
  expect(on.system[1]).toContain("Autonomous work (FABULA daemon)")
  expect(on.system[1]).toContain("mints a replayable Proof-of-Done receipt")
  expect(on.system[1]).toContain("full autonomy")
})

test("focused terminal changes the posture", async () => {
  const h = await daemon()
  process.env.FABULA_DAEMON = "1"
  process.env.FABULA_TERMINAL_FOCUS = "focused"
  const out = { system: [] as string[] }
  await h["experimental.chat.system.transform"]({}, out)
  expect(out.system[0]).toContain("ASK before large")
})

test("check_pr_activity validates its args and fails cleanly without a reachable gh/PR", async () => {
  const h = await daemon()
  expect(String(await h.tool.check_pr_activity.execute({ repo: "bad", pr_number: 1 }, {} as any))).toContain("owner/repo")
  // a well-formed but non-resolvable request must yield a clear message, never throw
  const out = String(await h.tool.check_pr_activity.execute({ repo: "sergezuber/does-not-exist-xyz", pr_number: 999999 }, {} as any))
  expect(out).toContain("check_pr_activity:")
})
