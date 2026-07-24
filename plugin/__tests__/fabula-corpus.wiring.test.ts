// Wiring test for the corpus map-reduce intercept. Drives the REAL fabula-corpus hook with the engine's
// session.userQuery.pre contract. The pipeline (fetch to the local model) never runs here because the
// test cwd has no corpus (fewer than MIN_CORPUS_FILES → fallback re-inject, and the mock client records
// that). Asserts the CENTRAL INVARIANTS:
//   1. MUTE on a non-corpus task (step 1) → no cancel;
//   2. MUTE on step > 1 → no cancel (intercept is first-step only);
//   3. INTERCEPT on a corpus-analysis task → cancel=true + reason, AND the detached worker is really
//      launched with the right script, corpus directory and session (asserted, not assumed);
//   4. RECURSION GUARD: a re-injected [fabula-corpus-report] prefix → no cancel (no infinite loop);
//   5. KILL-SWITCH FABULA_CORPUS=0 → inert ({}), no hooks.

import { test, expect, beforeAll } from "bun:test"
import { writeFileSync, mkdtempSync, chmodSync, existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

beforeAll(() => {
  const stateFile = join(tmpdir(), `corpus-state-${process.pid}.json`)
  writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["corpus"] }))
  process.env.FABULA_PLUGIN_STATE = stateFile
})

import { FabulaCorpus } from "../fabula-corpus"

// Mock SDK client: records every session.prompt call (the pipeline's re-inject / fallback).
function mockClient() {
  const calls: any[] = []
  return {
    calls,
    session: {
      prompt: async (opts: any) => { calls.push(opts); return { ok: true } },
    },
  }
}

// A tiny corpus in the cwd so the pipeline has something to discover; with no local model reachable
// under `bun test` the map step throws → fallback path. The wiring test cares about the INTERCEPT
// decision (cancel), not the model output.
async function hooks(client: any, directory: string) {
  return (await FabulaCorpus({ client, directory } as any)) as any
}

test("kill-switch: FABULA_CORPUS=0 → inert ({}), no hooks", async () => {
  process.env.FABULA_CORPUS = "0"
  const h = await hooks(mockClient(), "/tmp/nonexistent-corpus")
  expect(h["session.userQuery.pre"]).toBeUndefined()
  delete process.env.FABULA_CORPUS
})

test("MUTE on a non-corpus coding task (step 1) → no cancel", async () => {
  const h = await hooks(mockClient(), "/tmp/nope")
  const out: any = {}
  await h["session.userQuery.pre"]({ sessionID: "s1", step: 1, query: "fix the bug in adapter.ts" }, out)
  expect(out.cancel).toBeUndefined()
})

test("MUTE on an opinion/chat ask (step 1) → no cancel", async () => {
  const h = await hooks(mockClient(), "/tmp/nope")
  const out: any = {}
  await h["session.userQuery.pre"]({ sessionID: "s1", step: 1, query: "что думаешь о романе?" }, out)
  expect(out.cancel).toBeUndefined()
})

test("MUTE on step > 1 (intercept is first-step only)", async () => {
  const h = await hooks(mockClient(), "/tmp/nope")
  const out: any = {}
  await h["session.userQuery.pre"]({ sessionID: "s1", step: 3, query: "прочитай все главы и проанализируй" }, out)
  expect(out.cancel).toBeUndefined()
})

test("INTERCEPT on a corpus-analysis task (step 1) → cancel=true + reason", async () => {
  const h = await hooks(mockClient(), "/tmp/no-corpus-here")
  const out: any = {}
  await h["session.userQuery.pre"](
    { sessionID: "s1", step: 1, query: "Прочитай все главы книги и сделай глубокий литературный анализ" },
    out,
  )
  expect(out.cancel).toBe(true)
  expect(typeof out.cancelReason).toBe("string")
  expect(out.cancelReason.length).toBeGreaterThan(0)
})

// The intercept only matters if the WORK actually starts. Cancelling the turn without launching the
// pipeline is the worst outcome available — the user's task is dropped and nothing replaces it. Every
// other case here asserts a DECISION; this one asserts the mechanism, by standing a marker script in
// for `bun` (FABULA_BUN_BIN) so a spawn that happens is observable and one that never happens fails.
test("INTERCEPT actually LAUNCHES the worker (not just cancels the turn)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-spawn-"))
  const marker = join(dir, "argv.txt")
  const fakeBun = join(dir, "fake-bun.sh")
  writeFileSync(fakeBun, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\nexit 0\n`)
  chmodSync(fakeBun, 0o755)
  const prevBun = process.env.FABULA_BUN_BIN
  process.env.FABULA_BUN_BIN = fakeBun
  try {
    const out: any = {}
    await (await hooks(mockClient(), dir))["session.userQuery.pre"](
      { sessionID: "s_spawn", agentID: "build", step: 1, messageID: "m1", query: "Прочитай все главы книги и сделай глубокий литературный анализ" },
      out,
    )
    expect(out.cancel).toBe(true)
    for (let i = 0; i < 40 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(marker)).toBe(true) // the detached worker really ran
    const argv = readFileSync(marker, "utf8").trim().split("\n")
    expect(argv[0].endsWith("lib/corpus-worker.ts")).toBe(true) // the worker script, resolved next to the plugin
    expect(existsSync(argv[0])).toBe(true) // …and it exists on disk (a wrong path would spawn nothing)
    expect(argv[1]).toBe(dir) // the corpus directory it must scan
    expect(argv[2]).toBe("s_spawn") // the session the report has to be delivered to
  } finally {
    if (prevBun === undefined) delete process.env.FABULA_BUN_BIN
    else process.env.FABULA_BUN_BIN = prevBun
    rmSync(dir, { recursive: true, force: true })
  }
})

test("RECURSION GUARD: a re-injected report prefix → no cancel", async () => {
  const h = await hooks(mockClient(), "/tmp/nope")
  const out: any = {}
  await h["session.userQuery.pre"](
    { sessionID: "s1", step: 1, query: "[fabula-corpus-report]\n\nАнализ книги..." },
    out,
  )
  expect(out.cancel).toBeUndefined() // never re-intercept our own re-inject
})

test("never throws on malformed input (fail-silent)", async () => {
  const h = await hooks(mockClient(), "/tmp/nope")
  const out: any = {}
  await expect(h["session.userQuery.pre"](null, out)).resolves.toBeUndefined()
  await expect(h["session.userQuery.pre"]({ step: 1 }, out)).resolves.toBeUndefined()
  expect(out.cancel).toBeUndefined()
})
