// Drives the real orchestrator against a stand-in serving API. The planner and the cost fit are tested
// on their own; what only this level can show is that the decision REACHES a load command — or correctly
// does not.

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { shellPathLiteral } from "./platform/shell"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { ensureLoadedAtPlannedWindow, readServed, residentsOther, syncEngineLimit, plannedSlots, recordKvSample, readSamples, calibrateCost, unitBytes, weightsFromLmsPs, weightsBytesOf } from "./modelload"
import { fitCostFromSamples } from "./kvcost"
import { writeMarkerScript } from "./platform/shell"

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
// A test must be allowed to wait LONGER than the budget it hands the code. MEASURED 2026-08-01: seven
// tests here passed `loadTimeoutMs` of 3-8s while running under bun's 5s default, so three of them asked
// the code for more time than the harness was willing to give. They passed only while the machine was
// idle and the marker script returned instantly, and flaked the moment the suite ran under load — which
// reads as "the code is flaky" when the contradiction is in the test. Each now declares budget + 12s.
const STUB = join(tmpdir(), `lms-stub-${process.pid}.sh`)
const STUB_BIN = writeMarkerScript(STUB, "#!/bin/sh\nif [ \"$1\" = ps ]; then echo IDENTIFIER; fi\nexit 0\n")

// The MACHINE is pinned, like the `lms` binary and the serving API above it. Without it these cases
// plan against however much memory THIS computer has, and a decision test becomes a fact about the
// developer's hardware: the model here weighs 22 GiB, so on any machine with less than about 32 GiB the
// planner would correctly refuse and every one of them would report a defect that does not exist.
// A quiet 48 GiB Mac is what they were written against; now they say so instead of assuming it.
// (This is NOT the cause of the flake fixed below — measured: the plan is sized from TOTAL memory, so
// how much was free never entered the decision. Pinning `used` changes no verdict here; it is pinned
// anyway so the two readings cannot disagree about which machine is being described.)
const PINNED_TOTAL = 48 * GIB
const PINNED_USED = 8 * GIB

beforeEach(() => {
  process.env.FABULA_LMS_BIN = STUB_BIN
  process.env.FABULA_KVCOST_FILE = STORE
  process.env.FABULA_MEMORY_TOTAL_BYTES = String(PINNED_TOTAL)
  process.env.FABULA_MEMORY_USED_BYTES = String(PINNED_USED)
  delete process.env.FABULA_AUTO_WINDOW
  rmSync(STORE, { force: true })
})
afterEach(() => {
  server?.stop(true)
  delete process.env.FABULA_MEMORY_TOTAL_BYTES
  delete process.env.FABULA_MEMORY_USED_BYTES
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
    const r = residentsOther(served as any, "kat", () => 0)
    expect(r.map((x) => x.id)).toEqual(["witness"])
  })

  // MEASURED 2026-08-01: the live serving API omits size_bytes ENTIRELY, so every resident arrived with
  // bytes:0 and the old `.filter(m => m.bytes > 0)` dropped it — the residents term could never fire on
  // this runtime. Dropping a resident is not "no resident"; it is "the machine is empty", which is the
  // one reading that over-commits it.
  test("a resident the serving API cannot size is SIZED FROM ANOTHER SOURCE, not dropped", () => {
    const served = [
      { id: "kat", state: "loaded", bytes: 0, loadedWindow: 0, passport: 0 },
      { id: "witness", state: "loaded", bytes: 0, loadedWindow: 0, passport: 0 },
    ]
    const r = residentsOther(served as any, "kat", (id) => (id === "witness" ? 19 * GIB : 0))
    expect(r).toEqual([{ id: "witness", bytes: 19 * GIB }])
  })

  test("a resident NOTHING can size is still reported, with bytes 0 meaning unknown", () => {
    const served = [
      { id: "kat", state: "loaded", bytes: 0, loadedWindow: 0, passport: 0 },
      { id: "mystery", state: "loaded", bytes: 0, loadedWindow: 0, passport: 0 },
    ]
    const r = residentsOther(served as any, "kat", () => 0)
    expect(r).toEqual([{ id: "mystery", bytes: 0 }])
  })
})

