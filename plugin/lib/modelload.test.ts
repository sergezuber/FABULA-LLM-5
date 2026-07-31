// Drives the real orchestrator against a stand-in serving API. The planner and the cost fit are tested
// on their own; what only this level can show is that the decision REACHES a load command — or correctly
// does not.

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { rmSync, writeFileSync, readFileSync } from "node:fs"
import { ensureLoadedAtPlannedWindow, readServed, residentsOther, syncEngineLimit, plannedSlots, recordKvSample, readSamples, calibrateCost } from "./modelload"

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

// A stub `lms`, so the guard that asks "is anything still resident?" asks THIS and not the real machine.
// Without it the tests read the developer's own loaded model and every load correctly refuses — the guard
// working exactly as designed, on the wrong subject.
const STUB = join(tmpdir(), `lms-stub-${process.pid}.sh`)
writeFileSync(STUB, "#!/bin/sh\nif [ \"$1\" = ps ]; then echo IDENTIFIER; fi\nexit 0\n", { mode: 0o755 })

beforeEach(() => {
  process.env.FABULA_LMS_BIN = STUB
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
  test("cold start GOES AND MEASURES rather than waiting for a second reading that will never come", async () => {
    // The contract this test used to assert — "one reading, so do nothing" — was the deadlock itself:
    // nothing loads at a second window, so the second reading never exists, so nothing ever loads.
    // Found by unloading the model for real. It now takes the reading, and the serving runtime's own
    // refusal is what keeps that safe.
    serve([KAT("loaded", 65536, 24.45 * GIB)])
    const r = await ensureLoadedAtPlannedWindow("kat", { quiet: async () => false })
    expect(r.acted).toBe(false)
    expect(r.reason).toContain("would measure at")
  })

  test("already at the model's maximum → nothing to raise it to", async () => {
    // Readings are machine-wide now, so this drives the real store: at the passport there is no larger
    // window to measure at and no larger window to load, whatever the cost model says.
    serve([KAT("loaded", 262144, 36.49 * GIB)])
    const r = await ensureLoadedAtPlannedWindow("kat", { quiet: async () => false })
    expect(r.acted).toBe(false)
    expect(r.reason).not.toContain("LOADED")
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

  test("a busy machine is never interrupted — a reload costs every live turn its prefix cache", async () => {
    // Both roads out of here must respect it: the measuring step on a cold start, and the raise once the
    // cost is known. Whichever this run takes, `acted` stays false and the reason says why.
    serve([KAT("loaded", 32768, 22.6 * GIB)])
    const r = await ensureLoadedAtPlannedWindow("kat", { quiet: async () => false })
    expect(r.acted).toBe(false)
    expect(r.reason).toMatch(/busy|never went quiet/)
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

// ── Slot provisioning (measured 2026-07-26) ──────────────────────────────────
describe("plannedSlots", () => {
  test("follows the admission gate, so the two numbers cannot drift apart", () => {
    expect(plannedSlots({ FABULA_MAX_CONCURRENT_UPSTREAM: "1" })).toBe(1)
    expect(plannedSlots({ FABULA_MAX_CONCURRENT_UPSTREAM: "3" })).toBe(3)
  })

  test("an unset gate provisions one slot rather than inheriting whatever was set last", () => {
    // The live runtime had `parallel 4` from an earlier session — a number nothing in the harness chose,
    // and the one that made 262144 unaffordable.
    expect(plannedSlots({})).toBe(1)
  })

  test("unlimited at the gate is not a provisioning; it reads as one slot", () => {
    // 0 means "no ceiling" for admission. A machine cannot be sized for unlimited, and the cache grows
    // lazily anyway, so the honest provisioning is the single slot.
    expect(plannedSlots({ FABULA_MAX_CONCURRENT_UPSTREAM: "0" })).toBe(1)
  })

  test("nonsense never yields a zero or negative slot count", () => {
    for (const bad of ["-2", "abc", ""]) {
      expect(plannedSlots({ FABULA_MAX_CONCURRENT_UPSTREAM: bad })).toBeGreaterThanOrEqual(1)
    }
  })
})

// ── The load command itself (the wiring, not the decision) ───────────────────
// A marker script stands in for `lms` and records its argv, because an argument dropped from the load
// command is invisible to every other test here: the decision would still be right and the machine
// would still be provisioned wrong. Same shape as the corpus worker's FABULA_BUN_BIN probe.
describe("what actually reaches `lms load`", () => {
  const ARGV = join(tmpdir(), `lms-argv-${process.pid}.txt`)
  const MARKER = join(tmpdir(), `lms-marker-${process.pid}.sh`)

  beforeEach(() => {
    rmSync(ARGV, { force: true })
    writeFileSync(MARKER, `#!/bin/sh\n[ "$1" = load ] && printf '%s\\n' "$@" >> ${ARGV}\nexit 0\n`)
    require("node:fs").chmodSync(MARKER, 0o755)
    process.env.FABULA_LMS_BIN = MARKER
  })
  afterEach(() => {
    delete process.env.FABULA_LMS_BIN
    rmSync(ARGV, { force: true })
    rmSync(MARKER, { force: true })
  })

  test("the slot count reaches the command, so provisioning is chosen and never inherited", async () => {
    // Two readings so a cost is learnable and the planner produces a real window.
    writeFileSync(STORE, JSON.stringify({ kat: [
      { windowTokens: 32768, totalBytes: 24 * GIB },
      { windowTokens: 131072, totalBytes: 30 * GIB },
    ] }))
    serve([KAT("loaded", 32768, 22 * GIB)])
    process.env.FABULA_MAX_CONCURRENT_UPSTREAM = "2"
    await ensureLoadedAtPlannedWindow("kat", { loadTimeoutMs: 8000 })
    delete process.env.FABULA_MAX_CONCURRENT_UPSTREAM

    const argv = readFileSync(ARGV, "utf8").split("\n").filter(Boolean)
    expect(argv).toContain("load")
    // The flag AND its value: a flag with the wrong count is the same defect wearing a passing test.
    const at = argv.indexOf("--parallel")
    expect(at).toBeGreaterThan(-1)
    expect(argv[at + 1]).toBe("2")
    // And the window is still passed, so this test cannot pass by the command being empty.
    expect(argv).toContain("--context-length")
  })
})

// ── Request-time cost readings ───────────────────────────────────────────────
// The load-time fit cannot see the cache on a lazy runtime (three sources agree — see calibrateCost).
// These check that the request-time path is reached and preferred, not merely declared.
describe("request-time cache cost", () => {
  const SAMPLES = join(tmpdir(), `kvsamples-test-${process.pid}.json`)
  beforeEach(() => {
    process.env.FABULA_KVSAMPLE_FILE = SAMPLES
    rmSync(SAMPLES, { force: true })
  })
  afterEach(() => {
    delete process.env.FABULA_KVSAMPLE_FILE
    rmSync(SAMPLES, { force: true })
  })

  test("a reading is folded in and read back", () => {
    recordKvSample("kat", { contextTokens: 131021, kvBytes: 13 * GIB })
    expect(readSamples()["kat"]?.[0]?.contextTokens).toBe(131021)
  })

  test("junk readings are refused rather than stored", () => {
    recordKvSample("kat", { contextTokens: 0, kvBytes: GIB })
    recordKvSample("kat", { contextTokens: 100, kvBytes: 0 })
    expect(readSamples()["kat"] ?? []).toHaveLength(0)
  })

  test("a request-time reading OVERRIDES a load-time fit, because it measures the real quantity", async () => {
    // Load-time readings that DO fit a rising line — so the old path would happily produce a cost, and
    // this test can only pass if the sampled one is genuinely preferred.
    writeFileSync(STORE, JSON.stringify({ kat: [
      { windowTokens: 32768, totalBytes: 24 * GIB },
      { windowTokens: 131072, totalBytes: 26 * GIB },   // a cheap ~20k B/token line
    ] }))
    // The measured truth on this machine is ~5× that, which must cap the window far lower.
    recordKvSample("kat", { contextTokens: 131021, kvBytes: Math.round(12.59 * GIB) })
    serve([KAT("loaded", 32768, 22 * GIB)])
    const r = await ensureLoadedAtPlannedWindow("kat", { loadTimeoutMs: 3000 })
    expect(r.plan).toBeDefined()
    // At ~108 900 B/token the ceiling cannot reach the passport; at the load-time line it easily would.
    expect(r.plan!.ceilingTokens).toBeLessThan(262144)
  })
})

describe("a window above the ceiling is corrected, not respected", () => {
  test("an over-sized loaded window is brought down to the plan", async () => {
    const SAMPLES = join(tmpdir(), `kvs-over-${process.pid}.json`)
    process.env.FABULA_KVSAMPLE_FILE = SAMPLES
    rmSync(SAMPLES, { force: true })
    writeFileSync(SAMPLES, JSON.stringify({ kat: [{ contextTokens: 131021, kvBytes: Math.round(12.59 * GIB) }] }))
    const ARGV = join(tmpdir(), `lms-over-${process.pid}.txt`)
    const MARKER = join(tmpdir(), `lms-over-${process.pid}.sh`)
    // `ps` has to answer with a weight, because a plan cannot be sized without one.
    // The stub must model the runtime it stands in for: after an unload the model is GONE from `ps`.
    // A stub that reports it forever makes the "already resident, refuse to load a second copy" guard
    // fire on every test — which is the guard being right about a world that does not exist.
    const STATE = join(tmpdir(), `lms-over-state-${process.pid}`)
    writeFileSync(STATE, "loaded")
    writeFileSync(MARKER, `#!/bin/sh
[ "$1" = load ] && printf '%s\\n' "$@" >> ${ARGV} && echo loaded > ${STATE}
[ "$1" = unload ] && rm -f ${STATE}
[ "$1" = ps ] && [ -f ${STATE} ] && echo "kat  kat  LOADED  22.00 GB  262144  1  Local"
exit 0
`)
    require("node:fs").chmodSync(MARKER, 0o755)
    process.env.FABULA_LMS_BIN = MARKER
    // Loaded at the passport while the machine can only pay for a fraction of it — the live 2026-07-26 state.
    serve([KAT("loaded", 262144, 22 * GIB)])
    const r = await ensureLoadedAtPlannedWindow("kat", { loadTimeoutMs: 8000 })
    expect(r.plan!.tokens).toBeLessThan(262144)
    expect(r.acted).toBe(true)
    const argv = readFileSync(ARGV, "utf8")
    expect(argv).toContain(String(r.plan!.tokens))
    for (const f of [SAMPLES, ARGV, MARKER]) rmSync(f, { force: true })
    delete process.env.FABULA_LMS_BIN
    delete process.env.FABULA_KVSAMPLE_FILE
  })

  test("refuses to plan when the weights are unknown, instead of treating them as free memory", async () => {
    // Point the on-disk weights source at an empty root: on the developer's machine the model id "kat"
    // prefix-matches a REAL downloaded model, and a hermetic test must not read it.
    const emptyRoot = join(tmpdir(), `models-empty-${process.pid}`)
    require("node:fs").mkdirSync(emptyRoot, { recursive: true })
    process.env.FABULA_MODELS_ROOT = emptyRoot
    const SAMPLES = join(tmpdir(), `kvs-nw-${process.pid}.json`)
    const MARKER = join(tmpdir(), `lms-nw-${process.pid}.sh`)
    process.env.FABULA_KVSAMPLE_FILE = SAMPLES
    // A learnable cost, so the run reaches the planning step and can only be stopped by the weights.
    writeFileSync(SAMPLES, JSON.stringify({ kat: [{ contextTokens: 131021, kvBytes: Math.round(12.59 * GIB) }] }))
    // `ps` says nothing — the case where the runtime reports no size.
    writeFileSync(MARKER, `#!/bin/sh\nexit 0\n`)
    require("node:fs").chmodSync(MARKER, 0o755)
    process.env.FABULA_LMS_BIN = MARKER
    serve([KAT("loaded", 262144, 0)])
    const r = await ensureLoadedAtPlannedWindow("kat", { loadTimeoutMs: 5000 })
    expect(r.acted).toBe(false)
    expect(r.plan).toBeUndefined()
    expect(r.reason).toContain("weights")
    delete process.env.FABULA_MODELS_ROOT
    for (const f of [SAMPLES, MARKER]) rmSync(f, { force: true })
    delete process.env.FABULA_LMS_BIN
    delete process.env.FABULA_KVSAMPLE_FILE
  })
})

describe("never a second copy", () => {
  // The incident this guard exists for: an unload that could not take a BUSY model failed silently, the
  // load went ahead anyway, and two lots of 21.95 GB of weights took a 48 GB machine into fifteen
  // gigabytes of swap. The instance serving the user's own turn was killed for memory and eight and a
  // half minutes of work went with it. Disabling the guard used to break no test at all.
  test("a model that survives the unload is NOT loaded on top of", async () => {
    const ARGV = join(tmpdir(), `lms-stuck-${process.pid}.txt`)
    const MARKER = join(tmpdir(), `lms-stuck-${process.pid}.sh`)
    rmSync(ARGV, { force: true })
    // An unload that does nothing — the shape of a model too busy to be taken down.
    writeFileSync(MARKER, `#!/bin/sh
[ "$1" = load ] && printf '%s\\n' "$@" >> ${ARGV}
[ "$1" = ps ] && echo "kat  kat  LOADED  22.00 GB  262144  1  Local"
exit 0
`)
    require("node:fs").chmodSync(MARKER, 0o755)
    process.env.FABULA_LMS_BIN = MARKER
    writeFileSync(STORE, JSON.stringify({ kat: [
      { windowTokens: 32768, totalBytes: 24 * GIB },
      { windowTokens: 131072, totalBytes: 30 * GIB },
    ] }))
    serve([KAT("loaded", 32768, 22 * GIB)])
    const r = await ensureLoadedAtPlannedWindow("kat", { loadTimeoutMs: 3000 })
    expect(r.acted).toBe(false)
    expect(r.reason).toContain("still resident")
    // and the load command was never issued — the machine was never asked to hold two copies
    expect(require("node:fs").existsSync(ARGV)).toBe(false)
    rmSync(MARKER, { force: true })
  })
})

  test("a NOT-loaded model is sized from its files on disk — the moment the plan matters most", async () => {
    // The measured gap: `lms ps` lists only loaded models and the API says size_bytes:null when
    // not-loaded, so switching TO a model refused with "the runtime reported none". The files on disk
    // ARE what the load will wire in; a fake model dir stands in for the store.
    const root = join(tmpdir(), `models-disk-${process.pid}`)
    const dir = join(root, "pub", "katx-4bit")
    require("node:fs").mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "model.safetensors"), Buffer.alloc(1024, 1)) // size is what matters, not content
    process.env.FABULA_MODELS_ROOT = root
    const SAMPLES = join(tmpdir(), `kvs-disk-${process.pid}.json`)
    process.env.FABULA_KVSAMPLE_FILE = SAMPLES
    writeFileSync(SAMPLES, JSON.stringify({ katx: [{ contextTokens: 131021, kvBytes: Math.round(12.59 * GIB) }] }))
    const MARKER = join(tmpdir(), `lms-disk-${process.pid}.sh`)
    writeFileSync(MARKER, `#!/bin/sh\nexit 0\n`) // ps answers nothing — the model is not loaded
    require("node:fs").chmodSync(MARKER, 0o755)
    process.env.FABULA_LMS_BIN = MARKER
    serve([{ id: "katx", type: "llm", state: "not-loaded", loaded_context_length: 0, max_context_length: 262144, size_bytes: null }])
    const r = await ensureLoadedAtPlannedWindow("katx", { loadTimeoutMs: 5000 })
    // With disk weights known the plan EXISTS (tiny weights -> full passport fits); without the disk
    // source this refuses with "reported none" — which is exactly the mutation this test kills.
    expect(r.plan).toBeDefined()
    expect(r.reason).not.toContain("without knowing its weights")
    delete process.env.FABULA_MODELS_ROOT
    delete process.env.FABULA_KVSAMPLE_FILE
    delete process.env.FABULA_LMS_BIN
    rmSync(root, { recursive: true, force: true }); rmSync(SAMPLES, { force: true }); rmSync(MARKER, { force: true })
  })

describe("calibration records only what the fit can use", () => {
  const S = join(tmpdir(), `kvs-floor-${process.pid}.json`)
  beforeEach(() => { process.env.FABULA_KVSAMPLE_FILE = S; rmSync(S, { force: true }) })
  afterEach(() => { delete process.env.FABULA_KVSAMPLE_FILE; rmSync(S, { force: true }) })

  test("a sub-floor reading is never written — it would evict good ones and fake agreement", () => {
    // The measured loop: six readings at 22,373 tokens accumulated for one model while the fit reported
    // "no readings", and the FIFO cap of 8 meant four more would have evicted the only true reading.
    recordKvSample("m", { contextTokens: 22_373, kvBytes: Math.round(1.22 * GIB) })
    expect(readSamples()["m"] ?? []).toHaveLength(0)
  })

  test("an at-or-above-floor reading is written", () => {
    recordKvSample("m", { contextTokens: 32_768, kvBytes: Math.round(3.9 * GIB) })
    expect(readSamples()["m"] ?? []).toHaveLength(1)
  })

  test("a good reading cannot be evicted by a run of junk", () => {
    recordKvSample("m", { contextTokens: 40_949, kvBytes: Math.round(4.72 * GIB) }) // the true one
    for (let i = 0; i < 12; i++) recordKvSample("m", { contextTokens: 22_373, kvBytes: Math.round(1.22 * GIB) })
    const kept = readSamples()["m"] ?? []
    expect(kept).toHaveLength(1)
    expect(kept[0].contextTokens).toBe(40_949)
  })
})

describe("a load command that succeeded is not a window that changed", () => {
  test("a runtime that keeps a WIDER window than asked is reported as a refusal, with the cost named", async () => {
    // Measured 2026-07-31: `lms load --context-length 143360` exited 0 and left the model at 183296.
    // The old text said "lowered 183296 -> 183296" — announcing an action nobody performed.
    const SAMPLES = join(tmpdir(), `kvs-refuse-${process.pid}.json`)
    const MARKER = join(tmpdir(), `lms-refuse-${process.pid}.sh`)
    process.env.FABULA_KVSAMPLE_FILE = SAMPLES
    writeFileSync(SAMPLES, JSON.stringify({ kat: [{ contextTokens: 50_391, kvBytes: Math.round(6.09 * GIB) }] }))
    // Stateful, like the real CLI: after `unload` the model is GONE from ps (so the resident guard is
    // satisfied), and after `load` it is back — at 183296, the window the runtime insisted on.
    const STATE = join(tmpdir(), `lms-state-${process.pid}`)
    rmSync(STATE, { force: true })
    writeFileSync(MARKER, [
      "#!/bin/sh",
      `case "$1" in`,
      `  unload) : > ${STATE} ;;`,
      `  load) rm -f ${STATE} ;;`,
      `  ps) [ -f ${STATE} ] || echo "kat  kat  LOADED  20.00 GB  183296  1  Local" ;;`,
      "esac",
      "exit 0",
    ].join("\n"))
    require("node:fs").chmodSync(MARKER, 0o755)
    process.env.FABULA_LMS_BIN = MARKER
    // The API keeps answering 183296 both before and AFTER the load — the runtime ignored the flag.
    serve([KAT("loaded", 183_296, 20 * GIB)])
    const r = await ensureLoadedAtPlannedWindow("kat", { loadTimeoutMs: 8000 })
    expect(r.plan!.tokens).toBeLessThan(183_296)      // the plan wanted less
    expect(r.reason).toContain("REFUSED")             // and says so, rather than claiming success
    expect(r.reason).not.toContain("lowered 183296 -> 183296")
    expect(r.reason).toMatch(/GiB/)                   // the over-commit is priced, not just named
    delete process.env.FABULA_LMS_BIN
    delete process.env.FABULA_KVSAMPLE_FILE
    for (const f of [SAMPLES, MARKER, STATE]) rmSync(f, { force: true })
  })
})
