// fabula-attest — ONE verdict model (design D), resolving the review's Part-I(binary)⟂Part-II(calibrated)
// contradiction. Deterministic layer = binary fact; soft layer = calibrated with abstain (carried on the
// ClaimResult); residue disclosed, never hidden. "Done" is a typed tally, not a raw judge score. Pure.

import type { ClaimResult, ClaimType, GateVerdict, ClaimVerdict } from "./types"

const HARD: ReadonlySet<ClaimType> = new Set(["citation", "measurement", "execution", "process", "world-state"])

/** Done ⟺ (a) NO load-bearing claim is refuted, AND (b) every load-bearing HARD claim is either confirmed
 *  or honestly marked unverifiable-here. A load-bearing hard claim left `unchecked-budget` therefore
 *  blocks done — which closes the review's flood-to-exhaust-budget-then-pass channel. Soft load-bearing
 *  claims (inference/analogy) and judgment never block done; they are disclosed in the residue/tally. */
export function computeVerdict(results: ClaimResult[]): GateVerdict {
  const tally: Record<ClaimVerdict, number> = {
    confirmed: 0,
    refuted: 0,
    "unverifiable-here": 0,
    "unchecked-budget": 0,
    "judgment-marked": 0,
  }
  for (const r of results || []) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1

  const lb = (results || []).filter((r) => r.claim.loadBearing)
  const anyRefuted = lb.some((r) => r.verdict === "refuted")
  const unresolvedHard = lb.some(
    (r) => HARD.has(r.claim.type) && r.verdict !== "confirmed" && r.verdict !== "unverifiable-here",
  )
  const done = !anyRefuted && !unresolvedHard

  const residue = (results || []).filter((r) => r.verdict !== "confirmed" && r.verdict !== "judgment-marked")
  return { done, tally, residue, strippedIds: [] }
}

/** Map a deterministic pass-1 outcome + optional soft entailment to a single claim verdict. Keeps the
 *  two layers coherent (D): PASS→confirmed; NA on a soft claim→judgment-marked (opinion, disclosed) or
 *  unverifiable-here (hard claim, no executor); SIGNAL resolved by entailment→confirmed|refuted. */
export function claimVerdict(r: {
  type: ClaimType
  pass1: "PASS" | "SIGNAL" | "NA"
  entailFaithful?: boolean
  budgetExhausted?: boolean
}): ClaimVerdict {
  if (r.pass1 === "PASS") return "confirmed"
  if (r.budgetExhausted) return "unchecked-budget"
  if (r.pass1 === "SIGNAL") {
    if (r.entailFaithful === true) return "confirmed"
    if (r.entailFaithful === false) return "refuted"
    return "unchecked-budget" // signalled but entailment not run (budget/no-oracle)
  }
  // pass1 === NA
  if (r.type === "judgment") return "judgment-marked"
  if (HARD.has(r.type)) return "unverifiable-here"
  return "judgment-marked" // soft, no anchor → disclosed as unverified judgment
}
