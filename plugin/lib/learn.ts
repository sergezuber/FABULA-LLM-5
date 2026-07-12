// FABULA-LLM-5 — fabula-learn pure logic. Decides when a just-completed change is worth packaging
// into a reusable skill (closing the "skills compound" loop the harness thesis calls for) and holds
// the self-nudge text. No I/O — the plugin wires session state + the tool.execute.after hook.
//
// This is the LIGHT, self-nudged alternative to the guarded auto-distill pass (see fabula-distill-
// guard): it NEVER runs distill for you, it only points at it at the right moment.

export type LearnState = {
  edits: number // source-file edits seen this turn
  tools: number // tool calls seen this turn
  verified: boolean // a verify_done reported green this turn
  nudged: boolean // the learn nudge already fired this turn
}

export function newLearnState(): LearnState {
  return { edits: 0, tools: 0, verified: false, nudged: false }
}

// Below this many source edits a completed change is a one-liner, not a repeatable workflow worth
// packaging. Tuned to avoid nagging on trivial fixes.
export const LEARN_MIN_EDITS = 3

// Worth packaging when a real, multi-step change just landed AND was verified green — a repeatable
// procedure, not a throwaway. Fires at most once per turn (the `nudged` guard).
export function shouldNudgeLearn(st: LearnState, minEdits: number = LEARN_MIN_EDITS): boolean {
  return st.verified && !st.nudged && st.edits >= minEdits
}

export const LEARN_NUDGE =
  "\n\n---\n🎓 LEARN — you just completed and VERIFIED a multi-step change. If this is a workflow you " +
  "might do again, package it now while it is fresh: run `/distill` to turn this trajectory into a " +
  "reusable skill / command (or `save_skill`). Closing the loop here means next time it is one command " +
  "instead of a fresh trajectory. Skip only if this was a genuine one-off."
