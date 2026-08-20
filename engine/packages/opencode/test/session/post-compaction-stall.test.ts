// The post-compaction stall detector: work in flight before the boundary must not silently become a stop.
//
// Measured live (2026-07-21): mid-task compaction, then a text-only reply announcing next steps
// ("now I'll move on to the chapters") — and the session ended without doing the work, because a book
// folder has no verify command, so the auto-goal gate is deliberately never armed and no other
// continuation contract keys on a pure announcement. The rule is structural: tool calls before the
// summary, none after — no language matching, no tuned numbers.
import { describe, test, expect } from "bun:test"
import { postCompactionStall } from "../../src/session/verify-gate"
import { priorWorkBeforeWindow } from "../../src/session/message-v2"
import { readFileSync } from "node:fs"

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

  test("the REBUILD boundary is guarded exactly like the summary — the audit-found hole", () => {
    // The checkpoint part carries no synthetic flag, so isRealUserBoundary calls the rebuild message a
    // REAL turn start; the segment resets tool-free and a text-only announcement right after a rebuild
    // passed the narrowed stop-layer. Same failure, different door.
    const rebuild = () => ({ role: "user", parts: [{ type: "checkpoint" }, { type: "text" }] })
    expect(postCompactionStall([user(), work(), rebuild(), announce()])).toBe(true)
    // real work after the rebuild → never flagged
    expect(postCompactionStall([user(), work(), rebuild(), work()])).toBe(false)
    // rebuild with NO work before it (fresh session) → an announcement is a legitimate answer
    expect(postCompactionStall([user(), announce(), rebuild(), announce()])).toBe(false)
    // a finished assistant BETWEEN the rebuild and now → ordinary stop, not the first post-boundary turn
    expect(postCompactionStall([user(), work(), rebuild(), work(), announce()])).toBe(false)
  })

  // MEASURED 2026-08-20 (ses_fe1fdd928ffe…). The engine folds an oversized head into N passes and writes
  // N summary messages: "head is ~42850 tokens against a 25536 budget — folding into 3 passes". Walking
  // back exactly one assistant message from the boundary then lands on ANOTHER summary, so the detector
  // reported "no work was in flight" and a task that had not started ended on an announcement.
  test("MEASURED: an oversized head folded into 3 passes still finds the work behind the summaries", () => {
    expect(postCompactionStall([user(), work(), summary(), summary(), summary(), announce()])).toBe(true)
  })

  test("the fold does not INVENT work: three summaries with nothing before them is a legitimate stop", () => {
    expect(postCompactionStall([user(), summary(), summary(), summary(), announce()])).toBe(false)
  })

  test("a fold of two passes is guarded exactly like a fold of three", () => {
    expect(postCompactionStall([user(), work(), summary(), summary(), announce()])).toBe(true)
  })

  // ── THE PRODUCTION SHAPE ────────────────────────────────────────────────────────────────────────
  // Every case above hands the detector a list that CONTAINS the work turn. Production does not: the
  // caller passes the live window, and filterCompacted starts that window AT the boundary — so the work
  // is outside it by construction and the detector answered false for every real session. Measured
  // 2026-08-20 by replaying a real 2-pass fold (ses_fe1e0215cffe…): the window was
  // user[compaction] → summary → summary → …, with the ten reading turns all behind the boundary.
  const boundary = () => ({ role: "user", parts: [{ type: "compaction" }] })

  test("PRODUCTION: a window that begins at the boundary, with work behind it, is a stall", () => {
    expect(postCompactionStall([boundary(), summary(), summary(), announce()], true)).toBe(true)
  })

  test("PRODUCTION: no work behind the boundary → no stall (a chat that merely grew is left alone)", () => {
    expect(postCompactionStall([boundary(), summary(), summary(), announce()], false)).toBe(false)
  })

  test("a caller that supplies no history gets the OLD answer — a missing past never invents a stall", () => {
    expect(postCompactionStall([boundary(), summary(), summary(), announce()])).toBe(false)
  })

  test("PRODUCTION: real work after the boundary is still never flagged, history or not", () => {
    expect(postCompactionStall([boundary(), summary(), summary(), work()], true)).toBe(false)
  })

  describe("priorWorkBeforeWindow — the one message the window cannot hold", () => {
    // the engine's stream is NEWEST-FIRST; filterCompacted iterates it the same way
    const m = (role: string, parts: string[], extra: object = {}) => ({
      info: { role, ...extra },
      parts: parts.map((type) => ({ type })),
    })
    test("the step immediately before the boundary used tools", () => {
      expect(
        priorWorkBeforeWindow([
          m("assistant", ["text"]),
          m("user", ["compaction"]),
          m("assistant", ["text", "tool"]),
          m("user", ["text"]),
        ] as any),
      ).toBe(true)
    })
    // A fold writes its summaries as ordinary assistant messages, and one of them can sit between the
    // boundary and the work. Answering "the nearest assistant" would report a summary's own emptiness as
    // the absence of work — so the answer must look THROUGH them. Written this way deliberately: an
    // earlier version put a tool-free turn behind the summary, where skipping and not skipping give the
    // same answer, and the case could not fail however the code was written.
    test("a summary between the boundary and the work is looked through, not answered from", () => {
      expect(
        priorWorkBeforeWindow([
          m("user", ["compaction"]),
          m("assistant", ["text"], { summary: true }),
          m("assistant", ["text", "tool"]),
        ] as any),
      ).toBe(true)
    })

    test("a genuinely tool-free step before the boundary is not work", () => {
      expect(
        priorWorkBeforeWindow([m("user", ["compaction"]), m("assistant", ["text"])] as any),
      ).toBe(false)
    })
    test("no boundary at all → nothing to be before", () => {
      expect(priorWorkBeforeWindow([m("assistant", ["text", "tool"]), m("user", ["text"])] as any)).toBe(false)
    })
    test("it stops AT that message — the rest of the session is never read", () => {
      let read = 0
      function* lazy() {
        for (const x of [
          m("user", ["compaction"]),
          m("assistant", ["text", "tool"]),
          m("assistant", ["text", "tool"]),
        ]) {
          read++
          yield x
        }
      }
      expect(priorWorkBeforeWindow(lazy() as any)).toBe(true)
      expect(read).toBe(2)
    })
  })

  test("degenerate inputs never throw and never fire", () => {
    expect(postCompactionStall([])).toBe(false)
    expect(postCompactionStall([user()])).toBe(false)
  })
})

