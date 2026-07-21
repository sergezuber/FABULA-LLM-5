import { describe, expect, test } from "bun:test"
import { goalStopLayerFires, sessionShowsTaskEvidence, type ScanMessage } from "../../src/session/verify-gate"

/**
 * The conversational short-circuit of the goal stop-layer must be scoped to the SESSION,
 * not the current turn. Measured failure (2026-07-21, ses_079ede1e4ffe…): after an app
 * restart mid book-analysis, "продолжай" produced a single text-only announcement turn
 * ("Продолжаю чтение всех глав… затем читаю следующую партию") and the run stopped —
 * the turn made no tool calls, so the stop-layer classified a TASK session as a
 * conversation and honored the stop without ever consulting the judge.
 *
 * The structural line: a session that carries task evidence anywhere in the window —
 * an assistant turn that called tools, or a rebuild/checkpoint boundary (which only
 * exists because a task was in flight) — is a TASK session; its terminal stops must
 * reach the judge (bounded by MAX_GOAL_REACT + the hard-veto). A session with no task
 * evidence at all is a pure conversation and keeps the short-circuit (the Infinite
 * Agentic Loop case, arXiv:2607.01641).
 */

const user = (_text = "q"): ScanMessage => ({ role: "user", parts: [{ type: "text" }] })
const userCheckpoint = (): ScanMessage => ({ role: "user", parts: [{ type: "checkpoint" }, { type: "text" }] })
const assistantText = (): ScanMessage => ({ role: "assistant", parts: [{ type: "text" }] })
const assistantTool = (tool = "read"): ScanMessage => ({
  role: "assistant",
  parts: [{ type: "tool", tool }, { type: "text" }],
})

describe("sessionShowsTaskEvidence", () => {
  test("pure chat window has no task evidence", () => {
    expect(sessionShowsTaskEvidence([user(), assistantText()])).toBe(false)
  })
  test("a tool call in ANY earlier turn is task evidence", () => {
    expect(sessionShowsTaskEvidence([user(), assistantTool(), user(), assistantText()])).toBe(true)
  })
  test("a rebuild/checkpoint boundary is task evidence by itself", () => {
    expect(sessionShowsTaskEvidence([userCheckpoint(), user(), assistantText()])).toBe(true)
  })
  test("a checkpoint-typed part on an ASSISTANT message is not a rebuild boundary", () => {
    const odd: ScanMessage = { role: "assistant", parts: [{ type: "checkpoint" }] }
    expect(sessionShowsTaskEvidence([user(), odd])).toBe(false)
  })
  test("a tool part is a witness only on an ASSISTANT message (role guard pinned)", () => {
    const odd: ScanMessage = { role: "user", parts: [{ type: "tool", tool: "read" }] }
    expect(sessionShowsTaskEvidence([odd, assistantText()])).toBe(false)
  })
  test("a checkpoint part on a role that is neither user nor assistant is not a witness", () => {
    const odd: ScanMessage = { role: "system", parts: [{ type: "checkpoint" }] }
    expect(sessionShowsTaskEvidence([odd, assistantText()])).toBe(false)
  })
})

describe("goalStopLayerFires — session-scoped conversation test", () => {
  test("MEASURED CASE: restart + continue announcement in a session with prior tool work must reach the judge", () => {
    // [old task turns with tools] … [user «продолжай»] [text-only announcement]
    const messages = [user("task"), assistantTool(), assistantTool(), user("продолжай"), assistantText()]
    expect(goalStopLayerFires({ auto: true, messages })).toBe(false)
  })
  test("announcement right after a rebuild boundary must reach the judge even with no tool part in window", () => {
    const messages = [userCheckpoint(), user("продолжай"), assistantText()]
    expect(goalStopLayerFires({ auto: true, messages })).toBe(false)
  })
  test("pure conversational session keeps the short-circuit (IAL regression guard)", () => {
    const messages = [user("почему небо синее?"), assistantText()]
    expect(goalStopLayerFires({ auto: true, messages })).toBe(true)
  })
  test("explicit /goal is never short-circuited, task session or not", () => {
    expect(goalStopLayerFires({ auto: false, messages: [user(), assistantText()] })).toBe(false)
  })
  test("current turn actively calling tools never short-circuits (unchanged contract)", () => {
    const messages = [user(), assistantTool()]
    expect(goalStopLayerFires({ auto: true, messages })).toBe(false)
  })
})
