import { describe, expect, test } from "bun:test"
import { foregroundBusy, waitExpired, MAX_WAIT_MS, POLL_MS } from "../../src/session/background-defer"

const busy = { type: "busy" }
const idle = { type: "idle" }

describe("foregroundBusy", () => {
  // The measured case: the user's turn is generating, and a pass is about to start on top of it.
  test("a generating user session counts as foreground", () => {
    expect(foregroundBusy([["ses_user", busy]], ["ses_dream"])).toBe(true)
  })

  test("a quiet machine lets the pass through", () => {
    expect(foregroundBusy([["ses_user", idle]], ["ses_dream"])).toBe(false)
  })

  test("the pass never waits on ITSELF — that wait would never end", () => {
    expect(foregroundBusy([["ses_dream", busy]], ["ses_dream"])).toBe(false)
  })

  test("nor on its sibling pass: dream and distill start together and must not deadlock each other", () => {
    expect(foregroundBusy([["ses_dream", busy], ["ses_distill", busy]], ["ses_dream", "ses_distill"])).toBe(false)
  })

  test("one busy foreground session among many idle ones is still a reason to wait", () => {
    expect(
      foregroundBusy([["a", idle], ["b", idle], ["c", busy], ["d", idle]], ["ses_dream"]),
    ).toBe(true)
  })

  test("an empty machine and malformed entries never throw", () => {
    expect(foregroundBusy([], [])).toBe(false)
    expect(foregroundBusy([["a", undefined as any]], [])).toBe(false)
  })
})

describe("waitExpired", () => {
  test("patience runs out at the deadline, not before", () => {
    expect(waitExpired(0)).toBe(false)
    expect(waitExpired(MAX_WAIT_MS - POLL_MS)).toBe(false)
    expect(waitExpired(MAX_WAIT_MS)).toBe(true)
  })

  test("the deadline is long enough for a real turn but not unbounded", () => {
    expect(MAX_WAIT_MS).toBeGreaterThanOrEqual(10 * 60_000)
    expect(Number.isFinite(MAX_WAIT_MS)).toBe(true)
  })
})

// The checkpoint writer, and the mistake that nearly shipped with it.
//
// The writer runs in its OWN CHILD session, and `busy` is set only for main agents — so a wait that
// excluded "its own session" would exclude the PARENT, which is the user's turn and the only thing worth
// waiting for. The draft did exactly that. These pin the shape, not the intention.
describe("waiting on behalf of the checkpoint writer", () => {
  const busy = { type: "busy" }
  const idle = { type: "idle" }

  test("the user's turn is seen, because nothing is excluded", () => {
    // parent = the user's session (busy); child = the writer's own (never marked busy)
    expect(foregroundBusy([["ses_parent", busy], ["ses_writer_child", idle]], [])).toBe(true)
  })

  test("excluding the parent would blind it — the bug that was caught before it shipped", () => {
    expect(foregroundBusy([["ses_parent", busy]], ["ses_parent"])).toBe(false)
  })

  test("once the user's turn ends the writer is free to run", () => {
    expect(foregroundBusy([["ses_parent", idle], ["ses_writer_child", idle]], [])).toBe(false)
  })

  test("a second user session still generating also holds it back", () => {
    expect(foregroundBusy([["ses_a", idle], ["ses_b", busy]], [])).toBe(true)
  })
})
