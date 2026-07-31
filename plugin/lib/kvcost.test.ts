import { describe, expect, test } from "bun:test"
import { fitCost, fitCostFromSamples, addObservation, safeSecondWindow, MIN_WINDOW_SPREAD, type Observation, marginalCost } from "./kvcost"

const GIB = 1024 ** 3
// The owner's real model. Measured live: 36.49 GiB at a 262144 window, 20.44 GiB of weights.
const WEIGHTS = 20.44 * GIB
const PER_TOKEN = (16.05 * GIB) / 262144

const reading = (w: number): Observation => ({ windowTokens: w, totalBytes: WEIGHTS + w * PER_TOKEN })

describe("two readings determine the line", () => {
  test("weights and per-token cost are recovered from two loads — no architecture knowledge", () => {
    const f = fitCost([reading(65536), reading(262144)])
    expect(f.bytesPerToken).toBe(Math.round(PER_TOKEN))
    expect(f.weightsBytes / GIB).toBeCloseTo(20.44, 1)
    expect(f.points).toBe(2)
  })

  test("more readings still fit, and noise does not throw it off", () => {
    const noisy = [reading(32768), reading(131072), reading(262144)].map((o, i) => ({
      ...o,
      totalBytes: o.totalBytes + (i - 1) * 0.02 * GIB, // ±20 MiB of measurement noise
    }))
    const f = fitCost(noisy)
    expect(f.bytesPerToken / PER_TOKEN).toBeCloseTo(1, 1)
    expect(f.points).toBe(3)
  })

  test("the reason states what it learned, in a form a human can check", () => {
    expect(fitCost([reading(65536), reading(262144)]).reason).toContain("bytes per token")
  })
})

describe("refusing to guess — the safety half", () => {
  test("no readings → cost 0 and an instruction to load small and measure", () => {
    const f = fitCost([])
    expect(f.bytesPerToken).toBe(0)
    expect(f.reason).toContain("load at the serving default")
  })

  test("ONE reading cannot separate weights from cache, and does not pretend to", () => {
    const f = fitCost([reading(262144)])
    expect(f.bytesPerToken).toBe(0)
    expect(f.reason).toContain("single point")
  })

  test("two readings at the same window are one point twice — refused", () => {
    const f = fitCost([reading(262144), reading(262144 + MIN_WINDOW_SPREAD - 1)])
    expect(f.bytesPerToken).toBe(0)
    expect(f.reason).toContain("same window")
  })

  test("readings that fall rather than rise are rejected, not fitted", () => {
    // Memory was moving under us; a negative slope would otherwise produce a nonsense load command.
    const f = fitCost([
      { windowTokens: 65536, totalBytes: 30 * GIB },
      { windowTokens: 262144, totalBytes: 25 * GIB },
    ])
    expect(f.bytesPerToken).toBe(0)
    expect(f.reason).toContain("rising line")
  })

  test("malformed input never throws", () => {
    expect(() => fitCost(undefined as any)).not.toThrow()
    expect(fitCost([{} as any]).bytesPerToken).toBe(0)
  })
})

describe("keeping the readings useful", () => {
  test("a new reading at a known window REPLACES it — the newest is the truest", () => {
    const kept = addObservation([reading(262144)], { windowTokens: 262144, totalBytes: 99 * GIB })
    expect(kept.length).toBe(1)
    expect(kept[0].totalBytes / GIB).toBe(99)
  })

  test("readings at different windows accumulate — that spread IS the information", () => {
    let obs: Observation[] = []
    for (const w of [16384, 65536, 131072, 262144]) obs = addObservation(obs, reading(w))
    expect(obs.length).toBe(4)
    expect(fitCost(obs).bytesPerToken).toBeGreaterThan(0)
  })

  test("trimming keeps the extremes, because the ends are what determine the line", () => {
    let obs: Observation[] = []
    for (const w of [8192, 16384, 32768, 65536, 98304, 131072, 163840, 196608, 262144]) {
      obs = addObservation(obs, reading(w), 4)
    }
    expect(obs.length).toBe(4)
    expect(Math.min(...obs.map((o) => o.windowTokens))).toBe(8192)
    expect(Math.max(...obs.map((o) => o.windowTokens))).toBe(262144)
    expect(fitCost(obs).bytesPerToken).toBe(Math.round(PER_TOKEN))
  })

  test("a junk reading is dropped, not stored", () => {
    expect(addObservation([], { windowTokens: 0, totalBytes: 5 } as any).length).toBe(0)
  })
})

