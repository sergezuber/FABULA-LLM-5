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

  test("empty and non-string degrade to false", () => {
    expect(summaryLooksHijacked("")).toBe(false)
    expect(summaryLooksHijacked("   ")).toBe(false)
  })
})