describe("weights as the runtime PRINTS them", () => {
  // MEASURED 2026-08-01: `lms ps` prints "21.95 GB" and that model's weight files on disk sum to
  // 21,950,414,309 bytes = 21.95 x 10^9. Reading the decimal string as binary invented 1.51 GiB.
  test("a suffix without an 'i' is decimal; one with an 'i' is binary", () => {
    expect(unitBytes("GB")).toBe(1e9)
    expect(unitBytes("gb")).toBe(1e9)
    expect(unitBytes("GiB")).toBe(1024 ** 3)
    expect(unitBytes("MB")).toBe(1e6)
    expect(unitBytes("MiB")).toBe(1024 ** 2)
  })

  test("the real printed string resolves to the real on-disk size", () => {
    // 21.95 GB as printed, against 21,950,414,309 bytes actually on disk: within 0.01%.
    const parsed = 21.95 * unitBytes("GB")
    expect(Math.abs(parsed - 21_950_414_309) / 21_950_414_309).toBeLessThan(0.001)
    // The binary reading of the same string is 1.5 GiB of weights that do not exist.
    expect(21.95 * 1024 ** 3 - parsed).toBeGreaterThan(1.5 * GIB)
  })

  // MEASURED 2026-08-15: a model named `qwen3.8-27b-mlx` had its weights read as 27 BYTES. The parser
  // scanned the whole `lms ps` line for a number-with-unit, and the parameter count in the NAME —
  // "27b" — matched as 27 B. The || chain treats 27 as known-positive, so the real 15.15 GB on disk
  // was never asked for, the weights left the budget entirely, and the plan over-committed the machine
  // by 14 GiB. Any model with its size in its name (`35b`, `8b`, …) hits the same debris.
  test("a parameter count in the model NAME is not a size: the SIZE column wins", () => {
    const MARKER = join(tmpdir(), `lms-27b-${process.pid}.sh`)
    process.env.FABULA_LMS_BIN = writeMarkerScript(MARKER, `#!/bin/sh
[ "$1" = ps ] && echo "qwen3.8-27b-mlx    qwen3.8-27b-mlx    IDLE    15.15 GB    167936    1    Local"
exit 0
`)
    try {
      const rows = weightsFromLmsPs()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.bytes).toBeCloseTo(15.15 * 1e9, -7)
      // And the caller that matters: the model's weights, not its name.
      expect(weightsBytesOf("qwen3.8-27b-mlx")).toBeCloseTo(15.15 * 1e9, -7)
    } finally {
      delete process.env.FABULA_LMS_BIN
      rmSync(MARKER, { force: true })
    }
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
    process.env.FABULA_LMS_BIN = writeMarkerScript(MARKER, `[ "$1" = load ] && printf '%s\\n' "$@" >> ${shellPathLiteral(ARGV)}\nexit 0\n`)
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
  }, 20000)
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

  // MEASURED 2026-08-01: one calibration reported 29,132 B/token against a stored 123,758 for the same
  // resident model, was written anyway, and moved the fit from usable to REFUSING — so planWindow could
  // no longer size anything. Screening on the floor alone was never enough; agreement is the other half.
  test("a CHEAPER reading that disagrees is refused, and the store keeps what it had", () => {
    recordKvSample("kat", { contextTokens: 40_949, kvBytes: Math.round(4.72 * GIB) }) // 123,758 B/token
    const verdict = recordKvSample("kat", { contextTokens: 50_391, kvBytes: Math.round(1.37 * GIB) }) // 29,132
    expect(verdict.admitted).toBe(false)
    expect(verdict.reason).toContain("CHEAPER")
    const kept = readSamples()["kat"] ?? []
    expect(kept).toHaveLength(1)
    expect(kept[0]!.contextTokens).toBe(40_949)
    // And the fit still works — the whole point of refusing.
    expect(fitCostFromSamples(kept).bytesPerToken).toBeGreaterThan(100_000)
  })

  test("a DEARER reading that disagrees REPLACES the store, because under-reading is the dangerous direction", () => {
    recordKvSample("kat", { contextTokens: 50_391, kvBytes: Math.round(1.37 * GIB) }) // 29,132 B/token
    const verdict = recordKvSample("kat", { contextTokens: 40_949, kvBytes: Math.round(4.72 * GIB) }) // 123,758
    expect(verdict.admitted).toBe(true)
    expect(verdict.reason).toContain("DEARER")
    const kept = readSamples()["kat"] ?? []
    expect(kept).toHaveLength(1)
    expect(kept[0]!.contextTokens).toBe(40_949)
    expect(fitCostFromSamples(kept).bytesPerToken).toBeGreaterThan(100_000)
  })

  test("readings that AGREE still accumulate — the guard is about disagreement, not about novelty", () => {
    expect(recordKvSample("kat", { contextTokens: 40_949, kvBytes: Math.round(4.72 * GIB) }).admitted).toBe(true)
    expect(recordKvSample("kat", { contextTokens: 60_332, kvBytes: Math.round(6.6 * GIB) }).admitted).toBe(true)
    expect(readSamples()["kat"] ?? []).toHaveLength(2)
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
  }, 15000)
})

