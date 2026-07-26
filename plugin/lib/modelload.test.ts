// Drives the real orchestrator against a stand-in serving API. The planner and the cost fit are tested
// on their own; what only this level can show is that the decision REACHES a load command — or correctly
// does not.

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { rmSync, writeFileSync, readFileSync } from "node:fs"
import { ensureLoadedAtPlannedWindow, readServed, residentsOther, syncEngineLimit } from "./modelload"

const GIB = 1024 ** 3
const STORE = join(tmpdir(), `kvcost-test-${process.pid}.json`)

let server: any
function serve(models: any[]) {
  server?.stop(true)
  server = Bun.serve({
    port: 0,
    fetch: () => new Response(JSON.stringify({ data: models }), { headers: { "content-type": "application/json" } }),
  })
  process.env.FABULA_MODEL_API = `http://127.0.0.1:${server.port}/api/v0/models`
}

const KAT = (state: string, loaded: number, bytes: number) => ({
  id: "kat", type: "llm", state, loaded_context_length: loaded, max_context_length: 262144, size_bytes: bytes,
})

beforeEach(() => {
  process.env.FABULA_KVCOST_FILE = STORE
  delete process.env.FABULA_AUTO_WINDOW
  rmSync(STORE, { force: true })
})
afterEach(() => {
  server?.stop(true)
  rmSync(STORE, { force: true })
})

describe("reading the serving API", () => {
  test("passport, loaded window and size come back as numbers", async () => {
    serve([KAT("loaded", 65536, 24.45 * GIB)])
    const s = await readServed()
    expect(s[0].passport).toBe(262144)
    expect(s[0].loadedWindow).toBe(65536)
  })

  test("an unreachable API yields nothing rather than throwing", async () => {
    process.env.FABULA_MODEL_API = "http://127.0.0.1:1/nope"
    expect(await readServed(300)).toEqual([])
  })
})

describe("other residents", () => {
  test("a second loaded model counts; the model itself and unloaded ones do not", () => {
    const served = [
      { id: "kat", state: "loaded", bytes: 20 * GIB, loadedWindow: 0, passport: 0 },
      { id: "witness", state: "loaded", bytes: 19 * GIB, loadedWindow: 0, passport: 0 },
      { id: "embed", state: "not-loaded", bytes: GIB, loadedWindow: 0, passport: 0 },
    ]
    const r = residentsOther(served as any, "kat")
    expect(r.map((x) => x.id)).toEqual(["witness"])
  })
})

describe("when it must NOT act", () => {
  test("cold start: one reading is not a cost model, so nothing is loaded blind", async () => {
    serve([KAT("loaded", 65536, 24.45 * GIB)])
    const r = await ensureLoadedAtPlannedWindow("kat")
    expect(r.acted).toBe(false)
    expect(r.reason).toContain("not learned yet")
  })

  test("already at the planned window → left alone", async () => {
    // Two readings teach the line, then the model is already where the plan wants it.
    serve([KAT("loaded", 65536, 24.45 * GIB)])
    await ensureLoadedAtPlannedWindow("kat")
    serve([KAT("loaded", 262144, 36.49 * GIB)])
    const r = await ensureLoadedAtPlannedWindow("kat")
    expect(r.acted).toBe(false)
    expect(r.reason).toContain("already at 262144")
    expect(r.plan?.tokens).toBe(262144)
  })

  test("the kill switch stops it before it looks at anything", async () => {
    process.env.FABULA_AUTO_WINDOW = "0"
    serve([KAT("loaded", 4096, 21 * GIB)])
    expect((await ensureLoadedAtPlannedWindow("kat")).reason).toContain("FABULA_AUTO_WINDOW=0")
  })

  test("an unreachable serving API is reported, not guessed around", async () => {
    process.env.FABULA_MODEL_API = "http://127.0.0.1:1/nope"
    expect((await ensureLoadedAtPlannedWindow("kat")).reason).toContain("not reachable")
  })

  test("a model with no passport is never planned for", async () => {
    serve([{ id: "kat", type: "llm", state: "loaded", loaded_context_length: 4096, size_bytes: GIB }])
    expect((await ensureLoadedAtPlannedWindow("kat")).reason).toContain("no maximum window")
  })

  test("a busy machine is not interrupted — a reload costs every live turn its prefix cache", async () => {
    serve([KAT("loaded", 65536, 24.45 * GIB)])
    await ensureLoadedAtPlannedWindow("kat")
    serve([KAT("loaded", 32768, 22.6 * GIB)])
    const r = await ensureLoadedAtPlannedWindow("kat", { quiet: async () => false })
    expect(r.acted).toBe(false)
    expect(r.reason).toContain("never went quiet")
  })
})

describe("single flight", () => {
  test("two callers at once produce ONE decision, not a race into a double load", async () => {
    serve([KAT("loaded", 65536, 24.45 * GIB)])
    const [a, b] = await Promise.all([
      ensureLoadedAtPlannedWindow("kat"),
      ensureLoadedAtPlannedWindow("kat"),
    ])
    expect(a).toBe(b) // the same promise, joined — not two independent runs
  })
})

describe("never throws", () => {
  test("garbage from the serving API is survived", async () => {
    server?.stop(true)
    server = Bun.serve({ port: 0, fetch: () => new Response("not json") })
    process.env.FABULA_MODEL_API = `http://127.0.0.1:${server.port}/x`
    await expect(ensureLoadedAtPlannedWindow("kat")).resolves.toBeTruthy()
  })
})

describe("the engine's own limit follows the measured window", () => {
  const CFG = join(tmpdir(), `cfg-${process.pid}.json`)
  const write = (ctx: number) =>
    writeFileSync(CFG, JSON.stringify({ provider: { lmstudio: { models: { kat: { limit: { context: ctx, output: 8000 } } } } } }))

  afterEach(() => rmSync(CFG, { force: true }))

  test("a config half the real window is corrected — measured live at 131072 against 262144", () => {
    write(131072)
    const r = syncEngineLimit(CFG, "kat", 262144)
    expect(r.changed).toBe(true)
    expect(r.from).toBe(131072)
    expect(JSON.parse(readFileSync(CFG, "utf8")).provider.lmstudio.models.kat.limit.context).toBe(262144)
  })

  test("the output half of the limit is untouched — the engine refuses to start without both", () => {
    write(131072)
    syncEngineLimit(CFG, "kat", 262144)
    expect(JSON.parse(readFileSync(CFG, "utf8")).provider.lmstudio.models.kat.limit.output).toBe(8000)
  })

  test("an already-correct config is not rewritten", () => {
    write(262144)
    expect(syncEngineLimit(CFG, "kat", 262144).changed).toBe(false)
  })

  test("no measured window → nothing is written; it can never invent a limit", () => {
    write(131072)
    expect(syncEngineLimit(CFG, "kat", 0).changed).toBe(false)
    expect(JSON.parse(readFileSync(CFG, "utf8")).provider.lmstudio.models.kat.limit.context).toBe(131072)
  })

  test("a missing or broken config is reported, never thrown", () => {
    expect(syncEngineLimit("/nope/nothing.json", "kat", 262144).changed).toBe(false)
    expect(() => syncEngineLimit("/nope/nothing.json", "kat", 262144)).not.toThrow()
  })
})
