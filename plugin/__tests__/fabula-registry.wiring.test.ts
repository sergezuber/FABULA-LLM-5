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

/** Mint a receipt carrying a reproduce-gate verdict, so the "absent" case has something to differ FROM.
 *  Without this pair the absence check could pass against a build that says nothing either way. */
function mintReceiptWithGate(verdict: { reason: string }) {
  mintReceipt()
  const p = path.join(repo, ".fabula", "receipts", "latest.json")
  const r = JSON.parse(readFileSync(p, "utf8"))
  r.gateProof = verdict
  writeFileSync(p, JSON.stringify(r))
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

// ── the reproduce-gate verdict on the VERIFY surface (C8) ─────────────────────────────────────────
//
// This property is guarded on the RENDER side and was guarded by nothing here: an independent verifier
// deleted the sentence below and 62 frozen plus ~1875 tracked cases stayed green. Same property, other
// surface — and the surface a reviewer actually reads when deciding whether to trust someone's proof.
//
// The absence case is the one that matters. Hook order in this harness is a glob scan, so a receipt can
// be minted before the gate has stamped anything; a verify output that simply says nothing then reads
// exactly like one where the probe ran and passed. Absence is not a pass, and it has to say so.

test("a receipt WITH a gate verdict carries that verdict into the verify output", async () => {
  mintReceiptWithGate({ reason: "validated — the test failed on base and passed on the patch" })
  const t = await tools()
  await t.publish_receipt.execute({}, {} as any)
  const fullId = JSON.parse(readFileSync(path.join(store, "proofs", "index.json"), "utf8"))[0].id
  const ver = String(await t.verify_receipt.execute({ source: fullId }, {} as any))
  expect(ver).toContain("validated")
  expect(ver).toContain("failed on base")
})

test("a receipt with NO gate verdict says so — absence must not read as a pass", async () => {
  mintReceipt() // no gateProof at all
  const t = await tools()
  await t.publish_receipt.execute({}, {} as any)
  const fullId = JSON.parse(readFileSync(path.join(store, "proofs", "index.json"), "utf8"))[0].id
  const ver = String(await t.verify_receipt.execute({ source: fullId }, {} as any))
  // The output must NAME the absence rather than pass over it in silence.
  expect(ver.toLowerCase()).toContain("no reproduce-probe verdict")
  expect(ver.toLowerCase()).toContain("absence is not a pass")
})

test("the two cases are DISTINGUISHABLE — the absent one is not just the present one minus a word", async () => {
  // Guards against a build that emits the same text either way: if both outputs were identical the two
  // assertions above could both pass on a single hardcoded sentence.
  mintReceiptWithGate({ reason: "validated — the test failed on base and passed on the patch" })
  const t1 = await tools()
  await t1.publish_receipt.execute({}, {} as any)
  const idxA = JSON.parse(readFileSync(path.join(store, "proofs", "index.json"), "utf8"))[0].id
  const withGate = String(await t1.verify_receipt.execute({ source: idxA }, {} as any))

  mintReceipt()
  const t2 = await tools()
  await t2.publish_receipt.execute({}, {} as any)
  const entries = JSON.parse(readFileSync(path.join(store, "proofs", "index.json"), "utf8"))
  const without = String(await t2.verify_receipt.execute({ source: entries[entries.length - 1].id }, {} as any))

  expect(withGate).not.toBe(without)
  expect(withGate.toLowerCase()).not.toContain("no reproduce-probe verdict")
})