// ── The uncalibrated window cap ──────────────────────────────────────────────
// MEASURED 2026-08-14, live on a 48 GB Mac: a freshly added MLX model collected load-time footprints
// 16384→9.12 GB, 32768→8.50 GB (the footprint FELL on a doubling — drift, not cache), 65536→11.25 GB,
// 262144→12.61 GB. The fit through them reported 14,505 B/token against a real ~65,536, the plan granted
// the full 262,144 passport, and two ~200k-token caches alive at once put the machine at 47 of 48 GiB.
// On a lazy runtime a load-time fit prices drift; drift that happens to RISE reads as a cheap cache and
// the negative-slope guard never fires. Until a request-time reading exists, the window must not rise
// above the rung the calibration itself needs.
describe("no request-time reading, no window above the measurement rung", () => {
  // The marker models the runtime: `ps` answers a weight only while loaded, unload clears it, load
  // records argv and sets it — the same shape the over-sized-window test uses, because a stub that
  // reports the model forever makes the second-copy guard fire on a world that does not exist.
  const ARGV = join(tmpdir(), `lms-cap-argv-${process.pid}.txt`)
  const MARKER = join(tmpdir(), `lms-cap-${process.pid}.sh`)
  const STATE = join(tmpdir(), `lms-cap-state-${process.pid}`)
  const SAMPLES = join(tmpdir(), `kvs-cap-${process.pid}.json`)

  beforeEach(() => {
    rmSync(ARGV, { force: true })
    rmSync(STATE, { force: true })
    process.env.FABULA_KVSAMPLE_FILE = SAMPLES
    rmSync(SAMPLES, { force: true })
    const body = `#!/bin/sh
[ "$1" = load ] && printf '%s\\n' "$@" >> ${shellPathLiteral(ARGV)} && echo loaded > ${shellPathLiteral(STATE)}
[ "$1" = unload ] && rm -f ${shellPathLiteral(STATE)}
[ "$1" = ps ] && [ -f ${shellPathLiteral(STATE)} ] && echo "kat  kat  LOADED  22.00 GB  262144  1  Local"
exit 0
`
    process.env.FABULA_LMS_BIN = writeMarkerScript(MARKER, body)
  })
  afterEach(() => {
    delete process.env.FABULA_LMS_BIN
    delete process.env.FABULA_KVSAMPLE_FILE
    for (const f of [ARGV, MARKER, STATE, SAMPLES]) rmSync(f, { force: true })
  })

  test("the cap is derived from the calibration's own needs, not typed", async () => {
    const { MAX_UNCALIBRATED_WINDOW } = await import("./modelload")
    // Three signal floors: the large probe is 2.6x the floor (see calibrateCost), the rest is headroom
    // for output and drift. 3 x 32768 lands exactly on the 4096 quantum.
    expect(MAX_UNCALIBRATED_WINDOW).toBe(3 * 32768)
  })

  test("a load-time-only fit cannot grant a window above the rung", async () => {
    // The drift line from the incident, in miniature: a rising fit that is far too cheap (21,845 B/token),
    // so the computed ceiling towers over the passport and only the cap stands between it and the load.
    writeFileSync(STORE, JSON.stringify({ kat: [
      { windowTokens: 32768, totalBytes: 24 * GIB },
      { windowTokens: 131072, totalBytes: 26 * GIB },
    ] }))
    serve([KAT("loaded", 32768, 22 * GIB)])
    const r = await ensureLoadedAtPlannedWindow("kat", { loadTimeoutMs: 20000 })
    expect(r.acted, `declined to act: ${r.reason}`).toBe(true)
    const argv = readFileSync(ARGV, "utf8")
    expect(argv).toContain("98304")
    expect(argv).not.toContain("262144")
    expect(r.reason).toContain("98304")
  }, 32000)

  test("a real request-time reading lifts the cap — the plan is trusted once measured", async () => {
    // The same too-cheap load-time line, plus ONE request-time sample at ~108,900 B/token: the sample
    // takes precedence, the ceiling falls below the passport but stays above the rung, and the load
    // goes to the COMPUTED window, not the cap.
    writeFileSync(STORE, JSON.stringify({ kat: [
      { windowTokens: 32768, totalBytes: 24 * GIB },
      { windowTokens: 131072, totalBytes: 26 * GIB },
    ] }))
    process.env.FABULA_KVSAMPLE_FILE = SAMPLES
    writeFileSync(SAMPLES, JSON.stringify({ kat: [{ contextTokens: 131021, kvBytes: Math.round(12.59 * GIB) }] }))
    serve([KAT("loaded", 32768, 22 * GIB)])
    const r = await ensureLoadedAtPlannedWindow("kat", { loadTimeoutMs: 30000 })
    expect(r.acted, `declined to act: ${r.reason}`).toBe(true)
    expect(r.plan!.tokens).toBeGreaterThan(98304)
    const argv = readFileSync(ARGV, "utf8")
    expect(argv).toContain(String(r.plan!.tokens))
    expect(argv).not.toContain("98304")
  }, 45000)

  test("the cold-start ladder never climbs past the rung", async () => {
    // No readings at all, sitting at 65536: the doubling would ask for 131072, but a rung nobody has
    // measured at is exactly what the cap exists to prevent.
    serve([KAT("loaded", 65536, 22 * GIB)])
    const r = await ensureLoadedAtPlannedWindow("kat", { loadTimeoutMs: 20000 })
    expect(r.acted, `declined to act: ${r.reason}`).toBe(true)
    const argv = readFileSync(ARGV, "utf8")
    expect(argv).toContain("98304")
    expect(argv).not.toContain("131072")
  }, 32000)
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
    const MARKER_BODY = `#!/bin/sh
[ "$1" = load ] && printf '%s\\n' "$@" >> ${shellPathLiteral(ARGV)} && echo loaded > ${shellPathLiteral(STATE)}
[ "$1" = unload ] && rm -f ${shellPathLiteral(STATE)}
[ "$1" = ps ] && [ -f ${shellPathLiteral(STATE)} ] && echo "kat  kat  LOADED  22.00 GB  262144  1  Local"
exit 0
`
    process.env.FABULA_LMS_BIN = writeMarkerScript(MARKER, MARKER_BODY)
    // Loaded at the passport while the machine can only pay for a fraction of it — the live 2026-07-26 state.
    serve([KAT("loaded", 262144, 22 * GIB)])
    // The bound exists so a genuinely hung load cannot stall the suite — not to time a process spawn.
    // At 8s it did the latter: under the full 167-file run this failed about every other time with
    // `load failed: [timed out after 8000ms]`, i.e. the stopwatch, not the product. The outer budget
    // below sits BEHIND this one; the arithmetic is the point, and getting it backwards is how a
    // bounded step reports the clock instead of the step.
    const r = await ensureLoadedAtPlannedWindow("kat", { loadTimeoutMs: 30_000 })
    expect(r.plan!.tokens).toBeLessThan(262144)
    // The loader always says WHY it declined; a bare `false` here sent three rounds of guessing after a
    // flake whose cause was one sentence away.
    expect(r.acted, `declined to act: ${r.reason}`).toBe(true)
    const argv = readFileSync(ARGV, "utf8")
    expect(argv).toContain(String(r.plan!.tokens))
    for (const f of [SAMPLES, ARGV, MARKER]) rmSync(f, { force: true })
    delete process.env.FABULA_LMS_BIN
    delete process.env.FABULA_KVSAMPLE_FILE
  }, 60_000)

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
    process.env.FABULA_LMS_BIN = writeMarkerScript(MARKER, `exit 0\n`)
    serve([KAT("loaded", 262144, 0)])
    const r = await ensureLoadedAtPlannedWindow("kat", { loadTimeoutMs: 5000 })
    expect(r.acted).toBe(false)
    expect(r.plan).toBeUndefined()
    expect(r.reason).toContain("weights")
    delete process.env.FABULA_MODELS_ROOT
    for (const f of [SAMPLES, MARKER]) rmSync(f, { force: true })
    delete process.env.FABULA_LMS_BIN
    delete process.env.FABULA_KVSAMPLE_FILE
  }, 17000)
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
    const MARKER_BODY = `#!/bin/sh
[ "$1" = load ] && printf '%s\\n' "$@" >> ${shellPathLiteral(ARGV)}
[ "$1" = ps ] && echo "kat  kat  LOADED  22.00 GB  262144  1  Local"
exit 0
`
    process.env.FABULA_LMS_BIN = writeMarkerScript(MARKER, MARKER_BODY)
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
  }, 15000)
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
    const MARKER_BODY = `#!/bin/sh\nexit 0\n` // ps answers nothing — the model is not loaded
    process.env.FABULA_LMS_BIN = writeMarkerScript(MARKER, MARKER_BODY)
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
  }, 17000)

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
    const MARKER_BODY = [
      "#!/bin/sh",
      `case "$1" in`,
      `  unload) : > ${shellPathLiteral(STATE)} ;;`,
      `  load) rm -f ${shellPathLiteral(STATE)} ;;`,
      `  ps) [ -f ${shellPathLiteral(STATE)} ] || echo "kat  kat  LOADED  20.00 GB  183296  1  Local" ;;`,
      "esac",
      "exit 0",
    ].join("\n")
    process.env.FABULA_LMS_BIN = writeMarkerScript(MARKER, MARKER_BODY)
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
  }, 20000)
})

