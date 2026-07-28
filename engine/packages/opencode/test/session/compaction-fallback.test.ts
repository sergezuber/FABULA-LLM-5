import { describe, expect, test } from "bun:test"
import { mechanicalSummary, LIST_LIMIT } from "../../src/session/compaction-fallback"

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
