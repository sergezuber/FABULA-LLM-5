// fabula-attest — universal deliverable verification. Shared types.
// Design: docs/research/UNIVERSAL-VERIFY-DESIGN-2026-07-20.md §17 (skeleton v3).
// One invariant everywhere: the gate stays SILENT unless a task's contract declared verifiable
// criteria; a claim is trusted only when its evidence is independently re-derivable (or honestly
// marked). Pure, engine-free, unit-tested.

/** Claim type is assigned by SURFACE FORM (design C), never by the model's self-declaration, and is
 *  sticky: a hard type (citation/measurement/execution/process) can't be downgraded to a soft one
 *  (inference/analogy) to dodge the deterministic check. */
export type ClaimType =
  | "citation" // quotes / references an existing artifact
  | "measurement" // a number/total derived from data
  | "execution" // asserted behavior (tests pass, compiles, 200)
  | "world-state" // a fact about the world (deploy happened, place exists)
  | "process" // a claim about THIS run's own trajectory ("read all 29 files")
  | "inference" // a conclusion from premises (soft, audit-replayable)
  | "analogy" // a comparison ("like Borges") (soft)
  | "judgment" // pure opinion/aesthetic/prediction — never verifiable, only marked

/** Deterministic pass-1 outcome (no LLM). SIGNAL means the cheap check failed → escalate to pass-2. */
export type CheckOutcome = "PASS" | "SIGNAL" | "NA"

/** One coherent verdict model (design D): deterministic layer = binary fact; soft layer = calibrated
 *  with abstain; residue disclosed. No second, conflicting verdict model. */
export type ClaimVerdict =
  | "confirmed"
  | "refuted"
  | "unverifiable-here" // executor absent at runtime — honest, never a false pass
  | "unchecked-budget" // call/wallclock budget exhausted before this claim
  | "judgment-marked"

/** Failure class drives the TYPED remediation action (design E). */
export type FailureClass =
  | "fabrication" // claimed grounded, source does not back it
  | "paraphrase-in-quotes" // faithful paraphrase presented as a verbatim quote
  | "broken-measurement"
  | "unsupported-superlative"
  | "process-lie" // claimed to have read/done X, the ledger says otherwise
  | "contradiction"

export interface Claim {
  id: string
  text: string
  type: ClaimType
  /** for citation/measurement: which source/region the claim attributes it to (mis-attribution guard) */
  attribution?: string
  /** true iff the claim supports a contract-required conclusion (design F, bound post-hoc) */
  loadBearing: boolean
  /** char span of the claim in the deliverable, when known (spec §3 Claim.span) */
  span?: [number, number]
}

/** Mined from the task+env BEFORE the deliverable exists (design A/F). Arms the gate. */
export interface Contract {
  verifiable: boolean // does the task have any checkable acceptance criteria at all?
  conclusions: string[] // the required outcomes of the task
  criteria: string[]
  terminals: Array<"verified" | "no-change" | "needs-input">
}

export interface ClaimResult {
  claim: Claim
  pass1: CheckOutcome
  verdict: ClaimVerdict
  /** the source span the evidence matched (citation/measurement) — for the receipt + the honesty rule */
  evidenceSpan?: string
  failure?: FailureClass
  confidence?: number // soft-layer only (entailment/inference), calibrated
}

export interface GateVerdict {
  done: boolean
  tally: Record<ClaimVerdict, number>
  /** the claims that did not cleanly confirm — disclosed, never hidden */
  residue: ClaimResult[]
  /** ids of load-bearing claims that DISAPPEARED between rounds (Goodhart-by-deletion guard, design E) */
  strippedIds: string[]
}

/** A source document the deterministic executors read (the user's own local files — trusted). */
export interface SourceDoc {
  /** short label used in a claim's `attribution` (e.g. a filename or chapter id) */
  label: string
  text: string
}

/** What the run ledger can honestly report about process-claims. See design §5 known-gap: the ledger
 *  today sees only main-agent read/view within a cap — out of that scope the executor returns NA, never
 *  a false refuted. */
export interface LedgerView {
  /** labels/paths the ledger actually recorded as read this run */
  readLabels: string[]
  /** true if the ledger's coverage is known-partial (bash/subagent/over-cap reads invisible) */
  partial: boolean
}
