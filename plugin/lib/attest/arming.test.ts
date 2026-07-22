import { test, expect } from "bun:test"
import { taskIsVerifiable } from "./arming"

test("arms on deliverable requests (checkable artifact)", () => {
  expect(taskIsVerifiable("Analyze the book NII TRED and save a literary analysis")).toBe(true)
  expect(taskIsVerifiable("проанализируй роман и сделай литературный разбор")).toBe(true)
  expect(taskIsVerifiable("refactor this module to be faster")).toBe(true)
  expect(taskIsVerifiable("summarize these 10 papers with citations")).toBe(true)
  expect(taskIsVerifiable("составь план поездки на неделю с бюджетом")).toBe(true)
})

test("stays SILENT on conversational / opinion asks (fixes chat breakage)", () => {
  expect(taskIsVerifiable("what do you think of this novel?")).toBe(false)
  expect(taskIsVerifiable("что думаешь о романе?")).toBe(false)
  expect(taskIsVerifiable("как тебе идея?")).toBe(false)
  expect(taskIsVerifiable("hi")).toBe(false)
  expect(taskIsVerifiable("thanks!")).toBe(false)
})

test("fail-silent on ambiguity: an unrecognized ask is NOT armed (never punishes a chat turn)", () => {
  expect(taskIsVerifiable("the weather is nice today and I am happy")).toBe(false)
  expect(taskIsVerifiable("tell me a story about a cat")).toBe(false) // no deliverable verb → silent
})
