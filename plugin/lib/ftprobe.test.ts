// Pure-helper coverage for lib/ftprobe.ts. The full materialize+run path is exercised by the W1 wiring
// suites (real git + real test execution); here we pin the deterministic classifiers + the honest degrade
// signals that gate whether the strict path runs at all.
import { test, expect, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runnerFor, isDockerOnly, sha256File } from "./ftprobe"

const savedCmd = process.env.FABULA_VERIFY_CMD
const savedDocker = process.env.FABULA_VERIFY_DOCKER_ONLY
afterEach(() => {
  if (savedCmd == null) delete process.env.FABULA_VERIFY_CMD; else process.env.FABULA_VERIFY_CMD = savedCmd
  if (savedDocker == null) delete process.env.FABULA_VERIFY_DOCKER_ONLY; else process.env.FABULA_VERIFY_DOCKER_ONLY = savedDocker
})

test("runnerFor maps by extension; unsupported → null (→ honest degrade, never a wrong guess)", () => {
  expect(runnerFor("test_x.py")).toBe("python3")
  expect(runnerFor("a/b/test.PY")).toBe("python3")
  expect(runnerFor("t.js")).toBe("node")
  expect(runnerFor("t.mjs")).toBe("node")
  expect(runnerFor("t.cjs")).toBe("node")
  expect(runnerFor("t.ts")).toBe("bun")
  expect(runnerFor("t.tsx")).toBe("bun")
  expect(runnerFor("t.rb")).toBeNull()
  expect(runnerFor("Makefile")).toBeNull()
})

test("isDockerOnly: explicit flag OR a docker-referencing verify command", () => {
  delete process.env.FABULA_VERIFY_CMD; delete process.env.FABULA_VERIFY_DOCKER_ONLY
  expect(isDockerOnly()).toBe(false)
  process.env.FABULA_VERIFY_DOCKER_ONLY = "1"
  expect(isDockerOnly()).toBe(true)
  delete process.env.FABULA_VERIFY_DOCKER_ONLY
  process.env.FABULA_VERIFY_CMD = "docker exec c pytest -q"
  expect(isDockerOnly()).toBe(true)
  process.env.FABULA_VERIFY_CMD = "python3 test_repro.py"
  expect(isDockerOnly()).toBe(false)
})

test("sha256File hashes real bytes; a missing file → null", () => {
  const d = mkdtempSync(join(tmpdir(), "ftp-"))
  const f = join(d, "a.txt"); writeFileSync(f, "hello")
  expect(sha256File(f)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
  expect(sha256File(join(d, "nope.txt"))).toBeNull()
})
