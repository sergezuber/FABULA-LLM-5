import { test, expect } from "bun:test"
import { normalizeToolCallId, remapToolCallIds, synthOrphanResults, skipErroredTurns, transformForProvider } from "./xprovider"

test("normalizeToolCallId clamps to the strict pattern, keeps loose as-is", () => {
  const long = "call_" + "x".repeat(80) + "|extra"
  expect(normalizeToolCallId(long, "loose")).toBe(long)
  const a = normalizeToolCallId(long, "strict")
  expect(a.length).toBeLessThanOrEqual(64)
  expect(/^[a-zA-Z0-9_-]+$/.test(a)).toBe(true)
  expect(normalizeToolCallId("ok_id-1", "strict")).toBe("ok_id-1") // already valid, untouched
})

test("remapToolCallIds rewrites BOTH the call and its result", () => {
  const msgs = [
    { role: "assistant", tool_calls: [{ id: "id|bad", function: { name: "x" } }] },
    { role: "tool", tool_call_id: "id|bad", content: "r" },
  ]
  const out = remapToolCallIds(msgs, "strict")
  const newId = out[0].tool_calls![0].id
  expect(newId).not.toContain("|")
  expect(out[1].tool_call_id).toBe(newId) // result id follows the call id
})

test("synthOrphanResults adds an error result for an unanswered tool call", () => {
  const msgs = [
    { role: "assistant", tool_calls: [{ id: "a1" }, { id: "a2" }] },
    { role: "tool", tool_call_id: "a1", content: "done" },
  ]
  const out = synthOrphanResults(msgs)
  const orphanResult = out.find((m) => m.role === "tool" && m.tool_call_id === "a2")
  expect(orphanResult).toBeTruthy()
  expect(orphanResult!.content).toContain("No result provided")
  // does not duplicate an already-answered call
  expect(out.filter((m) => m.tool_call_id === "a1").length).toBe(1)
})

test("skipErroredTurns drops errored/aborted assistant turns", () => {
  const msgs = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "bad", aborted: true },
    { role: "assistant", content: "good" },
  ]
  const out = skipErroredTurns(msgs)
  expect(out.map((m) => m.content)).toEqual(["hi", "good"])
})

test("transformForProvider composes all rules and is replay-safe", () => {
  const msgs = [
    { role: "user", content: "task" },
    { role: "assistant", content: "aborted", aborted: true },
    { role: "assistant", tool_calls: [{ id: "long|" + "y".repeat(70) }] }, // orphan + bad id
  ]
  const out = transformForProvider(msgs, { style: "strict" })
  // aborted turn gone
  expect(out.some((m) => (m as any).aborted)).toBe(false)
  // the bad id is normalized and its synthesized result matches
  const call = out.find((m) => Array.isArray(m.tool_calls))!.tool_calls![0].id
  expect(call.length).toBeLessThanOrEqual(64)
  const res = out.find((m) => m.role === "tool")
  expect(res!.tool_call_id).toBe(call)
})
