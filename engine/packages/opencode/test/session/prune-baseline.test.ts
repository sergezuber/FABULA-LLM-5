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
import { readFileSync } from "fs"
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

describe("the thresholds and the baseline must live in the SAME space", () => {
  // MEASURED BYPASS (2026-08-18). `defaultThresholdsFor` produces fractions of `usable()`, but the
  // baseline and the count it is compared against are RAW totals. Passing `usable()` as the room made
  // `baseline >= windowSize` true on the failing configuration (48,027 >= 29,632), so the rescale
  // returned the ABSOLUTE thresholds untouched and the largest of them (16,632) was crossed by the
  // prompt alone. That sets `maxCrossed`, and prompt.ts reads it as
  // `overflowCheck(...) || maxThresholdCrossed(...)` — so the compaction fix was bypassed entirely
  // and did nothing in production. The room has to be measured where the baseline lives.
  const CONTEXT = 69_632
  const USABLE = 29_632 // context − 20,000 output − 20,000 summary
  const BASELINE = 48_027 // smallest real turn total of the failing session
  const RESOLVED = resolveThresholds(defaultThresholdsFor(USABLE), USABLE)

  test("the defect: with one space the rescale degenerates and the prompt crosses the top threshold", () => {
    expect(rescaleAboveBaseline(RESOLVED, USABLE, BASELINE)).toEqual(RESOLVED)
    expect(BASELINE).toBeGreaterThanOrEqual(RESOLVED[RESOLVED.length - 1]!)
  })

  test("with the room measured where the baseline lives, nothing is crossed by the prompt", () => {
    const scaled = rescaleAboveBaseline(RESOLVED, USABLE, BASELINE, CONTEXT)
    for (const t of scaled) expect(t).toBeGreaterThan(BASELINE)
    expect(scaled[scaled.length - 1]!).toBeLessThan(CONTEXT)
  })

  test("prune passes the room window — the wiring, not just the rule", () => {
    // The pure function above is correct either way; what makes it reach production is the 4th
    // argument at the call site. Read it, so removing it fails here instead of in a live session.
    const src = readFileSync(new URL("../../src/session/prune.ts", import.meta.url), "utf8")
    const call = src.match(/rescaleAboveBaseline\(resolved,[^)]*\)/)
    expect(call).not.toBeNull()
    expect(call![0]).toContain("baselineWindow(input.model)")
  })
})
