import { describe, expect, test } from "bun:test"
import { recoverTaskArgs } from "../../src/tool/task"

// MEASURED 2026-08-01: seven failures in a single day, latest 13:11:44, every one with input exactly
// {"operation":"list"} and the error "Invalid input: expected object, received string → at operation".
// JSON.parse("list") throws and the catch swallowed it, leaving the string where it was — so the call
// could not succeed however many times it was retried, and a call that cannot succeed is retried forever
// (the 456-call loop had the same root).
describe("recoverTaskArgs — a bare action name as the operation value", () => {
  test("{operation:'list'} becomes the nested payload it was meant to be", () => {
    expect(recoverTaskArgs({ operation: "list" })).toEqual({ operation: { action: "list" } } as any)
  })

  test("siblings ride along into the wrapper", () => {
    expect(recoverTaskArgs({ operation: "create", summary: "ship it" })).toEqual({
      operation: { action: "create", summary: "ship it" },
    } as any)
  })

  test("a JSON-STRINGIFIED operation still parses, exactly as before", () => {
    expect(recoverTaskArgs({ operation: '{"action":"list"}' })).toEqual({ operation: { action: "list" } } as any)
  })

  test("an already-correct nested payload is untouched", () => {
    expect(recoverTaskArgs({ operation: { action: "list" } })).toEqual({ operation: { action: "list" } } as any)
  })

  test("the bare {summary} create is still synthesized", () => {
    expect(recoverTaskArgs({ summary: "do the thing" })).toEqual({
      operation: { action: "create", summary: "do the thing" },
    } as any)
  })

  test("something genuinely unrecoverable still returns undefined — the wrap is not a hole", () => {
    expect(recoverTaskArgs({ nonsense: 1 })).toBeUndefined()
    expect(recoverTaskArgs(null)).toBeUndefined()
    expect(recoverTaskArgs("list")).toBeUndefined()
  })
})
