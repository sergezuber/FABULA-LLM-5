// The engine's arithmetic must rest on a measured number, not a typed one.
//
// MEASURED 2026-07-28. Everything the engine decides about size — when to prune, when to compact, how
// much it may send — is computed by overflow.ts `usable()` from `model.limit.context`, and that comes
// from a config file somebody typed. It said one thing while the runtime held another, so the engine
// reasoned confidently about a machine that did not exist: requests of 188 841 and 271 525 units went to
// a model holding 65 536 and the serving process died allocating cache for them.
//
// The model object reaches the hook BY REFERENCE, so correcting it there corrects every later decision.

import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

beforeAll(() => {
  const f = join(tmpdir(), `win-state-${process.pid}.json`)
  writeFileSync(f, JSON.stringify({ disabled: [], enabled: ["window"] }))
  process.env.FABULA_PLUGIN_STATE = f
})

import { FabulaWindow } from "../fabula-window"
import { setLearnedWindow, clearLearnedWindow } from "../lib/ctxguard"

let served: any
function serve(loaded: number) {
  served?.stop(true)
  served = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        JSON.stringify({ data: [{ id: "m", type: "llm", state: "loaded", loaded_context_length: loaded, max_context_length: loaded }] }),
        { headers: { "content-type": "application/json" } },
      ),
  })
  process.env.FABULA_MODEL_API = `http://127.0.0.1:${served.port}/api/v0/models`
}

beforeEach(() => {
  clearLearnedWindow() // forget any cached probe so each case measures afresh
  process.env.FABULA_AUTO_WINDOW = "0" // no loading in a test; only the limit correction is under test
})
afterAll(() => served?.stop(true))

async function hook() {
  return (await (FabulaWindow as any)())["chat.params"]
}

test("a config limit larger than the loaded window is brought DOWN to what is real", async () => {
  clearLearnedWindow()
  serve(65536)
  const model: any = { id: "m", providerID: "lmstudio", limit: { context: 262144, output: 8000 } }
  await (await hook())({ model, provider: { id: "lmstudio" } })
  expect(model.limit.context).toBe(65536)
})

test("a config limit smaller than the loaded window is brought UP — the engine may use what exists", async () => {
  // The measurement is injected rather than served, because a measured window is CACHED for a minute and
  // a stub started after that cache is filled is never consulted — which is the contract, not a defect.
  // The model is REGISTERED with the hook before the measurement is injected. A measured window belongs
  // to a model, so meeting a different one invalidates it — which is the point of the invalidation and
  // makes "a cached figure is reused" a claim about the SAME model, never about any model that follows.
  const model: any = { id: "m2", providerID: "lmstudio", limit: { context: 131072, output: 8000 } }
  await (await hook())({ model: { ...model, limit: { ...model.limit } }, provider: { id: "lmstudio" } })
  setLearnedWindow(262144)
  await (await hook())({ model, provider: { id: "lmstudio" } })
  expect(model.limit.context).toBe(262144)
})

test("the output half is never touched — the engine refuses to start without it", async () => {
  serve(65536)
  const model: any = { id: "m3", providerID: "lmstudio", limit: { context: 262144, output: 8000 } }
  await (await hook())({ model, provider: { id: "lmstudio" } })
  expect(model.limit.output).toBe(8000)
})

test("nothing measured and nothing cached → the config figure is left exactly as it was", async () => {
  clearLearnedWindow()
  process.env.FABULA_MODEL_API = "http://127.0.0.1:1/nope"
  const model: any = { id: "m4", providerID: "lmstudio", limit: { context: 131072, output: 8000 } }
  await (await hook())({ model, provider: { id: "lmstudio" } })
  expect(model.limit.context).toBe(131072)
})

test("a cached measurement is reused when the runtime cannot be reached — a stale figure beats none", async () => {
  // The model is REGISTERED with the hook before the measurement is injected. A measured window belongs
  // to a model, so meeting a different one invalidates it — which is the point of the invalidation and
  // makes "a cached figure is reused" a claim about the SAME model, never about any model that follows.
  process.env.FABULA_MODEL_API = "http://127.0.0.1:1/nope"
  const model: any = { id: "m6", providerID: "lmstudio", limit: { context: 262144, output: 8000 } }
  await (await hook())({ model: { ...model, limit: { ...model.limit } }, provider: { id: "lmstudio" } })
  setLearnedWindow(65536)
  await (await hook())({ model, provider: { id: "lmstudio" } })
  expect(model.limit.context).toBe(65536)
})

