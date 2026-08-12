import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { mkdtempSync, writeFileSync, readFileSync } from "fs"
import { tmpdir as osTmpdir } from "os"
import { GlobalRoutes } from "../../src/server/routes/global"
import { Config } from "../../src/config"
import { Global } from "../../src/global"
import { AppRuntime } from "../../src/effect/app-runtime"

// The edit route decides WHERE to write from where the provider LIVES. A launch-config provider (the
// local LM Studio one, or any provider in the project's fabula.config.json) is patched in place
// there — unchanged. A provider absent from the launch file is a user-added CUSTOM provider that
// lives in the global config, and must be written THERE — the fix for "provider not in launch config"
// 404 that made editing a UI-created provider fail. This pins that decision so the wiring cannot rot.

const CANDIDATES = ["mimocode.jsonc", "mimocode.json", "config.json"].map((f) => path.join(Global.Path.config, f))
const snapshot = new Map<string, string | null>()
let cfgPath: string

async function post(body: unknown) {
  const res = await GlobalRoutes().request("/fabula/providers-config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return (await res.json()) as { ok?: boolean; scope?: string; error?: string }
}
const invalidate = () => AppRuntime.runPromise(Config.Service.use((c) => c.invalidate(true)))

beforeAll(async () => {
  await fs.mkdir(Global.Path.config, { recursive: true }).catch(() => {})
  for (const f of CANDIDATES) snapshot.set(f, await fs.readFile(f, "utf8").catch(() => null))
  for (const f of CANDIDATES) await fs.rm(f, { force: true }).catch(() => {})
  await invalidate()
})

afterEach(() => {
  delete process.env["MIMOCODE_CONFIG"]
})

afterAll(async () => {
  await AppRuntime.runPromise(Config.Service.use((c) => c.updateGlobalProvider("corp", null))).catch(() => {})
  for (const [f, text] of snapshot) {
    if (text === null) await fs.rm(f, { force: true }).catch(() => {})
    else await fs.writeFile(f, text)
  }
  await invalidate()
})

function launchConfig(providers: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(osTmpdir(), "providers-scope-"))
  cfgPath = path.join(dir, "fabula.config.json")
  writeFileSync(cfgPath, JSON.stringify({ provider: providers }))
  process.env["MIMOCODE_CONFIG"] = cfgPath
  return cfgPath
}

test("a provider present in the launch config is patched IN the launch config", async () => {
  const file = launchConfig({
    lmstudio: { npm: "@ai-sdk/openai-compatible", name: "LM Studio", options: { baseURL: "http://x/v1" }, models: { m: { name: "M" } } },
  })
  const out = await post({ providerID: "lmstudio", modelPatch: { id: "m", name: "M", limit: { context: 1000, output: 100 } } })
  expect(out.ok).toBe(true)
  expect(out.scope).toBe("launch")
  const written = JSON.parse(readFileSync(file, "utf8")) as { provider: { lmstudio: { models: { m: { limit?: unknown } } } } }
  expect(written.provider.lmstudio.models.m.limit).toEqual({ context: 1000, output: 100 })
})

test("a provider ABSENT from the launch config is written to the GLOBAL config — no 404", async () => {
  // Exactly the M2 case: the provider was created into the global file, so the launch file has no
  // record of it. The old route answered 404 "provider not in launch config"; now it upserts global.
  launchConfig({ lmstudio: { npm: "@ai-sdk/openai-compatible", name: "LM Studio", models: { m: { name: "M" } } } })
  const out = await post({
    providerID: "corp",
    name: "Corp",
    baseURL: "https://llm.example.com/v1",
    models: { a: { name: "A" } },
  })
  expect(out.ok).toBe(true)
  expect(out.scope).toBe("global")
  const global = await AppRuntime.runPromise(Config.Service.use((c) => c.getGlobal()))
  const corp = global.provider?.["corp"] as { name?: string; options?: { baseURL?: string } } | undefined
  expect(corp?.name).toBe("Corp")
  expect(corp?.options?.baseURL).toBe("https://llm.example.com/v1")
})

test("editing that global provider again removes a deleted model (replace, not merge)", async () => {
  launchConfig({})
  await post({ providerID: "corp", name: "Corp", baseURL: "https://llm.example.com/v1", models: { a: { name: "A" }, b: { name: "B" } } })
  const out = await post({ providerID: "corp", name: "Corp", baseURL: "https://llm.example.com/v1", models: { a: { name: "A" } } })
  expect(out.scope).toBe("global")
  const global = await AppRuntime.runPromise(Config.Service.use((c) => c.getGlobal()))
  const models = (global.provider?.["corp"] as { models?: Record<string, unknown> })?.models ?? {}
  expect(Object.keys(models).sort()).toEqual(["a"])
})
