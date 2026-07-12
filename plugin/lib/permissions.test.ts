// Unit tests for permission modes + persisted allow-list (lib/permissions.ts). Real JSON store in a
// temp file.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  permissionMode, setPermissionMode, commandSignature, isCommandAllowed, allowCommand, revokeCommand,
  isPlanBlocked, shouldBypassGuards, editsPreApproved,
} from "./permissions"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "fab-perm-"))
  process.env.FABULA_PERMISSIONS_FILE = path.join(dir, "perm.json")
  delete process.env.FABULA_PERMISSION_MODE
})
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  delete process.env.FABULA_PERMISSIONS_FILE
  delete process.env.FABULA_PERMISSION_MODE
})

test("default mode when nothing is set", () => {
  expect(permissionMode()).toBe("default")
})

test("mode from env, overridden by the persisted store", () => {
  process.env.FABULA_PERMISSION_MODE = "plan"
  expect(permissionMode()).toBe("plan")
  setPermissionMode("bypass") // persisted store wins over env
  expect(permissionMode()).toBe("bypass")
})

test("setPermissionMode rejects unknown modes", () => {
  expect(setPermissionMode("nonsense").ok).toBe(false)
  expect(setPermissionMode("acceptEdits").ok).toBe(true)
  expect(permissionMode()).toBe("acceptEdits")
})

test("mode persists across a fresh load (survives restart)", () => {
  setPermissionMode("plan")
  // a second read (simulating a new process) reads the same file
  expect(permissionMode()).toBe("plan")
  expect(existsSync(process.env.FABULA_PERMISSIONS_FILE!)).toBe(true)
})

test("commandSignature is stable and normalizes bash whitespace", () => {
  expect(commandSignature("bash_tool", { command: "git   push    origin" })).toBe("bash:git push origin")
  expect(commandSignature("create_file", { path: "/a/b.ts" })).toBe("create_file:/a/b.ts")
  expect(commandSignature("web_fetch", { url: "https://x/" })).toBe("web_fetch:https://x/")
})

test("allow-list: allow → persisted → consulted; revoke removes", () => {
  const sig = commandSignature("bash_tool", { command: "git push" })
  expect(isCommandAllowed(sig)).toBe(false)
  allowCommand(sig)
  expect(isCommandAllowed(sig)).toBe(true) // persisted + read back
  revokeCommand(sig)
  expect(isCommandAllowed(sig)).toBe(false)
})

test("plan mode blocks writes, allows reads", () => {
  setPermissionMode("plan")
  expect(isPlanBlocked("create_file", { path: "x" })).toBe(true)
  expect(isPlanBlocked("str_replace", { path: "x" })).toBe(true)
  expect(isPlanBlocked("bash_tool", { command: "rm x" })).toBe(true)
  expect(isPlanBlocked("view", { path: "x" })).toBe(false)
  expect(isPlanBlocked("bash_tool", { command: "ls" })).toBe(false)
})

test("bypass mode skips guards for everything; a pre-allowed command skips guards in default mode", () => {
  expect(shouldBypassGuards("bash_tool", { command: "anything" })).toBe(false) // default
  setPermissionMode("bypass")
  expect(shouldBypassGuards("bash_tool", { command: "anything" })).toBe(true)
  setPermissionMode("default")
  const sig = commandSignature("bash_tool", { command: "git push" })
  allowCommand(sig)
  expect(shouldBypassGuards("bash_tool", { command: "git push" })).toBe(true)  // pre-allowed
  expect(shouldBypassGuards("bash_tool", { command: "rm -rf /" })).toBe(false) // not allowed
})

test("editsPreApproved only in acceptEdits mode", () => {
  expect(editsPreApproved()).toBe(false)
  setPermissionMode("acceptEdits")
  expect(editsPreApproved()).toBe(true)
})
