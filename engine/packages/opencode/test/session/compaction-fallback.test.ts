import { describe, expect, test } from "bun:test"
import { mechanicalSummary, compactionMadeRoom, replacedSize, ROOM_MADE_RATIO, LIST_LIMIT, consecutiveHijacks, summarizerSpent } from "../../src/session/compaction-fallback"

// The measured case: a conversation about reading a book, where the summariser kept reading instead of
// summarising. Twice. The run then died and everything it had read was lost.
const CONVO = [
  { role: "user", parts: [{ type: "text", text: "о чем книга? прочти полностью и дай ответ" }] },
  { role: "assistant", parts: [
    { type: "tool", tool: "read", state: { input: { file_path: "/book/ch01.md" } } },
    { type: "tool", tool: "read", state: { input: { file_path: "/book/ch02.md" } } },
    { type: "text", text: "Прочитал две главы, продолжаю." },
  ] },
]

describe("mechanicalSummary", () => {
  test("the user's own words survive — a summary that loses the request is worthless", () => {
    expect(mechanicalSummary(CONVO)).toContain("о чем книга")
  })

  test("the work done is named, so a later turn knows what not to repeat", () => {
    const s = mechanicalSummary(CONVO)
    expect(s).toContain("read ×2")
    expect(s).toContain("/book/ch01.md")
  })

  test("where it stood is carried forward", () => {
    expect(mechanicalSummary(CONVO)).toContain("Прочитал две главы")
  })

  test("it says plainly that it is assembled, never passing itself off as a real summary", () => {
    expect(mechanicalSummary(CONVO)).toContain("Assembled from what the conversation contains")
  })

  test("a long list is capped and SAYS how much it dropped — a silent cap reads as completeness", () => {
    const many = [{ role: "assistant", parts: Array.from({ length: LIST_LIMIT + 8 }, (_, i) => ({
      type: "tool", tool: "read", state: { input: { file_path: `/book/ch${i}.md` } },
    })) }]
    const s = mechanicalSummary(many)
    expect(s).toContain("and 8 more")
  })

  test("synthetic reminders are not mistaken for things the user asked", () => {
    const s = mechanicalSummary([{ role: "user", parts: [{ type: "text", text: "<system-reminder>do X</system-reminder>" }] }])
    expect(s).not.toContain("do X")
  })

  test("an empty conversation produces something usable rather than nothing", () => {
    const s = mechanicalSummary([])
    expect(s).toContain("Summary of the conversation so far")
    expect(s).toContain("(nothing recorded)")
  })

  test("malformed input never throws", () => {
    expect(() => mechanicalSummary(undefined as any)).not.toThrow()
    expect(() => mechanicalSummary([{ role: "user" } as any])).not.toThrow()
  })

  test("nothing is invented: every line traces to something the conversation contained", () => {
    const s = mechanicalSummary(CONVO)
    for (const claim of ["ch01", "ch02", "read"]) expect(s).toContain(claim)
    expect(s).not.toContain("ch03")
  })
})


// CONTINUING IS EARNED, NOT ALLOWANCED. The first attempt at this bound was "at most two fallbacks" — a
// decision taken before the situation exists, wrong in both directions: a turn still freeing room gets
// stopped, a turn freeing nothing gets two pointless rounds first. What matters is whether the pass did
// the one thing compaction is for. Measured live 2026-07-28: one question, ten compactions, fifty-one
// messages, the model still generating after the answer had been delivered.
describe("continuing after a fallback is earned by making room", () => {
  test("a summary far smaller than what it replaced made room", () => {
    expect(compactionMadeRoom(100_000, 3_000)).toBe(true)
  })
  test("a summary the size of what it replaced made none — this is the loop", () => {
    expect(compactionMadeRoom(100_000, 100_000)).toBe(false)
    expect(compactionMadeRoom(100_000, 90_000)).toBe(false)
  })
  test("the boundary is the stated ratio, not a count of attempts", () => {
    expect(compactionMadeRoom(1000, 1000 * ROOM_MADE_RATIO - 1)).toBe(true)
    expect(compactionMadeRoom(1000, 1000 * ROOM_MADE_RATIO)).toBe(false)
  })
  test("a hundredth pass that still frees room continues — there is no allowance to spend", () => {
    for (let i = 0; i < 100; i++) expect(compactionMadeRoom(80_000, 2_000)).toBe(true)
  })
  test("an unmeasurable size never ends a turn (fail-open)", () => {
    expect(compactionMadeRoom(0, 5_000)).toBe(true)
    expect(compactionMadeRoom(-1, 5_000)).toBe(true)
    expect(compactionMadeRoom(NaN, 5_000)).toBe(true)
  })
  test("size counts the whole serialised shape, tool payloads included", () => {
    const withTool = [{ info: { role: "assistant" }, parts: [{ type: "tool", state: { output: "x".repeat(5000) } }] }]
    expect(replacedSize(withTool)).toBeGreaterThan(5000)
    expect(replacedSize([])).toBe(0)
  })
  test("the real shape: a book slice replaced by a page of prose continues", () => {
    const slice = Array.from({ length: 12 }, () => ({ parts: [{ type: "text", text: "глава ".repeat(2000) }] }))
    const summary = mechanicalSummary([{ role: "user", parts: [{ type: "text", text: "о чем книга" }] }] as never)
    expect(compactionMadeRoom(replacedSize(slice), summary.length)).toBe(true)
  })
})

// COMPLEMENTS the room test, does not replace it. Measured live 2026-07-28: a hijacked summarizer
// produced a fallback that DID free room, so the room test passed and the loop ran on while every
// summary was garbage. One derailment among successes is a bad draw; an unbroken run of them is a
// summarizer that cannot do this job on this transcript.
describe("a summarizer that keeps derailing is spent", () => {
  const run = (...flags: boolean[]) => flags.map((hijacked) => ({ hijacked }))
  test("a clean run has spent nothing", () => {
    expect(consecutiveHijacks(run(false, false, false))).toBe(0)
    expect(summarizerSpent(run(false, false, false))).toBe(false)
  })
  test("one derailment among successes is a bad draw, not a verdict", () => {
    expect(summarizerSpent(run(true, false, true))).toBe(false)
  })
  test("a clean summary anywhere resets the run", () => {
    expect(consecutiveHijacks(run(true, true, true, false))).toBe(0)
    expect(summarizerSpent(run(true, true, true, false))).toBe(false)
  })
  test("an unbroken run at the bound is spent", () => {
    expect(summarizerSpent(run(true, true, true))).toBe(true)
    expect(summarizerSpent(run(false, true, true, true))).toBe(true)
  })
  test("the six consecutive hijacks measured live are spent", () => {
    expect(summarizerSpent(run(true, true, true, true, true, true))).toBe(true)
  })
})
