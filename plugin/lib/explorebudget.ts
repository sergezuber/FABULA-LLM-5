// Exploration-budget steer — PURE logic (fabula-reliability wires it to tool.execute.after).
//
// Measured failure mode on long agentic coding runs with a local reasoning model (SWE-bench Pro
// re-runs, 2026-07-11): the model drowns in read-only exploration — 68 reads + 42 globs in 60 minutes,
// ZERO edits, ZERO verify calls — and the wall-clock budget dies before any implement/verify iteration
// happens. A prompt line ("be efficient") is ignored (RULE #9: unreliable model behavior is a spec for
// a MECHANISM). This module counts successive READ-ONLY tool calls since the last write/verify action
// and, when the count crosses a budget, appends a steer to the NEXT tool result — the strong pattern
// local models actually act on (tool-result steers, not prompt nudges).
//
// Off by default: enabled only when FABULA_EXPLORE_BUDGET is a positive integer (the bench runner sets
// it; any long-task user can too). Fail-open design: unknown tools don't count either way.

import { EDIT_TOOLS, BASH_TOOLS, bashEditsTree } from "./edittools"

/** Pure-read tools that consume budget. (bash counts only when it does NOT mutate the tree.) */
const READ_TOOLS: ReadonlySet<string> = new Set([
  "read", "view", "glob", "grep", "list", "ls", "webfetch", "web_fetch", "codebase_search_agent",
])
/** Action tools that RESET the counter: edits (progress) and verify (the loop we want). */
const RESET_TOOLS: ReadonlySet<string> = new Set(["verify_done", ...EDIT_TOOLS])

export interface ExploreState {
  reads: number
  steers: number
}

export function newExploreState(): ExploreState {
  return { reads: 0, steers: 0 }
}

/** Max steers per turn — nag-proofing; after that the loop-guard / verify gates own the problem. */
export const MAX_STEERS = 3

export function exploreSteer(budget: number, reads: number): string {
  return (
    `\n\n⏰ EXPLORATION BUDGET: ${reads} consecutive read-only calls (read/glob/grep) with NO edit and NO ` +
    "verify. You have the task statement and its REQUIREMENTS — stop exploring and IMPLEMENT now: make " +
    "the first source edit that satisfies the first unmet requirement, then run verify_done and iterate " +
    "on its real output. Exploring further will exhaust the time budget before verification can run."
  )
}

/**
 * Observe one tool call. Returns a steer string to append to THIS tool's result when the budget is
 * crossed (fires at each multiple of `budget`, at most MAX_STEERS times per turn), else null.
 * `command` is the bash command when the tool is a bash tool (a tree-mutating bash counts as an edit).
 */
export function observeExplore(
  st: ExploreState,
  toolName: string,
  budget: number,
  command?: string | null,
): string | null {
  if (!Number.isFinite(budget) || budget <= 0) return null
  if (RESET_TOOLS.has(toolName)) { st.reads = 0; return null }
  if (BASH_TOOLS.has(toolName)) {
    if (bashEditsTree(command)) { st.reads = 0; return null }
    st.reads++ // read-only shell (cat/ls/find/…) consumes budget
  } else if (READ_TOOLS.has(toolName)) {
    st.reads++
  } else {
    return null // neutral tool: neither consumes nor resets
  }
  if (st.reads > 0 && st.reads % budget === 0 && st.steers < MAX_STEERS) {
    st.steers++
    return exploreSteer(budget, st.reads)
  }
  return null
}
