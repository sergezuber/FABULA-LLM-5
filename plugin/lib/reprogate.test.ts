import { test, expect } from "bun:test"
import {
  classifyPath, newReproState, recordEdit, needsRepro, gateVerdict, REPRO_STEER, taskForbidsTests,
} from "./reprogate"

test("classifyPath: test files across ecosystems", () => {
  expect(classifyPath("tests/unit/misc/test_elf.py")).toBe("test")     // pytest dir + test_ prefix
  expect(classifyPath("qutebrowser/misc/test_elf.py")).toBe("test")    // test_ prefix, no /tests/
  expect(classifyPath("src/foo.test.ts")).toBe("test")                 // .test.ts
  expect(classifyPath("pkg/foo_test.go")).toBe("test")                 // _test.go
  expect(classifyPath("app/__tests__/Bar.spec.tsx")).toBe("test")      // __tests__ + .spec
  expect(classifyPath("spec/models/user_spec.rb")).toBe("test")        // spec dir
})

test("classifyPath: source vs other", () => {
  expect(classifyPath("qutebrowser/misc/elf.py")).toBe("source")
  expect(classifyPath("src/utils/foo.ts")).toBe("source")
  expect(classifyPath("cmd/main.go")).toBe("source")
  expect(classifyPath("README.md")).toBe("other")
  expect(classifyPath("config.yaml")).toBe("other")
  expect(classifyPath("")).toBe("other")
  expect(classifyPath(undefined as any)).toBe("other")
})

test("recordEdit + needsRepro: source changed, no test → repro missing", () => {
  const st = newReproState()
  recordEdit(st, "qutebrowser/misc/elf.py")
  recordEdit(st, "qutebrowser/misc/elf.py") // dedup via Set
  expect(st.sourceChanged.size).toBe(1)
  expect(st.testChanged.size).toBe(0)
  expect(needsRepro(st)).toBe(true)
})

test("recordEdit + needsRepro: a test edit clears the requirement", () => {
  const st = newReproState()
  recordEdit(st, "qutebrowser/misc/elf.py")
  recordEdit(st, "tests/unit/misc/test_elf.py")
  expect(needsRepro(st)).toBe(false)
})

test("needsRepro: no source change → no requirement (docs-only / test-only edits)", () => {
  const st = newReproState()
  recordEdit(st, "README.md")
  expect(needsRepro(st)).toBe(false)
  const st2 = newReproState()
  recordEdit(st2, "tests/unit/misc/test_elf.py")
  expect(needsRepro(st2)).toBe(false) // touched only a test, no source
})

test("gateVerdict: green existing suite but no repro → NOT done + steer (the 479aa075 case)", () => {
  const st = newReproState()
  recordEdit(st, "qutebrowser/misc/elf.py")
  const v = gateVerdict(true, st)
  expect(v.done).toBe(false)
  expect(v.note).toBe(REPRO_STEER)
})

test("gateVerdict: green + a reproduction test present → done stands", () => {
  const st = newReproState()
  recordEdit(st, "qutebrowser/misc/elf.py")
  recordEdit(st, "tests/unit/misc/test_elf.py")
  const v = gateVerdict(true, st)
  expect(v.done).toBe(true)
  expect(v.note).toBeNull()
})

test("gateVerdict: failing verify → NOT done, no extra steer (verifyReport already says NOT DONE)", () => {
  const st = newReproState()
  recordEdit(st, "qutebrowser/misc/elf.py")
  const v = gateVerdict(false, st)
  expect(v.done).toBe(false)
  expect(v.note).toBeNull()
})

// ── M2-widened (2026-07-11, verified forensic): the gate must stand down when the TASK forbids test
// edits — steering toward a test then INDUCES a contract violation (the proven TEST_APPLY_FAIL path). ──

test("taskForbidsTests: the exact SWE-bench Pro contract and close variants", () => {
  // the literal phrase our bench runner uses
  expect(taskForbidsTests(
    "Fix the issue below by editing the SOURCE code only (never edit or add test files).",
  )).toBe(true)
  expect(taskForbidsTests("Do not modify tests. Fix the bug in src/parser.py.")).toBe(true)
  expect(taskForbidsTests("Don't touch the test files; change only the implementation.")).toBe(true)
  expect(taskForbidsTests("Never change any tests — source only.")).toBe(true)
  expect(taskForbidsTests("Test files must not be edited for this exercise.")).toBe(true)
})

test("taskForbidsTests: tasks that MENTION tests without forbidding are NOT suppressed", () => {
  expect(taskForbidsTests("Add a test for the new parser branch and make it pass.")).toBe(false)
  expect(taskForbidsTests("The tests are in tests/unit; run them after your change.")).toBe(false)
  expect(taskForbidsTests("Fix the flaky test in tests/test_io.py.")).toBe(false)
  expect(taskForbidsTests("")).toBe(false)
  expect(taskForbidsTests(undefined)).toBe(false)
  expect(taskForbidsTests(null)).toBe(false)
})

test("gateVerdict: green + repro missing BUT the task forbids test edits → done stands (gate stands down)", () => {
  const st = newReproState()
  st.testsForbidden = true
  recordEdit(st, "lib/ansible/plugins/filter/mathstuff.py")
  expect(needsRepro(st)).toBe(true) // the repro IS missing…
  const v = gateVerdict(true, st)
  expect(v.done).toBe(true)         // …but the gate must not induce a violation
  expect(v.note).toBeNull()
})

test("REPRO_STEER directs to a NEW scratch file and forbids modifying existing tests", () => {
  expect(REPRO_STEER).toContain("NEW scratch file")
  expect(REPRO_STEER).toContain("NEVER modify an existing test file")
})
