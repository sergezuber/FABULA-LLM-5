// Wiring test for the REAL registry plugin — no mocks. Builds an actual git repo whose verification
// command only passes once a patch is applied, mints a receipt for it, publishes to a throwaway
// registry, then re-verifies by content id (VERIFIED) and proves a tampered patch reports NOT DONE.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { FabulaRegistry } from "../fabula-registry"

function git(dir: string, args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim()
}
// Raw (untrimmed) capture — a git patch must keep its trailing newline or `git apply` calls it corrupt.
function gitRaw(dir: string, args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })
}

let repo: string
let store: string
const saved: Record<string, string | undefined> = {}

// The registry plugin is defaultEnabled:false — enable it hermetically via a temp state file
// (FABULA_PLUGIN_STATE) so the test never touches the user's real plugin state.
beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "fab-reg-repo-"))
  store = mkdtempSync(path.join(tmpdir(), "fab-reg-store-"))
  git(repo, ["init", "-q"])
  git(repo, ["config", "user.email", "t@t"])
  git(repo, ["config", "user.name", "t"])
  writeFileSync(path.join(repo, "val.txt"), "0\n")
  git(repo, ["add", "-A"])
  git(repo, ["commit", "-q", "-m", "base"])
  for (const k of ["FABULA_REGISTRY_DIR", "FABULA_PLUGIN_STATE", "FABULA_DISABLE", "FABULA_REGISTRY_VERIFY_UNTRUSTED"]) saved[k] = process.env[k]
  process.env.FABULA_REGISTRY_DIR = store
  const stateFile = path.join(store, "state.json")
  writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["registry"] }))
  process.env.FABULA_PLUGIN_STATE = stateFile
  delete process.env.FABULA_DISABLE
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(repo, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
})

// Build a receipt: a real git patch that writes `patchValue`, verified by `grep -q <verifyValue>`.
// Default (1,1) → the patch satisfies the check → VERIFIED. (2,1) → applies but fails → NOT DONE.
function mintReceipt(patchValue = "1", verifyValue = "1") {
  const base = git(repo, ["rev-parse", "HEAD"])
  writeFileSync(path.join(repo, "val.txt"), `${patchValue}\n`)
  const patch = gitRaw(repo, ["diff"])
  git(repo, ["checkout", "--", "val.txt"]) // restore working tree
  const recDir = path.join(repo, ".fabula", "receipts")
  mkdirSync(recDir, { recursive: true })
  const patchRel = path.join(".fabula", "receipts", "receipt-1.patch")
  writeFileSync(path.join(repo, patchRel), patch)
  const receipt = {
    version: "fabula-receipt/v0",
    mintedAt: 1,
    model: { id: "qwen3.6-35b-a3b", host: "local" },
    task: '"flip the value"',
    base,
    gates: [{ id: "verify" }],
    artifact: { kind: "git-diff", patch: patchRel },
    verification: { cmd: `grep -q ${verifyValue} val.txt`, exitCode: 0, passed: true, outputTail: "" },
  }
  writeFileSync(path.join(recDir, "latest.json"), JSON.stringify(receipt))
}

async function tools() {
  const hooks = (await FabulaRegistry({ directory: repo } as any)) as any
  expect(hooks.tool).toBeDefined() // plugin is enabled (gate passed)
  return hooks.tool
}

test("publish → search → verify(id) = VERIFIED on the real replay", async () => {
  mintReceipt()
  const t = await tools()

  const pub = await t.publish_receipt.execute({}, {} as any)
  expect(String(pub)).toContain("published")
  const id = String(pub).match(/receipt ([0-9a-f]{16})/)?.[1]
  expect(id).toBeTruthy()

  const search = await t.search_receipts.execute({ query: "flip" }, {} as any)
  expect(String(search)).toContain("flip the value")
  expect(String(search)).toContain("qwen3.6-35b-a3b")

  // re-verify by the full content id read from the store index
  const idx = JSON.parse(readFileSync(path.join(store, "proofs", "index.json"), "utf8"))
  const fullId = idx[0].id
  const ver = await t.verify_receipt.execute({ source: fullId }, {} as any)
  expect(String(ver)).toContain("VERIFIED")
  expect(String(ver)).not.toContain("NOT DONE")
})

test("a patch that applies but fails the check → NOT DONE (the check is real, not trusted)", async () => {
  mintReceipt("2", "1") // patch writes 2, verification demands 1 → applies, then fails
  const t = await tools()
  await t.publish_receipt.execute({}, {} as any)
  const fullId = JSON.parse(readFileSync(path.join(store, "proofs", "index.json"), "utf8"))[0].id
  const ver = await t.verify_receipt.execute({ source: fullId }, {} as any)
  expect(String(ver)).toContain("NOT DONE")
  expect(String(ver)).not.toContain("✅ VERIFIED")
})

test("untrusted http source is refused without the opt-in flag", async () => {
  const t = await tools()
  delete process.env.FABULA_REGISTRY_VERIFY_UNTRUSTED
  const out = await t.verify_receipt.execute({ source: "https://example.com/receipt.json" }, {} as any)
  expect(String(out)).toContain("untrusted")
  expect(String(out)).toContain("FABULA_REGISTRY_VERIFY_UNTRUSTED")
})
