// The post-compaction stall detector: work in flight before the boundary must not silently become a stop.
//
// Measured live (2026-07-21): mid-task compaction, then a text-only reply announcing next steps
// ("now I'll move on to the chapters") — and the session ended without doing the work, because a book
// folder has no verify command, so the auto-goal gate is deliberately never armed and no other
// continuation contract keys on a pure announcement. The rule is structural: tool calls before the
// summary, none after — no language matching, no tuned numbers.
import { describe, test, expect } from "bun:test"
import { postCompactionStall } from "../../src/session/verify-gate"

const user = () => ({ role: "user", parts: [{ type: "text" }] })
const work = () => ({ role: "assistant", finished: true, parts: [{ type: "text" }, { type: "tool" }] })
const summary = () => ({ role: "assistant", finished: true, summary: true, parts: [{ type: "text" }] })
const announce = () => ({ role: "assistant", finished: true, parts: [{ type: "text" }] })

describe("postCompactionStall", () => {
  test("THE measured case: work → summary → text-only announcement = stall", () => {
    expect(postCompactionStall([user(), work(), summary(), announce()])).toBe(true)
  })

  test("real work after the boundary is never flagged", () => {
    expect(postCompactionStall([user(), work(), summary(), work()])).toBe(false)
  })

  test("an ordinary text-only stop with NO boundary is not a stall (conversational turns stay free)", () => {
    expect(postCompactionStall([user(), announce()])).toBe(false)
    expect(postCompactionStall([user(), work(), announce()])).toBe(false)
  })

  test("a second post-boundary turn is an ordinary stop — only the FIRST is guarded", () => {
    // after the boundary: one working turn, then a text-only stop → the nearest finished assistant
    // before the current is the WORK turn, not the summary → no stall
    expect(postCompactionStall([user(), work(), summary(), work(), announce()])).toBe(false)
  })

  test("no work in flight before the boundary → a text-only reply is a legitimate stop", () => {
    // e.g. compaction fired on a conversational session: nothing was interrupted
    expect(postCompactionStall([user(), announce(), summary(), announce()])).toBe(false)
  })

  test("the summary itself ending the turn is not a stall", () => {
    expect(postCompactionStall([user(), work(), summary()])).toBe(false)
  })

  test("two working steps then a text-only stop, NO summary anywhere — never a stall", () => {
    // Pins the boundary requirement itself: without it, any work→work→announce sequence would fire.
    // A mutation dropping the summary check escaped the other cases because their message shapes
    // coincidentally cancelled out; this one isolates the condition.
    expect(postCompactionStall([user(), work(), work(), announce()])).toBe(false)
  })

  test("degenerate inputs never throw and never fire", () => {
    expect(postCompactionStall([])).toBe(false)
    expect(postCompactionStall([user()])).toBe(false)
  })
})
