// fabula-attest — the task contract (design A/F, spec §3). shouldArm is the pure arming predicate; the
// gate engages ONLY when the task declared checkable acceptance criteria (a deliverable with verifiable
// claims), never on a chat/opinion turn. Conclusion-mining (what the task REQUIRED) is folded into the
// gate's single decompose call so a real Contract's conclusions drive load-bearing binding — no extra
// per-message LLM call (the design's cost discipline). Pure, unit-tested.

import type { Contract } from "./types"

export const NAMED_TERMINALS = ["verified", "no-change", "needs-input"] as const

/** Arm the gate iff the task has checkable acceptance criteria (a non-judgment deliverable). Fail-silent:
 *  a contract with no verifiable criteria (a pure chat/opinion turn) does NOT arm. */
export function shouldArm(c: Contract | undefined): boolean {
  if (!c || !c.verifiable) return false
  // if conclusions were mined, at least one must be a real (non-empty) required outcome; with none mined
  // yet, `verifiable` (from the arming pre-screen) is enough to engage.
  if (c.conclusions.length === 0) return true
  return c.conclusions.some((x) => typeof x === "string" && x.trim().length > 0)
}

/** Build a Contract from the cheap arming pre-screen + (optionally) mined conclusions. */
export function buildContract(verifiable: boolean, conclusions: string[] = []): Contract {
  return {
    verifiable,
    conclusions: conclusions.filter((x) => typeof x === "string" && x.trim().length > 0),
    criteria: [],
    terminals: [...NAMED_TERMINALS],
  }
}
