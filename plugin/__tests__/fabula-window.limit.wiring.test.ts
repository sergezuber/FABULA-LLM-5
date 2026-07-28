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
  setLearnedWindow(262144)
  const model: any = { id: "m2", providerID: "lmstudio", limit: { context: 131072, output: 8000 } }
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
  setLearnedWindow(65536)
  process.env.FABULA_MODEL_API = "http://127.0.0.1:1/nope"
  const model: any = { id: "m6", providerID: "lmstudio", limit: { context: 262144, output: 8000 } }
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
