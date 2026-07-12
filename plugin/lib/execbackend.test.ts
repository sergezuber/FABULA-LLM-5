import { test, expect } from "bun:test"
import { bashArgv, resolveBackend, backendNote } from "./execbackend"

test("bashArgv: host / sandbox / docker", () => {
  expect(bashArgv("ls")).toEqual(["bash", "-lc", "ls"])
  expect(bashArgv("ls", { sandboxProfile: "(version 1)" })).toEqual(["sandbox-exec", "-p", "(version 1)", "bash", "-lc", "ls"])
  expect(bashArgv("ls", { dockerCid: "abc123" })).toEqual(["docker", "exec", "-i", "abc123", "bash", "-lc", "ls"])
})

test("resolveBackend precedence: docker > sandbox > host", () => {
  expect(resolveBackend({}, "P")).toEqual({})
  expect(resolveBackend({ FABULA_SANDBOX: "1" }, "P")).toEqual({ sandboxProfile: "P" })
  expect(resolveBackend({ FABULA_BASH_BACKEND: "docker:cid9" }, "P")).toEqual({ dockerCid: "cid9" })
  // docker wins even if sandbox also set
  expect(resolveBackend({ FABULA_BASH_BACKEND: "docker:cid9", FABULA_SANDBOX: "1" }, "P")).toEqual({ dockerCid: "cid9" })
  // empty docker cid falls through
  expect(resolveBackend({ FABULA_BASH_BACKEND: "docker:" }, "P")).toEqual({})
  // sandbox needs a profile
  expect(resolveBackend({ FABULA_SANDBOX: "1" }, "")).toEqual({})
})

test("backendNote", () => {
  expect(backendNote({})).toBe("")
  expect(backendNote({ dockerCid: "abcdef1234567890" })).toContain("docker exec abcdef123456")
  expect(backendNote({ sandboxProfile: "x" })).toContain("sandbox")
})
