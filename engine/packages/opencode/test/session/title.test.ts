import { describe, expect, test } from "bun:test"
import { plainTitle, chooseTitle } from "../../src/session/title"

describe("plainTitle", () => {
  test("strips the emphasis that was showing up literally in the sidebar", () => {
    // The exact string a real session was listed under.
    expect(plainTitle("**Status**: success | partial | failed | blocked")).toBe(
      "Status: success | partial | failed | blocked",
    )
    expect(plainTitle("__Fix__ the nightly export")).toBe("Fix the nightly export")
    expect(plainTitle("*Analyze* the book")).toBe("Analyze the book")
    expect(plainTitle("***Urgent*** review")).toBe("Urgent review")
  })

  test("strips block markers, code spans, links and strikethrough", () => {
    expect(plainTitle("## Analyze the book")).toBe("Analyze the book")
    expect(plainTitle("- Fix the parser")).toBe("Fix the parser")
    expect(plainTitle("1. Fix the parser")).toBe("Fix the parser")
    expect(plainTitle("> Fix the parser")).toBe("Fix the parser")
    expect(plainTitle("Update `config.json` defaults")).toBe("Update config.json defaults")
    expect(plainTitle("See [the report](https://example.com/r)")).toBe("See the report")
    expect(plainTitle("~~Old~~ approach")).toBe("Old approach")
  })

  test("a title is one line, whitespace collapsed", () => {
    expect(plainTitle("Analyze the book\nand write a report")).toBe("Analyze the book")
    expect(plainTitle("  Analyze   the    book  ")).toBe("Analyze the book")
  })

  test("plain text and ordinary punctuation pass through untouched", () => {
    expect(plainTitle("Analyze the book and write a report")).toBe("Analyze the book and write a report")
    expect(plainTitle("Rename user_id to account_id")).toBe("Rename user_id to account_id")
    expect(plainTitle("2 * 3 = 6")).toBe("2 * 3 = 6") // a lone asterisk is arithmetic, not emphasis
    expect(plainTitle("")).toBe("")
  })
})

// The live defect, verbatim. Session ses_06667e96cffeM9816ZyStjYEGU asked about an Osho parable and was
// listed as "Status: success | partial | failed | blocked" — line 179 of session/llm.ts, i.e. the model
// quoting the very instructions the title call hands it. Stripping the asterisks left it intact.
describe("chooseTitle", () => {
  const AGENT_PROMPT = [
    "## Subagent return format",
    "",
    "When you finish your task, your final assistant message will be delivered to the spawning agent.",
    "",
    "  **Status**: success | partial | failed | blocked",
    "  **Summary**: one paragraph",
  ].join("\n")
  const USER = "я читал в одной из книг ОШО историю про дровосека. найди эту историю"

  test("a line quoted out of our own prompt is refused; the user's words are used instead", () => {
    const t = chooseTitle({ raw: "**Status**: success | partial | failed | blocked", promptText: AGENT_PROMPT, userText: USER })
    expect(t).not.toContain("success | partial")
    expect(t.toLowerCase()).toContain("ошо")
  })

  test("a real title is kept untouched", () => {
    expect(chooseTitle({ raw: "Ошо: притча про дровосека", promptText: AGENT_PROMPT, userText: USER })).toBe(
      "Ошо: притча про дровосека",
    )
  })

  test("an echoed FIRST line does not cost a good SECOND one", () => {
    const t = chooseTitle({
      raw: "**Status**: success | partial | failed | blocked\nОшо: притча про дровосека",
      promptText: AGENT_PROMPT,
      userText: USER,
    })
    expect(t).toBe("Ошо: притча про дровосека")
  })

  test("a short title is never refused by a chance collision with a long prompt", () => {
    // "task" occurs in the prompt above; a two-word title must survive it.
    expect(chooseTitle({ raw: "Task list", promptText: AGENT_PROMPT, userText: USER })).toBe("Task list")
  })

  test("nothing usable at all → the user's opening words, trimmed at a word boundary", () => {
    const t = chooseTitle({ raw: "", promptText: AGENT_PROMPT, userText: USER })
    expect(t.length).toBeLessThanOrEqual(61)
    expect(t).not.toBe("")
    expect(t.toLowerCase()).toContain("ошо")
  })

  test("no user text either → empty, and the caller keeps the existing name", () => {
    expect(chooseTitle({ raw: "", promptText: AGENT_PROMPT, userText: "" })).toBe("")
  })

  test("malformed input never throws", () => {
    expect(() => chooseTitle({} as any)).not.toThrow()
  })
})

describe("markup is not a title", () => {
  test("a control token the model emitted instead of prose is refused", () => {
    const t = chooseTitle({ raw: "<tool_calls>", promptText: "", userText: "найди историю про дровосека" })
    expect(t).not.toContain("tool_calls")
    expect(t.toLowerCase()).toContain("дровосек")
  })
  test("a bracketed marker line is refused too", () => {
    expect(chooseTitle({ raw: "[thinking]", promptText: "", userText: "про басни и притчи" })).not.toContain("[")
  })
  test("real prose containing a tag-like word survives", () => {
    expect(chooseTitle({ raw: "Как работает <div> в вёрстке", promptText: "", userText: "q" })).toContain("вёрстке")
  })
})

test("a control token WITH a payload is refused — the live case the first filter missed", () => {
  const t = chooseTitle({
    raw: '<tool_call>web_search{"query": "Osho woodcutter story cutting trees third level"}',
    promptText: "",
    userText: "найди историю про дровосека у Ошо",
  })
  expect(t).not.toContain("tool_call")
  expect(t).not.toContain("{")
  expect(t.toLowerCase()).toContain("дровосек")
})
test("a tag without a payload is still prose", () => {
  expect(chooseTitle({ raw: "Как работает <div> в вёрстке", promptText: "", userText: "q" })).toContain("вёрстке")
})
