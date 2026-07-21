// Checkpoint thresholds must measure the CONVERSATION, not the prompt.
//
// Measured on this project's build: the first assistant turn already costs 40,291 tokens against a
// 131,072 window — 30.7% of it — while the default first threshold is 20% (26,214). Every session
// therefore fired a checkpoint before any work existed, spawning a full model run to summarise a
// conversation of one user message. That is pure waste on every session, and on the session that
// prompted this it was one of fifteen writer spawns in 48 minutes.
//
// The numbers below are the REAL measured ones, not invented fixtures.
import { describe, test, expect } from "bun:test"
import { rescaleAboveBaseline, resolveThresholds, defaultThresholdsFor } from "../../src/session/prune"

const WINDOW = 131_072
const MEASURED_PREFIX = 40_291 // first assistant turn, measured live
const DEFAULTS = resolveThresholds(defaultThresholdsFor(WINDOW), WINDOW)

describe("thresholds are measured against the room the conversation actually has", () => {
  test("the defect: the prompt alone crosses the first default threshold", () => {
    // This is the state of the world the change exists to correct.
    expect(DEFAULTS[0]).toBeLessThan(MEASURED_PREFIX)
  })

  test("after rescaling, the prompt alone no longer crosses anything", () => {
    const scaled = rescaleAboveBaseline(DEFAULTS, WINDOW, MEASURED_PREFIX)
    for (const t of scaled) expect(t).toBeGreaterThan(MEASURED_PREFIX)
  })

  test("the LAST threshold still lands inside the window — the property naive subtraction destroys", () => {
    // Subtracting the baseline outright would put the final save at baseline + 0.8·window = 145,148,
    // i.e. past the window: the rescue that exists to run BEFORE overflow would run after it.
    const naive = DEFAULTS.map((t) => MEASURED_PREFIX + t)
    expect(naive[naive.length - 1]).toBeGreaterThan(WINDOW) // the trap, asserted so it cannot creep back

    const scaled = rescaleAboveBaseline(DEFAULTS, WINDOW, MEASURED_PREFIX)
    expect(scaled[scaled.length - 1]).toBeLessThan(WINDOW)
  })

  test("order and count are preserved; every threshold stays strictly ordered", () => {
    const scaled = rescaleAboveBaseline(DEFAULTS, WINDOW, MEASURED_PREFIX)
    expect(scaled.length).toBe(DEFAULTS.length)
    for (let i = 1; i < scaled.length; i++) expect(scaled[i]).toBeGreaterThan(scaled[i - 1])
  })

  test("fractions keep their meaning relative to the available room", () => {
    const scaled = rescaleAboveBaseline(DEFAULTS, WINDOW, MEASURED_PREFIX)
    const room = WINDOW - MEASURED_PREFIX
    // 20% of the room above the prefix
    expect(scaled[0]).toBe(Math.round(MEASURED_PREFIX + 0.2 * room))
    expect(scaled[scaled.length - 1]).toBe(Math.round(MEASURED_PREFIX + (DEFAULTS[3] / WINDOW) * room))
  })

  test("CONTROL: a negligible prompt leaves the thresholds essentially untouched", () => {
    // Nothing is being tuned for this project's prompt size — a small prefix means a small correction.
    const scaled = rescaleAboveBaseline(DEFAULTS, WINDOW, 100)
    for (let i = 0; i < scaled.length; i++) expect(Math.abs(scaled[i] - DEFAULTS[i])).toBeLessThan(200)
  })

  test("CONTROL: degenerate baselines degrade to the previous behaviour, never to nonsense", () => {
    expect(rescaleAboveBaseline(DEFAULTS, WINDOW, 0)).toEqual(DEFAULTS)
    expect(rescaleAboveBaseline(DEFAULTS, WINDOW, WINDOW)).toEqual(DEFAULTS)
    expect(rescaleAboveBaseline(DEFAULTS, WINDOW, WINDOW + 5_000)).toEqual(DEFAULTS)
    expect(rescaleAboveBaseline(DEFAULTS, 0, MEASURED_PREFIX)).toEqual(DEFAULTS)
  })

  test("it adapts to any prompt size — nothing here is tuned to one build", () => {
    // A leaner belt or a fatter prompt both re-derive: the correction tracks the measured baseline.
    for (const prefix of [5_000, 20_000, 40_291, 80_000, 120_000]) {
      const scaled = rescaleAboveBaseline(DEFAULTS, WINDOW, prefix)
      expect(scaled[0]).toBeGreaterThan(prefix)
      expect(scaled[scaled.length - 1]).toBeLessThan(WINDOW)
    }
  })
})
