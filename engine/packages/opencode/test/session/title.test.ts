import { describe, expect, test } from "bun:test"
import { plainTitle } from "../../src/session/title"

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
