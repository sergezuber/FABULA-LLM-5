// Wiring test: invokes the REAL escalate plugin. The success path (a live cloud call) is covered by
// the pure lib/escalate.test.ts + a manual live run; here we prove the glue hermetically — the tool is
// registered, and with a LOCAL-ONLY config it reports "no cloud provider" instead of hitting the network.
import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { FabulaEscalate } from "../fabula-escalate"

async function toolWith(configJson: object) {
  const dir = mkdtempSync(path.join(tmpdir(), "fab-esc-"))
  const cfg = path.join(dir, "fabula.config.json")
  writeFileSync(cfg, JSON.stringify(configJson))
  const prev = process.env.MIMOCODE_CONFIG
  process.env.MIMOCODE_CONFIG = cfg
  const hooks = (await FabulaEscalate({ directory: dir } as any)) as any
  return { tool: hooks.tool.escalate_to_cloud, restore: () => { if (prev) process.env.MIMOCODE_CONFIG = prev; else delete process.env.MIMOCODE_CONFIG } }
}

test("plugin registers the escalate_to_cloud tool", async () => {
  const { tool, restore } = await toolWith({ provider: {} })
  expect(typeof tool.execute).toBe("function")
  restore()
})

test("local-only config → reports no cloud provider (no network call)", async () => {
  const { tool, restore } = await toolWith({
    provider: { lmstudio: { options: { baseURL: "http://localhost:1235/v1" }, models: { m: {} } } },
  })
  const out = await tool.execute({ task: "x" }, {} as any)
  expect(String(out)).toContain("no cloud provider")
  restore()
})

test("missing config → reports no config", async () => {
  const prev = process.env.MIMOCODE_CONFIG
  process.env.MIMOCODE_CONFIG = path.join(tmpdir(), "fab-esc-does-not-exist", "nope.json")
  const hooks = (await FabulaEscalate({ directory: tmpdir() } as any)) as any
  const out = await hooks.tool.escalate_to_cloud.execute({ task: "x" }, {} as any)
  expect(String(out)).toContain("no engine config")
  if (prev) process.env.MIMOCODE_CONFIG = prev; else delete process.env.MIMOCODE_CONFIG
})
