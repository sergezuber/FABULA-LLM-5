// Wiring test for the REAL witness plugin. The "witness model" is a genuine local HTTP server that
// returns an OpenAI-shaped review (a real network round-trip, not a mock). We drive CONFIRMED and
// DISPUTED end-to-end through the plugin and assert the companion .fabula/receipts/witnesses.json.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { FabulaWitness } from "../fabula-witness"
import * as witnessModule from "../fabula-witness"

function git(dir: string, args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()
}

let repo: string
let server: ReturnType<typeof Bun.serve> | null = null
const saved: Record<string, string | undefined> = {}

// The canned review the fake witness returns; each test sets it before calling.
let cannedReview = "VERDICT: CONFIRMED\nThe boundary is inclusive; the added test covers it."

function startWitnessServer(): string {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!req.url.includes("/chat/completions")) return new Response("no", { status: 404 })
      return Response.json({ choices: [{ message: { content: cannedReview } }] })
    },
  })
  return `http://127.0.0.1:${server.port}/v1`
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "fab-wit-"))
  git(repo, ["init", "-q"])
  git(repo, ["config", "user.email", "t@t"])
  git(repo, ["config", "user.name", "t"])
  writeFileSync(path.join(repo, "f.txt"), "0\n")
  git(repo, ["add", "-A"])
  git(repo, ["commit", "-q", "-m", "base"])
  writeFileSync(path.join(repo, "f.txt"), "1\n") // an uncommitted change to witness
  for (const k of ["FABULA_WITNESS_MODEL", "FABULA_WITNESS_URL", "FABULA_WITNESS_API_KEY", "FABULA_PLUGIN_STATE", "FABULA_DISABLE", "MIMOCODE_CONFIG"]) saved[k] = process.env[k]
  const stateFile = path.join(repo, "state.json")
  writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["witness"] }))
  process.env.FABULA_PLUGIN_STATE = stateFile
  delete process.env.FABULA_DISABLE
})
afterEach(() => {
  server?.stop(true)
  server = null
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(repo, { recursive: true, force: true })
})

async function witnessTool() {
  const hooks = (await FabulaWitness({ directory: repo } as any)) as any
  expect(hooks.tool).toBeDefined() // gate passed → plugin enabled
  return hooks.tool.witness_diff
}

// Regression for the load crash (commit efb5cba): the engine loader invokes EVERY export of a plugin
// file as a plugin — getLegacyPlugins() iterates Object.values(mod) and applyPlugin() calls each with
// (input, options). A stray `export { attested }` was therefore called as attested(pluginInput) →
// `entries.some is not a function` → "failed to load plugin". The other tests here only call the named
// FabulaWitness export, so they never hit this path. This one replicates the loader exactly.
test("loader contract: EVERY export loads as a plugin without throwing (no stray helper export)", async () => {
  const input = { directory: repo } as any
  const options = {} as any
  // 1) the module must export EXACTLY ONE runtime value, and it must be the Fabula* factory.
  const fnExports = Object.entries(witnessModule).filter(([, v]) => typeof v === "function")
  expect(fnExports.map(([k]) => k)).toEqual(["FabulaWitness"])
  // 2) invoke every function export the way the engine loader does — none may throw, each must
  //    return a hooks-like object (this is the exact call getLegacyPlugins→applyPlugin makes).
  for (const [name, fn] of fnExports) {
    let result: any
    await expect(
      (async () => {
        result = await (fn as any)(input, options)
      })(),
      `export ${name} must load as a valid plugin (invoked as the engine loader does)`,
    ).resolves.toBeUndefined()
    expect(result, `export ${name} must return a hooks/tool object`).toBeInstanceOf(Object)
  }
})

test("CONFIRMED review → records a confirming witness next to the receipt", async () => {
  cannedReview = "VERDICT: CONFIRMED\nThe change is correct and safe."
  process.env.FABULA_WITNESS_MODEL = "reviewer-x"
  process.env.FABULA_WITNESS_URL = startWitnessServer()
  const t = await witnessTool()
  const out = String(await t.execute({ task: "flip f.txt to 1" }, {} as any))
  expect(out).toContain("WITNESS CONFIRMED")
  expect(out).toContain("reviewer-x")

  const rec = JSON.parse(readFileSync(path.join(repo, ".fabula", "receipts", "witnesses.json"), "utf8"))
  expect(rec.witnesses).toHaveLength(1)
  expect(rec.witnesses[0]).toMatchObject({ model: "reviewer-x", verdict: "confirmed", method: "diff-review" })
})

test("DISPUTED review → tells the model not to claim done", async () => {
  cannedReview = "VERDICT: DISPUTED\nThis breaks the header row; off-by-one."
  process.env.FABULA_WITNESS_MODEL = "reviewer-x"
  process.env.FABULA_WITNESS_URL = startWitnessServer()
  const t = await witnessTool()
  const out = String(await t.execute({}, {} as any))
  expect(out).toContain("WITNESS DISPUTED")
  expect(out).toContain("off-by-one")
  const rec = JSON.parse(readFileSync(path.join(repo, ".fabula", "receipts", "witnesses.json"), "utf8"))
  expect(rec.witnesses[0].verdict).toBe("disputed")
})

test("no witness configured (local-only) → clear message, no network", async () => {
  const cfg = path.join(repo, "fabula.config.json")
  writeFileSync(cfg, JSON.stringify({ model: "lmstudio/qwen-local", provider: { lmstudio: { options: { baseURL: "http://localhost:1235/v1" }, models: { "qwen-local": {} } } } }))
  process.env.MIMOCODE_CONFIG = cfg
  delete process.env.FABULA_WITNESS_MODEL
  delete process.env.FABULA_WITNESS_URL
  const t = await witnessTool()
  const out = String(await t.execute({}, {} as any))
  expect(out).toContain("no witness model configured")
})

test("no diff → nothing to witness", async () => {
  git(repo, ["checkout", "--", "f.txt"]) // discard the uncommitted change
  process.env.FABULA_WITNESS_MODEL = "reviewer-x"
  process.env.FABULA_WITNESS_URL = startWitnessServer()
  const t = await witnessTool()
  const out = String(await t.execute({}, {} as any))
  expect(out).toContain("no uncommitted change")
  expect(existsSync(path.join(repo, ".fabula", "receipts", "witnesses.json"))).toBe(false)
})
