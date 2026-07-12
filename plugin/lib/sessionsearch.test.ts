import { test, expect } from "bun:test"
import { toFtsMatch, searchSql, dedupeRows } from "./sessionsearch"

test("toFtsMatch quotes terms + OR by default (FTS5-safe)", () => {
  expect(toFtsMatch("circuit-breaker plugin")).toBe('"circuit" OR "breaker" OR "plugin"')
  expect(toFtsMatch("redact", "and")).toBe('"redact"')
  expect(toFtsMatch("a b", "and")).toBe('"a" AND "b"')
})
test("toFtsMatch neutralizes FTS operators / quotes", () => {
  expect(toFtsMatch('AND OR NOT "x"')).toBe('"AND" OR "OR" OR "NOT" OR "x"')
  expect(toFtsMatch("   ")).toBe("")
})
test("searchSql includes MATCH, join, optional session filter, limit", () => {
  expect(searchSql({})).toContain("history_fts_idx MATCH ?")
  expect(searchSql({})).toContain("LIMIT ?")
  expect(searchSql({ excludeSession: true })).toContain("session_id != ?")
  expect(searchSql({ excludeSession: false })).not.toContain("session_id != ?")
})
test("dedupeRows collapses same message_id + snippet", () => {
  const r: any[] = [
    { message_id: "m1", snip: "hello world", session_id: "s", kind: "text", tool_name: null, time_created: 1, score: -1 },
    { message_id: "m1", snip: "hello   world", session_id: "s", kind: "text", tool_name: null, time_created: 1, score: -1 },
    { message_id: "m2", snip: "other", session_id: "s", kind: "text", tool_name: null, time_created: 1, score: -1 },
  ]
  expect(dedupeRows(r).length).toBe(2)
})
