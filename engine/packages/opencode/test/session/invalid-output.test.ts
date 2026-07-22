import { describe, expect, test } from "bun:test"
import { decideInvalidContinuation, isProductiveStep, reasoningSignature } from "../../src/session/invalid-output"

/**
 * Measured defect (ses_079ede1e4ffe…, 2026-07-21): a reasoning model on a heavy post-compaction
 * context produced turns that were reasoning-only (no final text, no tool call) — classified
 * think-only. The auto-continue counter was a run-lifetime tally with a hard cap of 2 and NO reset
 * on progress, so two think-only turns ANYWHERE in a long task — even with real tool work between
 * them (chapters read) — tripped InvalidOutputError and killed the run. For a reasoning model a
 * reasoning-only intermediate turn is a normal phase, not a failure.
 *
 * The bound is now progress-aware: a think-only turn whose reasoning CHANGED (the model is moving
 * toward an action) does not spend the soft budget; only a repeated/identical reasoning (a genuine
 * stall) does. An absolute hardLimit still guarantees termination (W4 re-entry bound).
 */

describe("reasoningSignature", () => {
  test("normalizes whitespace and joins reasoning parts, ignoring non-reasoning + synthetic", () => {
    const sig = reasoningSignature([
      { type: "reasoning", text: "  Let me\n\n  think   about   this  " },
      { type: "text", text: "final answer" },
      { type: "reasoning", text: "step two", synthetic: true },
    ])
    expect(sig).toBe("Let me think about this")
  })
  test("empty when no real reasoning parts", () => {
    expect(reasoningSignature([{ type: "text", text: "hi" }])).toBe("")
  })
})

describe("isProductiveStep", () => {
  test("a tool part is productive", () => {
    expect(isProductiveStep([{ type: "step-start" }, { type: "tool" }, { type: "step-finish" }])).toBe(true)
  })
  test("a non-empty non-synthetic text is productive", () => {
    expect(isProductiveStep([{ type: "text", text: "  done  " }])).toBe(true)
  })
  test("reasoning-only / empty is NOT productive (the think-only step itself must not reset)", () => {
    expect(isProductiveStep([{ type: "step-start" }, { type: "reasoning", text: "hmm" }, { type: "step-finish" }])).toBe(
      false,
    )
    expect(isProductiveStep([{ type: "step-start" }, { type: "step-finish" }])).toBe(false)
  })
  test("a synthetic text (an injected nudge) is NOT productive", () => {
    expect(isProductiveStep([{ type: "text", text: "system reminder", synthetic: true }])).toBe(false)
  })
  test("whitespace-only text is NOT productive", () => {
    expect(isProductiveStep([{ type: "text", text: "   \n  " }])).toBe(false)
  })
})

describe("decideInvalidContinuation", () => {
  const base = { softLimit: 2, hardLimit: 12 }

  test("first stall proceeds and increments the stall streak", () => {
    expect(decideInvalidContinuation({ ...base, stalls: 0, total: 0, progressed: false })).toEqual({
      proceed: true,
      stalls: 1,
    })
  })
  test("soft limit bounds a repeated (non-progressing) stall — two stalls, then terminal", () => {
    // softLimit 2: stalls 0→proceed(1), 1→proceed(2), 2→terminal (matches the original 2-nudges-then-stop).
    expect(decideInvalidContinuation({ ...base, stalls: 1, total: 1, progressed: false })).toEqual({
      proceed: true,
      stalls: 2,
    })
    expect(decideInvalidContinuation({ ...base, stalls: 2, total: 2, progressed: false })).toEqual({
      proceed: false,
      stalls: 2,
    })
  })
  test("progressing reasoning RESETS the stall budget → keeps going past the soft limit", () => {
    // stalls was already at the soft limit, but the reasoning changed: reset to 0, proceed.
    expect(decideInvalidContinuation({ ...base, stalls: 2, total: 5, progressed: true })).toEqual({
      proceed: true,
      stalls: 0,
    })
  })
  test("progress does NOT bypass the absolute hard ceiling", () => {
    expect(decideInvalidContinuation({ ...base, stalls: 0, total: 12, progressed: true })).toEqual({
      proceed: false,
      stalls: 0,
    })
  })
  test("MEASURED CASE: a fresh think-only after a caller reset proceeds (no lifetime accumulation)", () => {
    // Real work between two think-only turns makes the caller reset stalls→0; the next stall proceeds
    // instead of tripping the old lifetime cap of 2.
    expect(decideInvalidContinuation({ ...base, stalls: 0, total: 0, progressed: false })).toEqual({
      proceed: true,
      stalls: 1,
    })
  })
  test("a run of DISTINCT reasoning is bounded only by hardLimit, never the soft one", () => {
    let stalls = 0
    let proceeded = 0
    for (let total = 0; total < 20; total++) {
      const d = decideInvalidContinuation({ ...base, stalls, total, progressed: true })
      if (!d.proceed) break
      stalls = d.stalls
      proceeded++
    }
    expect(proceeded).toBe(12) // exactly hardLimit turns of genuine progress, then stop
  })
})
