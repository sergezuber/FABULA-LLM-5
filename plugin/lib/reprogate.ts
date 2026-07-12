// Reproduce-first / regression done-gate — PURE logic (the plugin wires it to engine hooks).
//
// Core lesson, proven on SWE-bench Pro task 479aa075 (qutebrowser Qt6.4+ ELF version parse):
// a GREEN existing test suite does NOT prove a fix. The existing suite often does not exercise the
// NEW code path at all, so the agent ships a plausible patch that passes every existing test yet
// fails the hidden acceptance tests (there: an IndexError / wrong-regex in the new branch that the
// pre-6.4 suite never ran). The fix that won: require a reproduction test that EXECUTES the new
// behavior and gate "done" on it — turning a green-but-untested branch red until it is correct.
//
// This module tracks, per session, which files the agent changed (source vs test), and decides
// whether verify_done's "done" should be accepted or downgraded with a reproduce-first steer.

import { BASH_EDIT_MARKER } from "./edittools"

export type PathKind = "test" | "source" | "other"

const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs)\//
const TEST_FILE = /(^|[._-])(test|spec)\.[a-z0-9]+$|^test_.*\.[a-z0-9]+$|_(test|spec)\.[a-z0-9]+$/
const SOURCE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|rb|java|c|cc|cpp|cxx|h|hpp|php|swift|kt|kts|scala|cs|m|mm)$/

/** Classify a file path as a test file, a source file, or neither (docs/config/etc.). */
export function classifyPath(p: string): PathKind {
  if (!p || typeof p !== "string") return "other"
  // A bash tree edit we couldn't name (git apply / patch) — count it as SOURCE so the gate never
  // ignores a shell patch (conservative: over-forcing a verify is safe, under-forcing is the hole).
  if (p === BASH_EDIT_MARKER) return "source"
  const f = p.replace(/\\/g, "/").toLowerCase()
  const base = f.split("/").pop() || ""
  if (TEST_DIR.test(f) || TEST_FILE.test(base)) return "test"
  if (SOURCE_EXT.test(base)) return "source"
  return "other"
}

export interface ReproState {
  sourceChanged: Set<string>
  testChanged: Set<string>
  /** true once the gate has already nudged this session's task (avoid nagging every verify). */
  nudged: boolean
  /** true when the task's own instructions FORBID editing/adding test files (e.g. SWE-bench Pro's
   *  "edit the SOURCE code only (never edit or add test files)"). Steering the model to write a test
   *  would then INDUCE a task-contract violation (proven: it made a run clobber the graded gold test
   *  file → TEST_APPLY_FAIL on an otherwise-evaluable patch) — so the gate must stand down. */
  testsForbidden: boolean
}

export function newReproState(): ReproState {
  return { sourceChanged: new Set<string>(), testChanged: new Set<string>(), nudged: false, testsForbidden: false }
}

/** Does the task text prohibit creating/modifying test files? Conservative patterns: an explicit
 *  "source only" contract or a direct "never/don't edit|add|modify|touch test(s)" instruction. */
export function taskForbidsTests(taskText: string | undefined | null): boolean {
  if (!taskText || typeof taskText !== "string") return false
  const t = taskText.toLowerCase()
  return (
    /never\s+(edit|add|modify|touch|change)[^.\n]{0,40}\btests?\b/.test(t) ||
    /do\s*n[o']t\s+(edit|add|modify|touch|change)[^.\n]{0,40}\btests?\b/.test(t) ||
    /\b(source|src)\s+(code\s+)?only\b[^.\n]{0,60}\btests?\b/.test(t) ||
    /\btests?\s+files?\s+(must|may)\s+not\s+be\s+(edited|added|modified|changed)/.test(t)
  )
}

/** Record a file edit (from create_file/str_replace/write/edit) into the session's change set. */
export function recordEdit(st: ReproState, filePath: string): void {
  const k = classifyPath(filePath)
  if (k === "test") st.testChanged.add(filePath)
  else if (k === "source") st.sourceChanged.add(filePath)
}

/**
 * A reproduction test is "missing" when source code was changed in this task but NO test file was
 * added or modified — the classic green-existing-suite-but-untested-new-branch situation.
 */
export function needsRepro(st: ReproState): boolean {
  return st.sourceChanged.size > 0 && st.testChanged.size === 0
}

export const REPRO_STEER =
  "\n\n⚠️ REPRODUCE-FIRST GATE: the existing suite is GREEN, but you changed source code WITHOUT adding " +
  "a test that exercises the NEW behavior. A green existing suite does NOT prove your fix — it very often " +
  "does not run the new code path at all, which is the #1 way a plausible patch still fails hidden " +
  "acceptance tests. Before you claim done: write a reproduction test that asserts the EXACT expected " +
  "output / error for the issue's new case, in a NEW scratch file with a distinctive name (e.g. " +
  "test_repro_<topic>.py next to the code or in the test dir) — NEVER modify an existing test file: " +
  "existing tests are someone else's contract, and editing them can invalidate the project's own " +
  "acceptance anchors. Then re-run verify_done. The test must FAIL on the OLD behavior and PASS on your fix."

/**
 * Decide what verify_done should report. `passed` = the underlying regression run (existing suite).
 * Returns whether "done" stands and an optional steer note to append. Pure; the plugin mutates the
 * tool output and flips `st.nudged` when it emits the note.
 * When the task itself FORBIDS test edits (st.testsForbidden), the gate stands down: steering the model
 * to write a test would induce a task-contract violation (the exact mechanism that turned a valid run
 * into TEST_APPLY_FAIL) — the green verify stands on the existing suite alone.
 */
export function gateVerdict(passed: boolean, st: ReproState): { done: boolean; note: string | null } {
  if (!passed) return { done: false, note: null } // verifyReport already says NOT DONE
  if (st.testsForbidden) return { done: true, note: null }
  if (needsRepro(st)) return { done: false, note: REPRO_STEER }
  return { done: true, note: null }
}