describe("breaking the cold-start deadlock", () => {
  const FREE = 18 * GIB

  test("one reading yields a second window to measure at — the deadlock is what this exists for", () => {
    expect(safeSecondWindow(reading(32768), FREE, 262144)).toBe(65536)
  })

  test("no headroom → no step; the runtime would refuse anyway and a load costs seconds", () => {
    expect(safeSecondWindow(reading(32768), 0, 262144)).toBe(0)
  })

  test("the step never exceeds the model's own maximum", () => {
    expect(safeSecondWindow(reading(200000), FREE, 262144)).toBe(262144)
  })

  test("already at the maximum → no step, because there is nowhere to move to", () => {
    expect(safeSecondWindow(reading(262144), FREE, 262144)).toBe(0)
  })

  test("the second reading completes the line — measured with a machine-wide baseline, which the slope ignores", () => {
    const BASE = 9.4 * GIB // whatever else the Mac was holding; a constant, and a slope is blind to it
    const first = { windowTokens: 32768, totalBytes: BASE + WEIGHTS + 32768 * PER_TOKEN }
    const w2 = safeSecondWindow(first, FREE, 262144)
    const second = { windowTokens: w2, totalBytes: BASE + WEIGHTS + w2 * PER_TOKEN }
    expect(fitCost([first, second]).bytesPerToken).toBe(Math.round(PER_TOKEN))
  })

  test("malformed input never throws", () => {
    expect(() => safeSecondWindow(undefined as any, FREE, 262144)).not.toThrow()
    expect(safeSecondWindow({} as any, FREE, 262144)).toBe(0)
  })
})

// ── Request-time cache readings (measured 2026-07-26) ────────────────────────
// The load-time model assumes machine memory after a load carries a `W · bytesPerToken` term. On a
// runtime that allocates the cache lazily it does not, which is why three real readings fitted a
// NEGATIVE slope and the fit refused forever. These samples watch the cache where it actually appears.
describe("fitCostFromSamples", () => {
  // The two real readings from this machine: wired-memory delta across a prefill of known size.
  const REAL = [
    { contextTokens: 60_332, kvBytes: Math.round(5.42 * 1024 ** 3) },
    { contextTokens: 131_021, kvBytes: Math.round(12.59 * 1024 ** 3) },
  ]

  test("no readings refuses, and says one request is enough", () => {
    const fit = fitCostFromSamples([])
    expect(fit.bytesPerToken).toBe(0)
    expect(fit.reason).toContain("one real request")
  })

  test("ONE reading already determines the cost — no cold-start deadlock", () => {
    const fit = fitCostFromSamples([REAL[1]])
    expect(fit.points).toBe(1)
    expect(fit.bytesPerToken).toBeGreaterThan(90_000)
    expect(fit.bytesPerToken).toBeLessThan(120_000)
  })

  test("the real pair lands on the measured cost", () => {
    const fit = fitCostFromSamples(REAL)
    expect(fit.bytesPerToken).toBeGreaterThan(95_000)
    expect(fit.bytesPerToken).toBeLessThan(115_000)
    expect(fit.reason).toContain("bytes per token")
  })

  test("it fits through the origin — no invented intercept to drag the slope", () => {
    expect(fitCostFromSamples(REAL).weightsBytes).toBe(0)
  })

  test("the learned cost is far above what the load-time path had recorded", () => {
    // The store held 65 754 B/token; the machine actually charges ~40% more, which is why a window
    // planned on the old figure did not fit.
    expect(fitCostFromSamples(REAL).bytesPerToken).toBeGreaterThan(65_754 * 1.3)
  })

  test("readings that disagree badly are refused, not averaged into confidence", () => {
    const fit = fitCostFromSamples([
      { contextTokens: 60_000, kvBytes: 1024 ** 3 },
      { contextTokens: 60_000, kvBytes: 8 * 1024 ** 3 },
    ])
    expect(fit.bytesPerToken).toBe(0)
    expect(fit.reason).toContain("disagree")
  })

  test("a reading taken over too small a context is discarded, not believed", () => {
    // The real defect: a calibration at 8 207 tokens reported 470 013 B/token because the cache it
    // allocated was smaller than the memory the rest of the machine moved while it ran.
    const fit = fitCostFromSamples([{ contextTokens: 8_207, kvBytes: Math.round(3.59 * 1024 ** 3) }])
    expect(fit.bytesPerToken).toBe(0)
    expect(fit.reason).toContain("drift")
  })

  test("a small reading cannot drag a good one off course", () => {
    const good = { contextTokens: 131_021, kvBytes: Math.round(12.59 * 1024 ** 3) }
    const alone = fitCostFromSamples([good]).bytesPerToken
    const withNoise = fitCostFromSamples([{ contextTokens: 8_207, kvBytes: Math.round(3.59 * 1024 ** 3) }, good])
    expect(withNoise.bytesPerToken).toBe(alone)
  })

  test("junk readings are dropped rather than fitted", () => {
    expect(fitCostFromSamples([{ contextTokens: 0, kvBytes: 5 }] as any).bytesPerToken).toBe(0)
    expect(fitCostFromSamples([{ contextTokens: 100, kvBytes: -5 }] as any).bytesPerToken).toBe(0)
  })

  test("the load-time path is untouched and still refuses the real falling readings", () => {
    // Verbatim from ~/.local/share/fabula/kvcost.json on 2026-07-26.
    const fit = fitCost([
      { windowTokens: 65_536, totalBytes: 22_776_954_880 },
      { windowTokens: 131_072, totalBytes: 17_828_118_528 },
      { windowTokens: 262_144, totalBytes: 11_840_831_488 },
    ])
    expect(fit.bytesPerToken).toBe(0)
    expect(fit.reason).toContain("rising line")
  })
})