// ── THE WIRING, read from the source ───────────────────────────────────────────────────────────────
// The detector shipped unreachable and nothing noticed, because a pure test hands it a list the caller
// never builds. Every case above would stay green against a caller that drops the history argument, so
// the caller itself is asserted here — the same source-reading form used for the overflow baseline.
describe("the production caller supplies the history", () => {
  const src = readFileSync(new URL("../../src/session/prompt.ts", import.meta.url), "utf8")
  const call = src.slice(src.indexOf("postCompactionStall("))
  const body = call.slice(0, call.indexOf("postCompactionContinued = true"))

  test("postCompactionStall is called with the pre-boundary answer, not the window alone", () => {
    expect(body).toContain("priorWorkBeforeWindowFor")
  })

  test("the answer is asked for THIS session and THIS slice", () => {
    expect(body).toMatch(/priorWorkBeforeWindowFor\(\s*sessionID\s*,\s*agentID/)
  })

  // Without a guard the read answers false by walking the WHOLE session, on every finish, for every
  // session that has never compacted — which is most of them. The window starts at a boundary whenever
  // the session has one, so the head of the window is the cheap question to ask first.
  test("the history is read only when the window actually begins at a boundary", () => {
    expect(body).toMatch(/msgs\[0\][\s\S]{0,200}isContextBoundaryPart[\s\S]{0,200}priorWorkBeforeWindowFor/)
  })
})
