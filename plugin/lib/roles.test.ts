// Unit tests for the read-only agent contract (lib/roles.ts). Pure logic, no engine.
import { test, expect, beforeEach, afterEach } from "bun:test"
import {
  isWriteTool, isReadOnlyAgent, isGlobalReadOnly, readOnlyAgents,
  recordSessionAgent, agentForSession, isReadOnlyViolation, _resetRolesRegistry,
} from "./roles"

beforeEach(() => { _resetRolesRegistry(); delete process.env.FABULA_READONLY; delete process.env.FABULA_READONLY_AGENTS })
afterEach(() => { _resetRolesRegistry(); delete process.env.FABULA_READONLY; delete process.env.FABULA_READONLY_AGENTS })

test("isWriteTool: explicit write tools are writes", () => {
  for (const t of ["write", "edit", "patch", "create_file", "str_replace", "note_append", "save_skill", "save_handoff", "schedule_task"])
    expect(isWriteTool(t)).toBe(true)
})

test("isWriteTool: read/search tools are not writes", () => {
  for (const t of ["view", "read", "grep", "glob", "web_search", "web_fetch", "image_search", "session_search", "read_handoff"])
    expect(isWriteTool(t)).toBe(false)
})

test("isWriteTool: bash mutation detection", () => {
  expect(isWriteTool("bash_tool", { command: "rm -rf build" })).toBe(true)
  expect(isWriteTool("bash_tool", { command: "echo hi > out.txt" })).toBe(true)
  expect(isWriteTool("bash_tool", { command: "git commit -m x" })).toBe(true)
  expect(isWriteTool("bash_tool", { command: "npm install lodash" })).toBe(true)
  expect(isWriteTool("bash_tool", { command: "mkdir foo" })).toBe(true)
  expect(isWriteTool("bash", { command: "sed -i 's/a/b/' f" })).toBe(true)
  // read-only commands pass
  expect(isWriteTool("bash_tool", { command: "ls -la" })).toBe(false)
  expect(isWriteTool("bash_tool", { command: "grep -r foo src" })).toBe(false)
  expect(isWriteTool("bash_tool", { command: "git status && git log --oneline" })).toBe(false)
  expect(isWriteTool("bash_tool", { command: "cat file.txt | head" })).toBe(false)
})

test("isReadOnlyAgent: explore is read-only; build is not; env extends the set", () => {
  expect(isReadOnlyAgent("explore")).toBe(true)
  expect(isReadOnlyAgent("build")).toBe(false)
  expect(isReadOnlyAgent("main")).toBe(false)
  expect(isReadOnlyAgent(undefined)).toBe(false)
  process.env.FABULA_READONLY_AGENTS = "auditor, scout"
  expect(readOnlyAgents().has("auditor")).toBe(true)
  expect(isReadOnlyAgent("scout")).toBe(true)
  expect(isReadOnlyAgent("explore")).toBe(true) // built-in still present
})

test("isGlobalReadOnly: env toggles", () => {
  expect(isGlobalReadOnly()).toBe(false)
  for (const v of ["1", "true", "yes"]) { process.env.FABULA_READONLY = v; expect(isGlobalReadOnly()).toBe(true) }
  process.env.FABULA_READONLY = "0"; expect(isGlobalReadOnly()).toBe(false)
})

test("session→agent registry records and looks up", () => {
  recordSessionAgent("s1", "explore")
  recordSessionAgent("s2", "build")
  expect(agentForSession("s1")).toBe("explore")
  expect(agentForSession("s2")).toBe("build")
  expect(agentForSession("unknown")).toBeUndefined()
  recordSessionAgent(undefined, "x") // no-op, no crash
  recordSessionAgent("s3", undefined) // no-op
  expect(agentForSession("s3")).toBeUndefined()
})

test("isReadOnlyViolation: explore session + write = blocked; + read = allowed", () => {
  recordSessionAgent("ro", "explore")
  recordSessionAgent("rw", "build")
  expect(isReadOnlyViolation("ro", "create_file", { path: "x" })).toBe(true)
  expect(isReadOnlyViolation("ro", "bash_tool", { command: "rm x" })).toBe(true)
  expect(isReadOnlyViolation("ro", "view", { path: "x" })).toBe(false)      // read tool always ok
  expect(isReadOnlyViolation("ro", "bash_tool", { command: "ls" })).toBe(false) // read command ok
  expect(isReadOnlyViolation("rw", "create_file", { path: "x" })).toBe(false)   // non-read-only agent ok
  expect(isReadOnlyViolation("unknown", "create_file", { path: "x" })).toBe(false) // unknown session ok
})

test("isReadOnlyViolation: global read-only blocks writes for ANY session", () => {
  process.env.FABULA_READONLY = "1"
  expect(isReadOnlyViolation("anything", "str_replace", {})).toBe(true)
  expect(isReadOnlyViolation("anything", "view", {})).toBe(false) // reads still allowed
})
