// Live execute_code tests: real python3/node child processes + real Docker sandbox.
import { test, expect, beforeAll } from "bun:test"
import { execFileSync } from "node:child_process"
import { FabulaTools } from "../fabula-tools"

let T: any
const ctx = { sessionID: "s", directory: "/tmp", abort: new AbortController().signal } as any
const out = (r: any) => (typeof r === "string" ? r : r.output)
beforeAll(async () => { T = (await FabulaTools({} as any)).tool })

const dockerUp = (() => {
  try { execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: ["ignore", "pipe", "ignore"] }); return true } catch { return false }
})()

test("execute_code runs python", async () => {
  const r = await T.execute_code.execute({ language: "python", code: "print(6*7)" }, ctx)
  expect(out(r)).toContain("42")
}, 90000)
test("execute_code runs node", async () => {
  const r = await T.execute_code.execute({ language: "node", code: "console.log(40+2)" }, ctx)
  expect(out(r)).toContain("42")
}, 90000)
test("execute_code refuses catastrophic code (no execution)", async () => {
  const r = await T.execute_code.execute({ language: "python", code: "import os; os.system('rm -rf /')" }, ctx)
  expect(out(r)).toContain("[BLOCKED")
})
test("execute_code env-scrub: local child cannot read a secret env var", async () => {
  process.env.FAKE_API_KEY = "super-secret-leak"
  const r = await T.execute_code.execute({ language: "python", code: "import os; print(os.environ.get('FAKE_API_KEY','NONE'))", sandbox: false }, ctx)
  expect(out(r).trim().split("\n")[0]).toBe("NONE")   // scrubbed → local child sees nothing
  expect(out(r)).not.toContain("super-secret-leak")
  delete process.env.FAKE_API_KEY
}, 30000)
test("execute_code redacts a secret printed by the code", async () => {
  const r = await T.execute_code.execute({ language: "python", code: "print('key sk-ant-abcdef0123456789ABCDEF01 end')", sandbox: false }, ctx)
  expect(out(r)).toContain("[REDACTED:SK_ANT_KEY]")
  expect(out(r)).not.toContain("sk-ant-abcdef0123456789ABCDEF01")
}, 30000)

// ── LIVE Docker sandbox ──
test.if(dockerUp)("execute_code runs IN Docker sandbox by default", async () => {
  const r = await T.execute_code.execute({ language: "python", code: "print(2+2)" }, ctx)
  expect(out(r)).toContain("4")
  expect(out(r)).toContain("sandboxed")
  expect((r as any).metadata?.sandboxed).toBe(true)
}, 120000)
test.if(dockerUp)("Docker sandbox has NO network (exfil blocked)", async () => {
  const r = await T.execute_code.execute({ language: "python",
    code: "import urllib.request as u\ntry:\n u.urlopen('http://example.com', timeout=8); print('NET_OK')\nexcept Exception as e:\n print('NET_BLOCKED')" }, ctx)
  expect(out(r)).toContain("NET_BLOCKED")
  expect(out(r)).not.toContain("NET_OK")
}, 120000)
