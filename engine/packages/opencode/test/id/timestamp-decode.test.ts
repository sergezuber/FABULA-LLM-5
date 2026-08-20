// `Identifier.timestamp` must invert `Identifier.create`.
//
// MEASURED DEFECT (2026-08-18, found by the full suite while verifying an unrelated change):
// `create` computes `timestamp * 0x1000 + counter` and packs it into SIX bytes. A millisecond
// timestamp of this era needs 41 bits, the product needs 53, and the top five were dropped in
// silence. The decoded value was therefore the true one modulo 2^36 ms (~2.18 years) — out by
// 1,786,706,395,136 ms on a fresh id.
//
// WHY IT SURVIVED, and what these tests are shaped to catch: a constant offset would be harmless to a
// comparison, and on most days it IS constant across the ids being compared. It stops being constant
// when two ids straddle a wrap — and then the OLDER one decodes as the newer. `Truncate.cleanup` is
// the only consumer, and it deletes anything whose decoded value is below a decoded cutoff, so on the
// days when a wrap fell inside the retention window it deleted spill files that were still live —
// exactly the files a truncated tool result tells the reader to open. A test written against "today"
// passes on most days; the straddle case below is constructed relative to the current wrap boundary,
// so it is decisive on every day.
import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"

const PERIOD = 2 ** 36 // 2^48 (the packed field) / 0x1000 (the counter multiplier)
const DAY = 86_400_000

describe("an ascending id decodes back to the millisecond it was made from", () => {
  test("round-trips exactly across the ages a retention policy cares about", () => {
    const now = Date.now()
    for (const age of [0, 1_000, DAY, 3 * DAY, 7 * DAY, 10 * DAY, 90 * DAY, 300 * DAY]) {
      const at = now - age
      expect(Identifier.timestamp(Identifier.create("tool", "ascending", at))).toBe(at)
    }
  })

  test("ORDER survives a wrap boundary — the case a constant offset hides", () => {
    // The most recent multiple of the period. Two ids one second either side of it have adjacent true
    // timestamps but remainders at opposite ends of the range, so a decoder that ignores the dropped
    // high bits reports the older one as newer.
    const boundary = Math.floor(Date.now() / PERIOD) * PERIOD
    const before = boundary - 1_000
    const after = boundary + 1_000
    expect(after).toBeLessThanOrEqual(Date.now())

    const decodedBefore = Identifier.timestamp(Identifier.create("tool", "ascending", before))
    const decodedAfter = Identifier.timestamp(Identifier.create("tool", "ascending", after))
    expect(decodedBefore).toBe(before)
    expect(decodedAfter).toBe(after)
    expect(decodedBefore).toBeLessThan(decodedAfter)
  })

  test("a retention comparison keeps the recent file and drops the old one", () => {
    // This is Truncate.cleanup's own arithmetic, in the shape that failed: a 7-day cutoff, a 3-day-old
    // file that must survive and a 10-day-old file that must not.
    const now = Date.now()
    const cutoff = Identifier.timestamp(Identifier.create("tool", "ascending", now - 7 * DAY))
    const recent = Identifier.timestamp(Identifier.create("tool", "ascending", now - 3 * DAY))
    const old = Identifier.timestamp(Identifier.create("tool", "ascending", now - 10 * DAY))
    expect(recent).toBeGreaterThanOrEqual(cutoff)
    expect(old).toBeLessThan(cutoff)
  })

  test("the id FORMAT is unchanged — decoding was repaired, not re-encoded", () => {
    // Ids are stored and sorted; re-encoding them would reorder existing data. Pin the shape so a
    // later 'fix' that widens the field has to be a deliberate decision.
    const id = Identifier.create("tool", "ascending", Date.now())
    expect(id.startsWith("tool_")).toBe(true)
    expect(id.slice("tool_".length, "tool_".length + 12)).toMatch(/^[0-9a-f]{12}$/)
  })

  test("the stated limit holds in the safe direction", () => {
    // An id older than a full period cannot be told from a recent one. It must read as RECENT, so a
    // very old file is KEPT rather than a live one deleted — the direction is the whole point.
    const ancient = Date.now() - PERIOD - 5 * DAY
    expect(Identifier.timestamp(Identifier.create("tool", "ascending", ancient))).toBeGreaterThan(ancient)
  })
})