// ── The marginal, which is what the calibration actually rests on ────────────
describe("marginalCost", () => {
  const G = 1024 ** 3
  test("a warm pool cancels: the same constant in both readings does not change the answer", () => {
    // The measured failure it exists for: a pool serves both readings, so an ABSOLUTE reading reports
    // the pool plus the cache and lands far off, while the difference recovers the true per-token cost.
    const PER = 100_000, POOL = 5 * G
    const a = { tokens: 40_000, bytes: POOL + 40_000 * PER }
    const b = { tokens: 90_000, bytes: POOL + 90_000 * PER }
    expect(marginalCost(a, b).bytesPerToken).toBe(PER)
    // …and the pool size is irrelevant: double it, same answer.
    const a2 = { tokens: 40_000, bytes: 2 * POOL + 40_000 * PER }
    const b2 = { tokens: 90_000, bytes: 2 * POOL + 90_000 * PER }
    expect(marginalCost(a2, b2).bytesPerToken).toBe(PER)
  })

  test("the real numbers from this machine come back", () => {
    // Ornith, measured 2026-07-31: 6.09 GiB over 50 391 extra tokens.
    const r = marginalCost({ tokens: 20_000, bytes: 2 * G }, { tokens: 70_391, bytes: Math.round(2 * G + 6.09 * G) })
    expect(r.bytesPerToken).toBeGreaterThan(125_000)
    expect(r.bytesPerToken).toBeLessThan(135_000)
  })

  test("order does not matter — the caller may hand them over either way", () => {
    const a = { tokens: 40_000, bytes: 1 * G }, b = { tokens: 90_000, bytes: 6 * G }
    expect(marginalCost(a, b).bytesPerToken).toBe(marginalCost(b, a).bytesPerToken)
  })

  test("readings too close together are refused: that gap measures drift, not cache", () => {
    const r = marginalCost({ tokens: 60_000, bytes: 7 * G }, { tokens: 61_000, bytes: 7.1 * G })
    expect(r.bytesPerToken).toBe(0)
    expect(r.reason).toContain("floor")
  })

  test("a larger context that allocated nothing more says nothing, and admits it", () => {
    const r = marginalCost({ tokens: 40_000, bytes: 6 * G }, { tokens: 90_000, bytes: 6 * G })
    expect(r.bytesPerToken).toBe(0)
    expect(r.reason).toContain("no more memory")
  })

  test("a SHRINKING reading is refused rather than turned into a negative cost", () => {
    const r = marginalCost({ tokens: 40_000, bytes: 8 * G }, { tokens: 90_000, bytes: 6 * G })
    expect(r.bytesPerToken).toBe(0)
  })
})
