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
import { writeFileSync, mkdtempSync, mkdirSync, chmodSync, existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

beforeAll(() => {
  // Isolate the corpus data dir. The intercept and its worker both keep state under
  // <XDG_DATA_HOME>/fabula/corpus — the accumulator, the heartbeat, and the hand-back marker that stops
  // a fallback re-inject from being intercepted forever. Left unpinned, these tests write those files
  // into the developer's REAL store and then read them back on the NEXT run: a hand-back marker from an
  // earlier run made the intercept case fail against a tree that was perfectly correct.
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), `corpus-data-${process.pid}-`))
  const stateFile = join(tmpdir(), `corpus-state-${process.pid}.json`)
  writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["corpus"] }))
  process.env.FABULA_PLUGIN_STATE = stateFile
})

import { FabulaCorpus } from "../fabula-corpus"
import { accumulatorKey } from "../lib/corpus"

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

// THE WORDLESS TRIGGER. The ask here is deliberately one nobody would write a pattern for — it names no
// book, no chapters, no "in full", and it is not even a request to read anything. What fires the worker is
// the SHAPE of the turn: file after file out of one directory, past the measured window, with more left.
// A pattern-matching trigger cannot pass this test, which is the point of it.
test("TRAVERSAL: reading a corpus fires the worker with no word ever matched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-walk-"))
  const marker = join(dir, "argv.txt")
  const fakeBun = join(dir, "fake-bun.sh")
  writeFileSync(fakeBun, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\nexit 0\n`)
  chmodSync(fakeBun, 0o755)
  // The chapters live in a SUBFOLDER and the agent reads them there, exactly as it did live. The verdict
  // must name the working directory it was given, not the folder it happened to walk into — which also
  // means the file count has to see below the top level or the root looks smaller than its own child.
  mkdirSync(join(dir, "chapters"), { recursive: true })
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, "chapters", `ch${i}.md`), "x")
  const prevBun = process.env.FABULA_BUN_BIN
  const prevWin = process.env.FABULA_CONTEXT_WINDOW
  process.env.FABULA_BUN_BIN = fakeBun
  process.env.FABULA_CONTEXT_WINDOW = "8000"
  try {
    const h = await hooks(mockClient(), dir)
    const out: any = {}
    await h["session.userQuery.pre"]({ sessionID: "s_walk", step: 1, messageID: "m1", query: "ну и?" }, out)
    expect(out.cancel).toBeFalsy() // no pattern matched — the turn runs normally, as it should
    const body = "z".repeat(40_000)
    for (let i = 0; i < 6; i++) {
      await h["tool.execute.after"](
        { sessionID: "s_walk", tool: "view" },
        { args: { file_path: join(dir, "chapters", `ch${i}.md`) }, output: body },
      )
    }
    for (let i = 0; i < 40 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(marker)).toBe(true) // the traversal itself launched the worker
    const argv = readFileSync(marker, "utf8").trim().split("\n")
    expect(argv[1]).toBe(dir) // the working directory, not dir/chapters
    expect(argv[2]).toBe("s_walk")
  } finally {
    if (prevBun === undefined) delete process.env.FABULA_BUN_BIN
    else process.env.FABULA_BUN_BIN = prevBun
    if (prevWin === undefined) delete process.env.FABULA_CONTEXT_WINDOW
    else process.env.FABULA_CONTEXT_WINDOW = prevWin
    rmSync(dir, { recursive: true, force: true })
  }
})

// The control: an ordinary turn touching a couple of files must never be taken over.
test("TRAVERSAL stays out of an ordinary turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-quiet-"))
  const marker = join(dir, "argv.txt")
  const fakeBun = join(dir, "fake-bun.sh")
  writeFileSync(fakeBun, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\nexit 0\n`)
  chmodSync(fakeBun, 0o755)
  for (let i = 0; i < 20; i++) writeFileSync(join(dir, `ch${i}.md`), "x")
  const prevBun = process.env.FABULA_BUN_BIN
  process.env.FABULA_BUN_BIN = fakeBun
  try {
    const h = await hooks(mockClient(), dir)
    await h["session.userQuery.pre"]({ sessionID: "s_quiet", step: 1, messageID: "m1", query: "почини баг" }, {})
    for (let i = 0; i < 2; i++) {
      await h["tool.execute.after"](
        { sessionID: "s_quiet", tool: "view" },
        { args: { file_path: join(dir, `ch${i}.md`) }, output: "z".repeat(40_000) },
      )
    }
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(marker)).toBe(false)
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

// When the pipeline cannot own a task it hands the ORIGINAL text back so the model answers normally —
// and that text still matches the detector. Without honouring the hand-back marker the next turn
// intercepts it again, hands it back again, and never terminates: an infinite loop built out of the very
// mechanism that exists to prevent one.
test("HAND-BACK GUARD: a task already handed back to the model is not intercepted again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-handback-"))
  const store = join(process.env.XDG_DATA_HOME!, "fabula", "corpus")
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, `${accumulatorKey("s_hb", dir)}.handback.json`), JSON.stringify({ ts: 1 }))
  const out: any = {}
  await (await hooks(mockClient(), dir))["session.userQuery.pre"](
    { sessionID: "s_hb", step: 1, query: "Прочитай все главы книги и сделай глубокий литературный анализ" },
    out,
  )
  expect(out.cancel).toBeUndefined() // the model gets its turn; the cycle ends after one attempt
  rmSync(dir, { recursive: true, force: true })
})

test("never throws on malformed input (fail-silent)", async () => {
  const h = await hooks(mockClient(), "/tmp/nope")
  const out: any = {}
  await expect(h["session.userQuery.pre"](null, out)).resolves.toBeUndefined()
  await expect(h["session.userQuery.pre"]({ step: 1 }, out)).resolves.toBeUndefined()
  expect(out.cancel).toBeUndefined()
})