// ── The calibration records the one quantity nobody was measuring ──────────────────────────────────
//
// WIRING, not logic. The reachability gate counts an import as a use, so it cannot tell a call from a
// mention — which means the only thing that can catch the producer being removed is driving the real
// path and looking for what it should have written down.
test("calibrateCost records a concurrency reading for THIS machine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-conc-"))
  const store = join(dir, "concurrency.json")
  const prevStore = process.env.FABULA_CONCURRENCY_FILE
  const prevUrl = process.env.LMSTUDIO_URL
  process.env.FABULA_CONCURRENCY_FILE = store
  let srv: any
  try {
    // An endpoint that answers like the serving runtime: a completion carrying the prompt size it saw.
    // The prompt size ANSWERS THE REQUEST, because the calibration compares two probes and refuses when
    // they differ by less than its floor — correctly, since below that it would be measuring drift rather
    // than cache. A stand-in returning one constant makes every probe identical and the calibration
    // declines, which is what happened and what the verdict assertion above now says out loud.
    srv = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.text()
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: Math.round(body.length / 4) } }),
          { headers: { "Content-Type": "application/json" } },
        )
      },
    })
    // The endpoint is NAMED, because the calibration refuses to make a live call under a test runner
    // unless one is — the guard that keeps this suite hermetic. Naming a local stand-in is the caller
    // saying it means to exercise the path.
    const verdict = await calibrateCost("some-model", { endpoint: `http://127.0.0.1:${srv.port}/v1`, tokens: 40_000, settleMs: 0 })
    // The calibration's OWN verdict first. Without it, a run where the calibration declined to happen at
    // all looks identical to one where it happened and recorded nothing — and those are opposite faults.
    // Measured: this failed on a build machine in under eight milliseconds, far too fast to have made the
    // request, and the failure text said only that a file was missing.
    // The calibration itself CANNOT succeed against a stand-in — it compares two probes and requires the
    // larger one to have allocated memory, which nothing here does, and it says so rather than inventing a
    // cost. That refusal is the mechanism working. What is under test is the reading taken per PROBE,
    // which happens before any of that: two real requests were made, and each should have left a record.
    expect(verdict.reason).toBeTruthy()
    const written = JSON.parse(readFileSync(store, "utf8"))
    expect(written.samples.length).toBeGreaterThan(0)
    const s = written.samples[0]
    expect(s.slots).toBe(plannedSlots())
    expect(s.msPerCall).toBeGreaterThan(0)
    expect(s.fingerprint).toHaveLength(16) // this machine, not any machine
  } finally {
    srv?.stop(true)
    if (prevStore === undefined) delete process.env.FABULA_CONCURRENCY_FILE
    else process.env.FABULA_CONCURRENCY_FILE = prevStore
    if (prevUrl === undefined) delete process.env.LMSTUDIO_URL
    else process.env.LMSTUDIO_URL = prevUrl
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
