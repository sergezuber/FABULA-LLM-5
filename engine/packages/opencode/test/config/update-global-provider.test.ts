import { afterEach, beforeAll, afterAll, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Config } from "../../src/config"
import { Global } from "../../src/global"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Effect } from "effect"

// A user-added custom provider lives in the GLOBAL config and its whole edit lifecycle needs REPLACE
// semantics — the split-brain that made editing a UI-created provider fail (create wrote the global
// file, every edit path looked only at the launch file) is fixed by writing edits to the global file
// too. This pins the primitive that does it: replace a provider wholesale (so a removed model is
// actually removed — mergeDeep and patchJsonc both keep it), delete a provider, and refuse an invalid
// one WITHOUT corrupting the file on disk.

const CANDIDATES = ["mimocode.jsonc", "mimocode.json", "config.json"].map((f) => path.join(Global.Path.config, f))
const PID = "zzz-test-custom-provider"

// Snapshot every global-config candidate and restore them verbatim afterwards — the real config dir
// must be byte-identical when this file is done (the repo has been burned by tests polluting the
// developer's real store).
const snapshot = new Map<string, string | null>()

async function apply(providerID: string, provider: unknown | null) {
  return AppRuntime.runPromise(Config.Service.use((c) => c.updateGlobalProvider(providerID, provider)))
}
async function invalidate() {
  return AppRuntime.runPromise(Config.Service.use((c) => c.invalidate(true)))
}
async function readGlobalFile() {
  for (const f of CANDIDATES) {
    const text = await fs.readFile(f, "utf8").catch(() => null)
    if (text !== null) return { file: f, text }
  }
  return null
}

beforeAll(async () => {
  await fs.mkdir(Global.Path.config, { recursive: true }).catch(() => {})
  for (const f of CANDIDATES) snapshot.set(f, await fs.readFile(f, "utf8").catch(() => null))
  // Start from a clean slate so `globalConfigFile()` resolves deterministically to mimocode.jsonc.
  for (const f of CANDIDATES) await fs.rm(f, { force: true }).catch(() => {})
  await invalidate()
})

afterEach(async () => {
  // Never leave the test provider behind between cases.
  await apply(PID, null).catch(() => {})
  await invalidate()
})

afterAll(async () => {
  for (const [f, text] of snapshot) {
    if (text === null) await fs.rm(f, { force: true }).catch(() => {})
    else await fs.writeFile(f, text)
  }
  await invalidate()
})

const provider = (models: Record<string, { name: string }>) => ({
  npm: "@ai-sdk/openai-compatible",
  name: "Corp",
  options: { baseURL: "https://llm.example.com/v1" },
  models,
})

test("a removed model is actually removed — replace, not merge", async () => {
  await apply(PID, provider({ a: { name: "A" }, b: { name: "B" } }))
  const after = await apply(PID, provider({ a: { name: "A" } }))
  const models = (after.provider?.[PID] as { models?: Record<string, unknown> })?.models ?? {}
  expect(Object.keys(models).sort()).toEqual(["a"]) // b is gone, not merged back
})

test("baseURL and name replace cleanly", async () => {
  await apply(PID, provider({ a: { name: "A" } }))
  const after = await apply(PID, {
    npm: "@ai-sdk/openai-compatible",
    name: "Corp v2",
    options: { baseURL: "https://new.example.com/v1" },
    models: { a: { name: "A" } },
  })
  const p = after.provider?.[PID] as { name?: string; options?: { baseURL?: string } }
  expect(p.name).toBe("Corp v2")
  expect(p.options?.baseURL).toBe("https://new.example.com/v1")
})

test("null deletes the provider", async () => {
  await apply(PID, provider({ a: { name: "A" } }))
  const after = await apply(PID, null)
  expect(after.provider?.[PID]).toBeUndefined()
})

test("an invalid provider is refused AND never reaches disk", async () => {
  await apply(PID, provider({ a: { name: "A" } }))
  const before = await readGlobalFile()
  // A number where the schema demands an object — must throw, and must leave the file untouched.
  await expect(apply(PID, 42 as unknown)).rejects.toBeDefined()
  const after = await readGlobalFile()
  expect(after?.text).toBe(before?.text ?? "")
})

test("it is JSONC-comment-safe — an existing comment survives the write", async () => {
  const file = path.join(Global.Path.config, "mimocode.jsonc")
  await fs.writeFile(file, '{\n  // keep me\n  "share": "disabled"\n}\n')
  await invalidate()
  await apply(PID, provider({ a: { name: "A" } }))
  const text = await fs.readFile(file, "utf8")
  expect(text).toContain("// keep me")
  expect(text).toContain(PID)
})
