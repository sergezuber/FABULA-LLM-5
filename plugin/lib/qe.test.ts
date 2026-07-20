// Unit tests for the quality estimate that sits ahead of a doomed retry (lib/qe.ts).
//
// Driven against a REAL local HTTP endpoint rather than a stubbed client, because the properties that
// matter are about what happens when that endpoint misbehaves — slow, unreachable, or answering something
// nobody planned for — and a stub answers exactly as well as the test author imagined.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { qeVerdict, qeBlocksRetry, redVerifies } from "./qe"

const DIFF = "--- a/x.ts\n+++ b/x.ts\n@@\n-const a = 1\n+const a = 2\n"
const RED = [{ type: "verify", green: false }]

let server: ReturnType<typeof Bun.serve> | null = null
let saved: Record<string, string | undefined> = {}

function serveAnswer(answer: string, delayMs = 0) {
  server = Bun.serve({
    port: 0,
    async fetch() {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      return Response.json({ choices: [{ message: { content: answer } }] })
    },
  })
  process.env.FABULA_AUX_URL = `http://localhost:${server.port}/v1/chat/completions`
  process.env.FABULA_AUX_MODEL = "test-estimator"
}

beforeEach(() => {
  for (const k of ["FABULA_AUX_URL", "FABULA_AUX_MODEL", "FABULA_AUX_KEY", "LMSTUDIO_URL", "NVIDIA_API_KEY"]) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  // Keep the fallback chain hermetic: without this the estimator would fall through to a real LM Studio.
  process.env.LMSTUDIO_URL = "http://127.0.0.1:9/v1"
})
afterEach(() => {
  server?.stop(true)
  server = null
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
})

// ── nothing has failed yet → never actionable ─────────────────────────────────────────────────────
test("with no failed verification there is nothing to gate", async () => {
  // An estimator able to veto a FIRST attempt would be a way to never start work at all.
  const r = await qeVerdict(DIFF, [])
  expect(r.verdict).toBe("worth-retrying")
  expect(qeBlocksRetry(r)).toBe(false)
  expect(r.fromModel).toBe(false)
})

test("an empty diff is not estimated", async () => {
  const r = await qeVerdict("   ", RED)
  expect(r.verdict).toBe("worth-retrying")
  expect(r.fromModel).toBe(false)
})

test("red verifies are counted across the shapes the harness carries", () => {
  expect(redVerifies([{ green: false }, { green: true }])).toBe(1)
  expect(redVerifies({ events: [{ type: "verify_done", passed: false }] })).toBe(1)
  expect(redVerifies([{ type: "edit", green: false }])).toBe(0) // not a verify event
  expect(redVerifies(null)).toBe(0)
  expect(redVerifies("nonsense" as any)).toBe(0)
})

// ── fail-open in every direction ──────────────────────────────────────────────────────────────────
test("an unreachable estimator keeps the attempt local", async () => {
  process.env.FABULA_AUX_URL = "http://127.0.0.1:9/v1/chat/completions"
  process.env.FABULA_AUX_MODEL = "test-estimator"
  const r = await qeVerdict(DIFF, RED)
  expect(r.verdict).toBe("worth-retrying")
  expect(qeBlocksRetry(r)).toBe(false)
})

test("an estimator slower than its budget is abandoned, not waited on", async () => {
  serveAnswer("DOOMED", 400)
  const started = Date.now()
  const r = await qeVerdict(DIFF, RED, { timeoutMs: 60 })
  expect(Date.now() - started).toBeLessThan(2000)
  expect(r.verdict).toBe("worth-retrying")
  expect(r.reason).toContain("budget")
})

test("an unreadable answer is NOT a negative", async () => {
  // An estimator that cannot be understood has said nothing, and "said nothing" must not spend an
  // escalation. Unknown is its own verdict precisely so it cannot be mistaken for a veto.
  serveAnswer("¯\\_(ツ)_/¯")
  const r = await qeVerdict(DIFF, RED)
  expect(r.verdict).toBe("unknown")
  expect(qeBlocksRetry(r)).toBe(false)
})

// ── the one action it has ─────────────────────────────────────────────────────────────────────────
test("a doomed estimate gates the next local retry", async () => {
  serveAnswer("DOOMED")
  const r = await qeVerdict(DIFF, RED)
  expect(r.verdict).toBe("not-worth-retrying")
  expect(r.fromModel).toBe(true)
  expect(qeBlocksRetry(r)).toBe(true)
})

test("a worth estimate keeps the attempt local", async () => {
  serveAnswer("WORTH")
  const r = await qeVerdict(DIFF, RED)
  expect(r.verdict).toBe("worth-retrying")
  expect(qeBlocksRetry(r)).toBe(false)
})

test("only an explicit negative gates anything", () => {
  expect(qeBlocksRetry("not-worth-retrying")).toBe(true)
  expect(qeBlocksRetry("worth-retrying")).toBe(false)
  expect(qeBlocksRetry("unknown")).toBe(false)
  expect(qeBlocksRetry(null)).toBe(false)
  expect(qeBlocksRetry(undefined)).toBe(false)
})
