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
  /** sha256 of each new test file at the moment its fail-to-pass validation went green — the FREEZE.
   *  A later verify whose content hash differs re-arms the gate (anti-cheat: a test cannot be loosened
   *  after it validated a fix). Keyed by workspace-relative test path. */
  frozenTestHashes: Record<string, string>
}

export function newReproState(): ReproState {
  return {
    sourceChanged: new Set<string>(),
    testChanged: new Set<string>(),
    nudged: false,
    testsForbidden: false,
    frozenTestHashes: {},
  }
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

// ── STRICT path (W1): fail-to-pass + freeze + pass-to-pass + no-change terminal ──────────────────────
// The permissive gateVerdict above only asks "does a test EXIST". strictGateVerdict additionally consumes
// the harness-run probe results (a fail-to-pass run against the pre-patch tree, a pass-to-pass re-run of the
// suite, a freeze-hash check) and returns dedicated honesty markers. It never rewrites the permissive path:
// when the probe could not run (no base / docker-only / unsupported runner) it DEGRADES to done=true with an
// honest `not-validated (<reason>)` marker — a broken/impossible check must never trap a correct fix.

export const FAKE_STEER =
  "\n\n⚠️ REPRODUCE-FIRST GATE (fail-to-pass): your new test PASSES on the PRE-patch tree too, so it does not " +
  "actually reproduce the issue — a test that is green WITH and WITHOUT your change proves nothing. Rewrite it " +
  "to assert the EXACT behavior the issue describes so it FAILS on the original code and PASSES on your fix, " +
  "then re-run verify_done."
export const SIBLING_STEER =
  "\n\n⚠️ REPRODUCE-FIRST GATE (pass-to-pass): your fix makes the new test green but BREAKS a pre-existing test " +
  "in the project's own suite — a silent regression (the #1 way a scoped green hides real damage). Re-run the " +
  "FULL suite, repair the regression so every existing test still passes, then re-run verify_done."
export const FREEZE_STEER =
  "\n\n⚠️ REPRODUCE-FIRST GATE (freeze): the reproduction test that validated your fix was EDITED after it went " +
  "green. A test cannot be loosened after the fact. Restore a test that genuinely FAILS on the original bug and " +
  "PASSES on your fix, then re-run verify_done."
export const FAILS_POST_STEER =
  "\n\n⚠️ REPRODUCE-FIRST GATE: your reproduction test does not pass on your current code. Make the fix correct " +
  "so the test passes, then re-run verify_done."

/** Probe facts the harness measured this turn (see lib/ftprobe.ts). */
export interface StrictInputs {
  freezeReArmed: boolean          // a frozen test file's content hash changed
  hasSourceChange: boolean        // st.sourceChanged.size > 0
  hasNewTest: boolean             // st.testChanged.size > 0
  noChangePasses: boolean         // no source change + the new test PASSES on the current tree
  ftpRan: boolean                 // the fail-to-pass probe actually ran (else it degraded)
  ftpReason?: string              // why it degraded ("no base" | "docker-only" | "unsupported runner" | "probe error")
  preExit: number | null          // new test on the pre-patch tree
  postExit: number | null         // new test on the current tree
  siblingPassed: boolean | null   // full pre-existing suite on the current tree (null = not checked)
}

export interface StrictVerdict { done: boolean; note: string | null; marks: Record<string, string> }

export function strictGateVerdict(passed: boolean, st: ReproState, x: StrictInputs): StrictVerdict {
  if (!passed) return { done: false, note: null, marks: {} }        // verifyReport already says NOT DONE
  if (st.testsForbidden) return { done: true, note: null, marks: {} } // SWE-bench "source only" stand-down (preserved)
  if (x.freezeReArmed) return { done: false, note: FREEZE_STEER, marks: { freeze: "re-armed" } }
  // no-change terminal (arXiv:2605.07769): a repro added with NO source change, passing on the current tree
  // → the issue is not present; a legitimate verified NO-CHANGE done, not a forced edit.
  if (!x.hasSourceChange && x.hasNewTest) {
    return x.noChangePasses
      ? { done: true, note: null, marks: { failToPass: "no-change (verified)", noChange: "verified" } }
      : { done: true, note: null, marks: {} }
  }
  if (needsRepro(st)) return { done: false, note: REPRO_STEER, marks: {} } // source changed, no test at all
  // source changed + a test exists → strict fail-to-pass
  if (!x.ftpRan) return { done: true, note: null, marks: { failToPass: `not-validated (${x.ftpReason ?? "no base"})` } }
  if (x.postExit !== 0) return { done: false, note: FAILS_POST_STEER, marks: { failToPass: "post-fails" } }
  if (x.preExit === 0) return { done: false, note: FAKE_STEER, marks: { failToPass: "fake (passes on base)" } }
  if (x.siblingPassed === false) return { done: false, note: SIBLING_STEER, marks: { failToPass: "validated", passToPass: "sibling-failed" } }
  return { done: true, note: null, marks: { failToPass: "validated" } }  // fails-pre, passes-post, siblings green
}
