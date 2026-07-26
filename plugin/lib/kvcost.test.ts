import { describe, expect, test } from "bun:test"
import { fitCost, addObservation, MIN_WINDOW_SPREAD, type Observation } from "./kvcost"

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
