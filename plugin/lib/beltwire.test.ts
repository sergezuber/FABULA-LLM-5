// Durable guards for the per-session belt channel's bound.
//
// This file exists because the SAME rule lived in two modules and only one of them was corrected. The
// engine's `session/belt.ts stashShadow()` was given least-recently-used eviction in an earlier wave,
// after measuring that plain insertion order drops the session being written on every turn: a plain `set`
// leaves an existing key where it was FIRST inserted, so the busiest session stays the oldest key forever
// and the next other session's write evicts it. `capChannel` here kept insertion order — and its comment
// argued FOR it, in the words the engine copy had already disproved.
//
// Measured on this channel before the correction: the actively used session was dropped once across 60
// interleaved writes; zero times after. Small, but it is a live session losing its tool-visibility state
// mid-run, and the fix costs one line.
import { test, expect, afterEach } from "bun:test"
import { beltChannel, setBeltEntry, dropSessionChannels } from "./beltwire"

const entry = () => ({ hide: [], hideGlobs: [] }) as any
const mine: string[] = []
const put = (id: string) => {
  mine.push(id)
  setBeltEntry(id, entry())
}
afterEach(() => {
  for (const id of mine.splice(0)) dropSessionChannels(id)
})

test("the channel stays bounded however many sessions pass through", () => {
  for (let i = 0; i < 200; i++) put(`belt_cap_${i}`)
  expect(beltChannel().size).toBeLessThanOrEqual(64)
})

test("an ACTIVELY USED session is never the one evicted", () => {
  // The property the engine copy was corrected for, asserted INSIDE the loop: by the end the busy session
  // has simply been re-stamped, so a final-state check would pass against both orders and prove nothing.
  const busy = "belt_busy"
  mine.push(busy)
  for (let i = 0; i < 80; i++) {
    setBeltEntry(busy, entry())
    put(`belt_churn_${i}`)
    expect(beltChannel().has(busy)).toBe(true)
  }
  // …and the quiet old ones were still released, or the cap is not doing its job
  expect(beltChannel().has("belt_churn_0")).toBe(false)
})

test("the newest sessions stay addressable", () => {
  for (let i = 0; i < 100; i++) put(`belt_recent_${i}`)
  expect(beltChannel().has("belt_recent_99")).toBe(true)
  expect(beltChannel().has("belt_recent_0")).toBe(false)
})

test("dropping a session removes it from the channel", () => {
  put("belt_dropme")
  expect(beltChannel().has("belt_dropme")).toBe(true)
  dropSessionChannels("belt_dropme")
  expect(beltChannel().has("belt_dropme")).toBe(false)
})

test("re-stamping the same session does not grow the channel", () => {
  const before = beltChannel().size
  put("belt_same")
  for (let i = 0; i < 50; i++) setBeltEntry("belt_same", entry())
  expect(beltChannel().size).toBe(before + 1)
})
