// The working point is measured on THIS machine, or declared unmeasured — never inherited.
//
// The property under test is the ORDER of answers and the honesty of the last one. A number that says
// "1" tells nobody whether that is a result, a decision, or a floor, and those call for three different
// responses from whoever reads it.

import { test, expect, describe } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  bestSlots,
  resolveSlots,
  describeSlots,
  recordSample,
  readSamples,
  concurrencyPath,
  MIN_CALLS_FOR_A_SAMPLE,
  MEANINGFUL_GAIN,
  type ConcurrencySample,
} from "./concurrency"

const HERE = "aaaaaaaaaaaaaaaa"
const ELSEWHERE = "bbbbbbbbbbbbbbbb"
const s = (slots: number, msPerCall: number, fingerprint = HERE, calls = 8): ConcurrencySample =>
  ({ fingerprint, slots, msPerCall, calls })

describe("what the samples can and cannot conclude", () => {
  test("one slot count measured is not a comparison", () => {
    expect(bestSlots([s(1, 100), s(1, 105)], HERE)).toBeNull()
  })

  test("samples from ANOTHER machine are not evidence about this one", () => {
    // The whole reason the fingerprint is carried: a fast host's answer applied here would provision
    // memory this machine does not have.
    expect(bestSlots([s(1, 100, ELSEWHERE), s(2, 40, ELSEWHERE)], HERE)).toBeNull()
  })

  test("a working point too thin to be evidence is not compared", () => {
    expect(bestSlots([s(1, 100, HERE, 1), s(2, 10, HERE, 1)], HERE)).toBeNull()
    expect(bestSlots([s(1, 100, HERE, MIN_CALLS_FOR_A_SAMPLE), s(2, 10, HERE, MIN_CALLS_FOR_A_SAMPLE)], HERE)).toBe(2)
  })

  test("calls accumulate ON THE POINT, however they arrived", () => {
    // The harness measures one real request at a time. Requiring a fat single reading would have made
    // its own free measurement permanently inadmissible, and the store would fill with evidence that
    // never counted.
    const ones = (slots: number, ms: number) => Array.from({ length: MIN_CALLS_FOR_A_SAMPLE }, () => s(slots, ms, HERE, 1))
    expect(bestSlots([...ones(1, 100), ...ones(2, 40)], HERE)).toBe(2)
    // …and one call short is still not a comparison.
    expect(bestSlots([...ones(1, 100), ...ones(2, 40).slice(1)], HERE)).toBeNull()
  })

  test("more slots must EARN the window: an equal answer loses", () => {
    // Equal speed at more slots is strictly worse — it costs window and buys nothing.
    expect(bestSlots([s(1, 100), s(2, 100)], HERE)).toBe(1)
    expect(bestSlots([s(1, 100), s(2, 95)], HERE)).toBe(1) // inside the noise band
    expect(bestSlots([s(1, 100), s(2, 100 * (1 - MEANINGFUL_GAIN) - 1)], HERE)).toBe(2)
  })

  test("the measured Mac answer reproduces: two slots SLOWER, so one wins", () => {
    // 48.4s against 41.9s for the same pair, because concurrent prefill degrades both.
    expect(bestSlots([s(1, 41_900), s(2, 48_400)], HERE)).toBe(1)
  })

  test("repeated measurements of one point are more evidence, not a new point", () => {
    // Three readings at one slot and one at two must still compare two points, averaging the three.
    expect(bestSlots([s(1, 100), s(1, 110), s(1, 90), s(2, 50)], HERE)).toBe(2)
  })
})

describe("who decided the number, and does it say so", () => {
  test("an explicit choice wins over everything, because it is a decision", () => {
    const r = resolveSlots({ envSlots: 4, samples: [s(1, 10), s(2, 1)], fingerprint: HERE })
    expect(r).toEqual({ slots: 4, source: "operator" })
  })

  test("a measurement on this machine beats the floor", () => {
    expect(resolveSlots({ samples: [s(1, 100), s(2, 40)], fingerprint: HERE }))
      .toEqual({ slots: 2, source: "measured" })
  })

  test("with nothing measured the answer is the floor, and it SAYS it is a floor", () => {
    const r = resolveSlots({ fingerprint: HERE })
    expect(r).toEqual({ slots: 1, source: "unmeasured-floor" })
    expect(describeSlots(r)).toContain("not measured here")
    // The distinction that matters to a reader: this 1 is not a result.
    expect(describeSlots({ slots: 1, source: "measured" })).toContain("measured on this machine")
    expect(describeSlots({ slots: 1, source: "operator" })).toContain("set explicitly")
  })

  test("unlimited at the gate is not a provisioning, and reads as the floor", () => {
    expect(resolveSlots({ envSlots: 0, fingerprint: HERE }).source).toBe("unmeasured-floor")
    expect(resolveSlots({ envSlots: Number.NaN, fingerprint: HERE }).source).toBe("unmeasured-floor")
  })
})

describe("the store keeps evidence and refuses anecdotes", () => {
  const withStore = <T>(fn: () => T): T => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fab-conc-"))
    const prev = process.env.FABULA_CONCURRENCY_FILE
    process.env.FABULA_CONCURRENCY_FILE = path.join(dir, "concurrency.json")
    try {
      return fn()
    } finally {
      if (prev === undefined) delete process.env.FABULA_CONCURRENCY_FILE
      else process.env.FABULA_CONCURRENCY_FILE = prev
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  test("a sample survives being written and read back", () => {
    withStore(() => {
      recordSample(s(2, 40))
      const back = readSamples()
      expect(back).toHaveLength(1)
      expect(back[0]!.slots).toBe(2)
    })
  })

  test("a reading is kept; a non-reading is refused", () => {
    withStore(() => {
      recordSample(s(2, 40, HERE, 1)) // a real single-call reading: kept, and counted at its point
      recordSample({ fingerprint: HERE, slots: 2, msPerCall: 0, calls: 99 })   // no duration: not a reading
      recordSample({ fingerprint: "", slots: 2, msPerCall: 10, calls: 9 })      // no machine: not about here
      expect(readSamples()).toHaveLength(1)
    })
  })

  test("an unreadable store is no evidence rather than bad evidence", () => {
    withStore(() => {
      fs.mkdirSync(path.dirname(concurrencyPath()), { recursive: true })
      fs.writeFileSync(concurrencyPath(), "{ not json")
      expect(readSamples()).toEqual([])
      expect(() => resolveSlots({ samples: readSamples(), fingerprint: HERE })).not.toThrow()
    })
  })
})
