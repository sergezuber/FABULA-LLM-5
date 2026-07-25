import { describe, expect, test } from "bun:test"
import { goalStopLayerFires, sessionShowsTaskEvidence, type ScanMessage , trajectoryFeatures, renderFeatureBlock} from "../../src/session/verify-gate"

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
  // CONTRACT SHARPENED 2026-07-25. This used to read "a turn calling tools never short-circuits", which
  // was a proxy for "do not stop mid-work" — and it is what re-entered a research turn that had already
  // delivered its answer. The precise statement is: a turn that did work and said NOTHING has not
  // answered; a turn that did work and then answered has.
  test("a turn that called tools and produced no text has not answered", () => {
    const messages = [user(), { role: "assistant" as const, parts: [{ type: "tool" as const, tool: "read" }] }]
    expect(goalStopLayerFires({ auto: true, messages })).toBe(false)
  })
  // ⚠️ This is the case that is NOT resolved: a turn that did work and then answered still reaches the
  // judge, because the identical shape also covers a turn that did work and reported it UNFINISHED
  // (2026-07-21). Asserted as it BEHAVES, so the gap stays visible instead of being wished away.
  test("a turn that called tools and then answered still reaches the judge — the open case", () => {
    expect(goalStopLayerFires({ auto: true, messages: [user(), assistantTool()] })).toBe(false)
  })
})

// The live over-fire (2026-07-25) is NOT closed by this layer, and these cases record why rather than
// asserting a behaviour that would reopen the 2026-07-21 one. See the comment on goalStopLayerFires.
describe("the two measured cases are structurally identical — recorded, not resolved", () => {
  const tool = (id: string) => ({ role: "assistant" as const, parts: [{ type: "tool" as const, tool: "read", id }] })
  const text = { role: "assistant" as const, parts: [{ type: "text" as const, text: "…" }] }
  const ask = { role: "user" as const, parts: [{ type: "text" as const }] }

  test("a delivered research answer and an unfinished reading report look the same to this layer", () => {
    const delivered = [ask, tool("1"), tool("2"), text]
    const unfinished = [ask, tool("1"), tool("2"), text]
    expect(goalStopLayerFires({ auto: true, messages: delivered as any })).toBe(
      goalStopLayerFires({ auto: true, messages: unfinished as any }),
    )
  })

  test("both reach the judge, which is the layer that CAN read the difference", () => {
    expect(goalStopLayerFires({ auto: true, messages: [ask, tool("1"), text] as any })).toBe(false)
  })

  test("an explicit /goal is never short-circuited", () => {
    expect(goalStopLayerFires({ auto: false, messages: [ask, text] as any })).toBe(false)
  })
})

// The difference the judge could not see. Both shapes are "tool calls, then text" — what separates them
// is whether the agent still HAS a move. A refused call says it does not.
describe("harnessBlocked — exhausted vs unfinished", () => {
  const ask = { role: "user" as const, parts: [{ type: "text" as const }] }
  const ok = (tool: string) => ({ role: "assistant" as const, parts: [{ type: "tool" as const, tool }] })
  const refused = (tool: string) => ({
    role: "assistant" as const,
    parts: [{ type: "tool" as const, tool, error: "[fabula-steer] LOOP BLOCKED: 16 distinct web searches" }],
  })
  const text = { role: "assistant" as const, parts: [{ type: "text" as const }] }

  test("a turn the harness refused is counted, and the judge is told repeating is unavailable", () => {
    const f = trajectoryFeatures([ask, ok("web_search"), refused("web_search"), text] as any)
    expect(f.harnessBlocked).toBe(1)
    expect(renderFeatureBlock(f)).toContain("REFUSED")
    expect(renderFeatureBlock(f)).toContain("cannot improve")
  })

  test("a reading turn whose tools all SUCCEEDED says nothing new — judged exactly as before", () => {
    const f = trajectoryFeatures([ask, ok("read"), ok("read"), ok("read"), text] as any)
    expect(f.harnessBlocked).toBe(0)
    expect(renderFeatureBlock(f)).not.toContain("REFUSED")
  })

  test("an ordinary tool failure is NOT a refusal — only the harness's own marker counts", () => {
    const broke = { role: "assistant" as const, parts: [{ type: "tool" as const, tool: "read", error: "ENOENT: no such file" }] }
    expect(trajectoryFeatures([ask, broke, text] as any).harnessBlocked).toBe(0)
  })

  test("the count resets at a real user boundary — it describes THIS turn", () => {
    const f = trajectoryFeatures([ask, refused("web_search"), text, ask, ok("read"), text] as any)
    expect(f.harnessBlocked).toBe(0)
  })

  test("the signal does not depend on answer length or context size", () => {
    const short = [ask, refused("web_search"), { role: "assistant" as const, parts: [{ type: "text" as const, text: "no" }] }]
    const long = [ask, refused("web_search"), { role: "assistant" as const, parts: [{ type: "text" as const, text: "x".repeat(80_000) }] }]
    expect(trajectoryFeatures(short as any).harnessBlocked).toBe(trajectoryFeatures(long as any).harnessBlocked)
  })
})

// Measured on the live app: even a turn that delivered its answer showed gate {"g":"goal","fired":1} —
// the judge sent it back. When the harness itself has refused further calls there is nothing left to buy.
describe("an exhausted turn ends", () => {
  const ask = { role: "user" as const, parts: [{ type: "text" as const }] }
  const ok = (t: string) => ({ role: "assistant" as const, parts: [{ type: "tool" as const, tool: t }] })
  const refused = { role: "assistant" as const, parts: [{ type: "tool" as const, tool: "web_search", error: "[fabula-steer] LOOP BLOCKED: budget" }] }
  const text = { role: "assistant" as const, parts: [{ type: "text" as const, text: "here is what I found" }] }

  test("searched, was REFUSED, then answered → the stop is honored", () => {
    expect(goalStopLayerFires({ auto: true, messages: [ask, ok("web_search"), refused, text] as any })).toBe(true)
  })

  test("the book case is untouched: reads all SUCCEEDED, so it still reaches the judge", () => {
    expect(goalStopLayerFires({ auto: true, messages: [ask, ok("read"), ok("read"), text] as any })).toBe(false)
  })

  test("refused but said NOTHING → still reaches the judge", () => {
    expect(goalStopLayerFires({ auto: true, messages: [ask, refused] as any })).toBe(false)
  })

  test("explicit /goal is never short-circuited, exhausted or not", () => {
    expect(goalStopLayerFires({ auto: false, messages: [ask, refused, text] as any })).toBe(false)
  })
})
