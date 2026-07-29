// ANSWERED MEANS DONE. Measured live 2026-07-28: the reader asked "что тут? о чем?", the model answered,
// and because the conversation stayed permanently above the last checkpoint threshold (39 745 tokens
// against 15 243) compaction fired on every step afterwards and each pass returned "continue" — ten
// compactions, fifty-one messages, the model still generating long after the answer was on screen.
//
// The signal is the model's own, not a threshold and not a count, and NOTHING here bounds the answer's
// size: a one-line reply and a twenty-page report are equally answers.
import { describe, expect, test } from "bun:test"
import { turnEndedWithAnswer } from "../../src/session/verify-gate"

const text = (t: string, synthetic = false) => ({ type: "text", text: t, synthetic })
const tool = (status: string) => ({ type: "tool", state: { status } })

describe("a turn that answered is done", () => {
  test("a one-word answer is an answer", () => {
    expect(turnEndedWithAnswer({ finish: "stop" }, [text("да")])).toBe(true)
  })
  test("a twenty-page answer is the same answer — size decides nothing", () => {
    expect(turnEndedWithAnswer({ finish: "stop" }, [text("разбор ".repeat(20_000))])).toBe(true)
  })
  test("other providers' stop reasons count too", () => {
    for (const finish of ["end_turn", "stop_sequence"])
      expect(turnEndedWithAnswer({ finish }, [text("готово")])).toBe(true)
  })

  test("a tool still running is not an answer", () => {
    expect(turnEndedWithAnswer({ finish: "stop" }, [text("сейчас посмотрю"), tool("running")])).toBe(false)
    expect(turnEndedWithAnswer({ finish: "stop" }, [text("сейчас"), tool("pending")])).toBe(false)
  })
  test("a completed tool alongside the answer is still an answer", () => {
    expect(turnEndedWithAnswer({ finish: "stop" }, [tool("completed"), text("вот что нашёл")])).toBe(true)
  })
  test("a turn cut off mid-work has not answered", () => {
    for (const finish of ["length", "tool-calls", "aborted", "error", undefined])
      expect(turnEndedWithAnswer({ finish }, [text("почти")])).toBe(false)
  })
  test("only harness text is not an answer to anyone", () => {
    expect(turnEndedWithAnswer({ finish: "stop" }, [text("continue if you have next steps", true)])).toBe(false)
    expect(turnEndedWithAnswer({ finish: "stop" }, [text("   ")])).toBe(false)
    expect(turnEndedWithAnswer({ finish: "stop" }, [])).toBe(false)
  })
  test("an errored or summary message is never an answer", () => {
    expect(turnEndedWithAnswer({ finish: "stop", error: {} }, [text("x")])).toBe(false)
    expect(turnEndedWithAnswer({ finish: "stop", summary: true }, [text("x")])).toBe(false)
  })
  test("nothing at all is not an answer", () => {
    expect(turnEndedWithAnswer(undefined, [text("x")])).toBe(false)
  })
})
