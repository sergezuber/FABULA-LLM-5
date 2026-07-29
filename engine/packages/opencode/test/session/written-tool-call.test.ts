// A tool call written as prose is the same defect whatever its dialect and whatever the finish reason
// says. Measured live 2026-07-28, twice: the model emitted `<tool_call><function=read>…` as TEXT and the
// detector never fired — the finish reason was "stop" (a provider that did not parse a call has no
// reason to report one) and the dialect was absent from the alternation. Six steps, six "continue",
// thirty-three messages on one question.
import { describe, expect, test } from "bun:test"
import { looksLikeWrittenToolCall, classifyAssistantStep } from "../../src/session/classify"

describe("written tool calls are recognised by substance, not spelling", () => {
  const real = [
    "<tool_call>\n<function=read>\n<parameter=file_path>/x.md</parameter>\n</function>\n</tool_call>",
    "Давай посмотрим.\n<tool_call><function=read><parameter=p>/x</parameter></function></tool_call>",
    "<function_calls><invoke name=\"read\"><parameter name=\"p\">/x</parameter></invoke></function_calls>",
    "<TOOL_CALL><FUNCTION=read><PARAMETER=p>/x</PARAMETER></FUNCTION></TOOL_CALL>",
  ]
  for (const t of real)
    test(`fires on: ${t.slice(0, 34).replace(/\n/g, " ")}…`, () => expect(looksLikeWrittenToolCall(t)).toBe(true))

  const prose = [
    "Модель иногда пишет вызов текстом — это баг.",
    "The <div> tag is not a tool call.",
    "Здесь нет никакой разметки вообще.",
    "",
  ]
  for (const t of prose)
    test(`stays quiet on: ${t.slice(0, 34) || "(пусто)"}`, () => expect(looksLikeWrittenToolCall(t)).toBe(false))

  test("a call tag alone, with no function or parameter named, is not a call", () => {
    expect(looksLikeWrittenToolCall("см. <tool_call> в документации")).toBe(false)
  })
  test("malformed input never throws", () => {
    expect(() => looksLikeWrittenToolCall(undefined as never)).not.toThrow()
    expect(looksLikeWrittenToolCall(undefined as never)).toBe(false)
  })
})

// THE HALF THAT MADE THE BRANCH UNREACHABLE. The old test also required finish === "tool-calls", but a
// provider that did not parse the call has no reason to report one — it reports "stop". So the branch
// could not fire in exactly the case it exists for. Driving the real classifier here, not the helper:
// a mutation restoring the finish requirement must fail this.
describe("the classifier reaches text-tool-call whatever the finish reason", () => {
  const BLOCK = "<tool_call><function=read><parameter=file_path>/x.md</parameter></function></tool_call>"
  const step = (finish: string, text = BLOCK) =>
    classifyAssistantStep({
      lastUser: { id: "msg_001" } as never,
      assistant: { id: "msg_002", finish } as never,
      parts: [{ type: "text", text }] as never,
      phase: "after-process",
    })

  test("finish=stop — the live shape, twice measured", () => {
    expect(step("stop").type).toBe("text-tool-call")
  })
  test("finish=tool-calls — the shape the old test knew", () => {
    expect(step("tool-calls").type).toBe("text-tool-call")
  })
  for (const finish of ["end_turn", "stop_sequence", "other"])
    test(`finish=${finish} is reached too`, () => expect(step(finish).type).toBe("text-tool-call"))

  test("a cut-off step is NOT one — its markup may be merely unfinished", () => {
    expect(step("length").type).not.toBe("text-tool-call")
  })
  test("ordinary prose at the same finish reason is not a written call", () => {
    expect(step("stop", "Вот что я нашёл в папке.").type).not.toBe("text-tool-call")
  })
})