test("a cloud model is left alone — it has no loaded window to measure", async () => {
  serve(65536)
  const model: any = { id: "gpt", providerID: "openai", limit: { context: 128000, output: 8000 } }
  await (await hook())({ model, provider: { id: "openai" } })
  expect(model.limit.context).toBe(128000)
})

test("a model with no limit object never throws", async () => {
  serve(65536)
  const model: any = { id: "m5", providerID: "lmstudio" }
  await expect((await hook())({ model, provider: { id: "lmstudio" } })).resolves.toBeUndefined()
})

// The correction must reach the CONFIG FILE at the correction itself — not only after a successful
// load. Measured 2026-07-28: the sync lived behind `r.window > 0`, the loader answered "no action"
// (model already resident), and the file kept its typed 65536 while the runtime served 135168 — so
// prune read 69% out of a 45k-token first step and auto-compaction churned an 84-second turn to death.
test("the measured window is written into the launch config even when the loader takes no action", async () => {
  clearLearnedWindow()
  setLearnedWindow(135168)
  const cfgPath = join(tmpdir(), `win-cfg-${process.pid}.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({ provider: { lmstudio: { models: { m: { limit: { context: 65536, output: 32768 } } } } } }),
  )
  const prevCfg = process.env.MIMOCODE_CONFIG
  process.env.MIMOCODE_CONFIG = cfgPath
  try {
    const model: any = { id: "m", providerID: "lmstudio", limit: { context: 65536, output: 32768 } }
    // Registered first, then measured: a measured window belongs to a model, and meeting a different one
    // discards it. Same reason as the reuse case above.
    await (await hook())({ model: { ...model, limit: { ...model.limit } }, provider: { id: "lmstudio" } })
    setLearnedWindow(135168)
    await (await hook())({ model, provider: { id: "lmstudio" } })
    expect(model.limit.context).toBe(135168) // the request object, as before
    const written = JSON.parse(await Bun.file(cfgPath).text())
    expect(written.provider.lmstudio.models.m.limit.context).toBe(135168) // and the FILE
    expect(written.provider.lmstudio.models.m.limit.output).toBe(32768) // output untouched
  } finally {
    if (prevCfg === undefined) delete process.env.MIMOCODE_CONFIG
    else process.env.MIMOCODE_CONFIG = prevCfg
  }
})

// ── A measured window belongs to a model ───────────────────────────────────────────────────────────
//
// The figure is a process-wide cache with a lifetime. Without discarding it when the model changes, the
// last model's window kept standing in for the new one until that lifetime ran out, and every size
// decision in between was computed against a machine holding something else. It also leaked between
// unrelated parts of a run: three checks in an adjacent area went red for a number set here.
test("a different model discards what was learned about the last one", async () => {
  clearLearnedWindow()
  // Nothing can be reached, so the ONLY figure available is whatever was learned.
  process.env.FABULA_MODEL_API = "http://127.0.0.1:1/nope"
  const first: any = { id: "model-A", providerID: "lmstudio", limit: { context: 200000, output: 8000 } }
  await (await hook())({ model: first, provider: { id: "lmstudio" } })
  setLearnedWindow(65536)

  // The same model still gets it — that is the cache doing its job.
  const again: any = { id: "model-A", providerID: "lmstudio", limit: { context: 200000, output: 8000 } }
  await (await hook())({ model: again, provider: { id: "lmstudio" } })
  expect(again.limit.context).toBe(65536)

  // A different one must NOT: its window is unknown, and unknown leaves the configured figure alone
  // rather than borrowing a number measured on something else.
  const other: any = { id: "model-B", providerID: "lmstudio", limit: { context: 200000, output: 8000 } }
  await (await hook())({ model: other, provider: { id: "lmstudio" } })
  expect(other.limit.context).toBe(200000)
})
