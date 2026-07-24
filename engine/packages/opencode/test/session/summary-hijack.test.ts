// A summary containing tool-call markup is a continuation wearing a summary's flag.
//
// Measured live twice (2026-07-21): a transcript ending in chapter reads yielded a "summary" of
// "Продолжаю чтение глав 7-12:" + <tool_call> blocks; a transcript saturated with suppressed
// list_plugins calls yielded a bare <tool_call><function=list_plugins>. Both ended the session
// SILENTLY with the garbage recorded as its summary. The detector is deterministic markup inspection;
// the wiring retries once with a corrective and, failing that, sets a VISIBLE error.
import { describe, test, expect } from "bun:test"
import { summaryLooksHijacked } from "../../src/session/compaction"

describe("summaryLooksHijacked", () => {
  test("the two measured live outputs are both detected", () => {
    expect(
      summaryLooksHijacked("\n\nПродолжаю чтение глав 7-12:\n\n<tool_call>\n<function=read>\n</function>\n</tool_call>"),
    ).toBe(true)
    expect(summaryLooksHijacked("\n\n<tool_call>\n<function=list_plugins>\n</function>\n</tool_call>")).toBe(true)
  })

  test("a real summary is never flagged", () => {
    expect(
      summaryLooksHijacked("## Goal\nAnalyze all chapters.\n\n## Accomplished\nChapters 1-6 read and analyzed."),
    ).toBe(false)
  })

  test("a summary MENTIONING tools in prose is not markup and passes", () => {
    expect(summaryLooksHijacked("The agent used the read tool on six chapter files.")).toBe(false)
  })

  test("a DEGENERATIVE runaway summary is detected (the 2026-07-23 shape — no tool markup)", () => {
    // The summarizer emitted hundreds of spaceless "глава_10X" lines instead of a summary. No
    // <tool_call> markup, so the markup check alone missed it; no inter-word spaces, so the word
    // n-gram was blind. The char-shingle arm catches this recurring-skeleton shape — closing the hole
    // that let the runaway poison the context and re-trigger for hours.
    const runaway = Array.from({ length: 80 }, (_, i) => `глава_10${i.toString(36)}`).join("")
    expect(summaryLooksHijacked(runaway)).toBe(true)
  })

  test("a legitimate structured summary with repeated headings is NOT flagged", () => {
    // A real summary legitimately repeats its template headings (## Goal, ## Accomplished) and may
    // list many files. The char-shingle threshold (8 repeats of an 8-char skeleton) keeps this grounded
    // summary unpunished — fail-open, never reject a real summary.
    const real =
      "## Goal\nAnalyze all thirty chapters.\n\n## Accomplished\n" +
      Array.from({ length: 30 }, (_, i) => `- глава_${i + 1}: analyzed`).join("\n")
    expect(summaryLooksHijacked(real)).toBe(false)
  })

  test("empty and non-string degrade to false", () => {
    expect(summaryLooksHijacked("")).toBe(false)
    expect(summaryLooksHijacked("   ")).toBe(false)
  })
})
