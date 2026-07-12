// Wiring test for the REAL relay plugin — no mocks. The "cloud model" is a genuine local HTTP server
// returning an OpenAI-shaped response with a unified diff. We assert the patch is written, the model is
// steered to APPLY-and-VERIFY (never trusted), the attempts ledger grows, budget is enforced, and a
// NO-PATCH answer is handled. The pure ladder/budget/diff logic is lib/relay.test.ts.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { FabulaRelay } from "../fabula-relay"

const DIFF = `diff --git a/x.txt b/x.txt
--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-0
+1
`

let dir: string
let server: ReturnType<typeof Bun.serve> | null = null
let cannedContent = "```diff\n" + DIFF + "```"
const saved: Record<string, string | undefined> = {}

function startCloud(): string {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!req.url.includes("/chat/completions")) return new Response("no", { status: 404 })
      return Response.json({ choices: [{ message: { content: cannedContent } }] })
    },
  })
  return `http://127.0.0.1:${server.port}/v1`
}

beforeEach(() => {
  cannedContent = "```diff\n" + DIFF + "```" // reset canned cloud reply each test
  dir = mkdtempSync(path.join(tmpdir(), "fab-relay-"))
  for (const k of ["FABULA_PLUGIN_STATE", "FABULA_DISABLE", "MIMOCODE_CONFIG", "FABULA_RELAY_MAX_ATTEMPTS", "FABULA_RELAY_URL", "FABULA_RELAY_MODEL", "FABULA_RELAY_API_KEY", "FABULA_RELAY_PROVIDER", "FABULA_ESCALATE_MODEL"]) saved[k] = process.env[k]
  const stateFile = path.join(dir, "state.json")
  writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["relay"] }))
  process.env.FABULA_PLUGIN_STATE = stateFile
  delete process.env.FABULA_DISABLE
})
afterEach(() => {
  server?.stop(true)
  server = null
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(dir, { recursive: true, force: true })
})

// Point relay at the local fake via the explicit endpoint override (pickCloudProvider would reject a
// 127.0.0.1 baseURL as non-cloud — the override exists exactly for a chosen endpoint).
function useCloud(url: string) {
  process.env.FABULA_RELAY_URL = url
  process.env.FABULA_RELAY_MODEL = "big-model"
  process.env.FABULA_RELAY_API_KEY = "sk-test"
}

async function relayTool() {
  const hooks = (await FabulaRelay({ directory: dir } as any)) as any
  expect(hooks.tool).toBeDefined()
  return hooks.tool.relay_to_cloud
}

test("cloud returns a patch → written + steered to apply-and-verify, never trusted", async () => {
  useCloud(startCloud())
  const t = await relayTool()
  const out = String(await t.execute({ task: "flip x.txt", tried: "direct edit" }, {} as any))
  expect(out).toContain("CLOUD PATCH")
  expect(out).toContain("NOT done")
  expect(out).toContain("git apply")
  expect(out).toContain("verify_done")

  // patch on disk
  const patch = readFileSync(path.join(dir, ".fabula", "relay", "patch.diff"), "utf8")
  expect(patch).toContain("@@ -1 +1 @@")

  // attempts ledger recorded this rung
  const led = JSON.parse(readFileSync(path.join(dir, ".fabula", "relay", "attempts.json"), "utf8"))
  expect(led.attempts).toHaveLength(1)
  expect(led.attempts[0]).toMatchObject({ actor: "cloud", strategy: "direct-work", model: "big-model", result: "retrying" })
})

test("budget exhaustion stops the ladder with an honest unverified verdict", async () => {
  useCloud(startCloud())
  process.env.FABULA_RELAY_MAX_ATTEMPTS = "1"
  const t = await relayTool()
  await t.execute({ task: "flip x.txt" }, {} as any) // attempt 1 (within budget)
  const out = String(await t.execute({ task: "flip x.txt" }, {} as any)) // attempt 2 → over budget
  expect(out).toContain("attempt budget spent")
  expect(out).toContain("UNVERIFIED")
})

test("NO PATCH answer → not treated as a patch; steers to input", async () => {
  cannedContent = "NO PATCH: the task is ambiguous about which column to fix"
  useCloud(startCloud())
  const t = await relayTool()
  const out = String(await t.execute({ task: "fix it" }, {} as any))
  expect(out).toContain("did not return a patch")
  expect(out).toContain("ambiguous")
  expect(existsSync(path.join(dir, ".fabula", "relay", "patch.diff"))).toBe(false)
})

test("no cloud provider → clear message, no crash", async () => {
  const cfg = path.join(dir, "fabula.config.json")
  writeFileSync(cfg, JSON.stringify({ model: "lmstudio/qwen-local", provider: { lmstudio: { options: { baseURL: "http://localhost:1235/v1" }, models: { m: {} } } } }))
  process.env.MIMOCODE_CONFIG = cfg
  const t = await relayTool()
  const out = String(await t.execute({ task: "x" }, {} as any))
  expect(out).toContain("no cloud provider")
})
