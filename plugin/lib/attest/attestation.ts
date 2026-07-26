// A durable record of what was checked about a written deliverable — beside the receipt, never inside it.
//
// WHY BESIDE, AND WHY ONLY HALF THE GATE. A receipt is worth something because a stranger can falsify
// it: take the base commit, apply the recorded patch, run the recorded command, get the same answer.
// The deliverable gate has two layers and they are not alike in that respect.
//
// The deterministic layer — citation, measurement, process, consistency — is string and grep work over
// (deliverable, sources). It makes zero model calls; the recorded bench is catch 5/5, false positives
// 0/6. Re-run it on the same bytes tomorrow and it answers the same, which is exactly the property the
// receipt is built on.
//
// The entailment layer is a model call: temperature 0.4, no seed, and the model resolved as whichever
// one the server happened to have loaded — never recorded, so not even nameable after the fact. A third
// party could not obtain it, could not reproduce it, and would get a different answer if they could.
// Putting that in a proof does not strengthen the proof; it weakens the guarantee for the code receipts
// too, because a reader must then sort replayable fields from asserted ones. It is recorded here as
// `unverifiable-here` — the vocabulary the gate already uses for exactly this, an honest absence rather
// than a quiet pass.
//
// And beside rather than inside, following the witness side-car, whose stated invariant is that the
// receipt is NEVER modified. A receipt is defined by its schema as the patch it attests; a deliverable
// that is prose is not that, and widening the definition to hold it would need a new schema version.
// A companion file needs none, and it cannot corrupt what it sits next to.

import { createHash } from "node:crypto"
import type { Claim, ClaimVerdict, CheckOutcome } from "./types"

/** The file name, next to `witnesses.json` in the same directory and by the same reasoning. */
export const ATTESTATION_FILE = "attestations.json"

/** sha256 of exactly these bytes. The deliverable's identity, and what the record is keyed by. */
export function sha256(text: string): string {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex")
}

/** One claim as the record keeps it: what was asserted, of what kind, and how the cheap pass answered. */
export interface AttestedClaim {
  id: string
  type: string
  /** whether the claim carries a conclusion the deliverable's contract requires */
  loadBearing: boolean
  /** what the claim attributes itself to, when it names something */
  attribution?: string
  /** the deterministic outcome — or the honest absence when only the model could have answered */
  outcome: CheckOutcome | "unverifiable-here"
}

export interface Attestation {
  /** identity of the exact text that was checked */
  deliverableSha256: string
  /** the sources it was checked against, by name and content — so a re-run can prove it used the same ones */
  sources: { label: string; sha256: string }[]
  claims: AttestedClaim[]
  /** counts by outcome, so the shape of the result is readable without walking the list */
  tally: Record<string, number>
  /** what a re-run of THIS record would and would not reproduce, stated rather than implied */
  replay: {
    deterministic: boolean
    note: string
  }
}

/**
 * The outcomes the model produced, mapped to the honest absence.
 *
 * A verdict only the producing machine could have reached is not a finding a record may carry as fact.
 * `unverifiable-here` is not a downgrade of the gate's work — the gate still acted on it, in the turn
 * where it ran. It is a statement about what a READER of this file can check.
 */
const MODEL_DECIDED = new Set<ClaimVerdict>(["confirmed", "refuted", "unchecked-budget"])

export function outcomeFor(
  deterministic: CheckOutcome | undefined,
  modelVerdict: ClaimVerdict | undefined,
): CheckOutcome | "unverifiable-here" {
  if (deterministic) return deterministic
  if (modelVerdict && MODEL_DECIDED.has(modelVerdict)) return "unverifiable-here"
  return "unverifiable-here"
}

/** Build the record. PURE — no clock, no filesystem, no network, so the same inputs give the same bytes. */
export function buildAttestation(input: {
  deliverable: string
  sources: { label: string; text: string }[]
  claims: Claim[]
  deterministic: Record<string, CheckOutcome>
  modelVerdicts?: Record<string, ClaimVerdict>
}): Attestation {
  const claims: AttestedClaim[] = (input.claims ?? []).map((c) => ({
    id: c.id,
    type: String(c.type),
    loadBearing: !!c.loadBearing,
    ...(c.attribution ? { attribution: c.attribution } : {}),
    outcome: outcomeFor(input.deterministic?.[c.id], input.modelVerdicts?.[c.id]),
  }))
  const tally: Record<string, number> = {}
  for (const c of claims) tally[c.outcome] = (tally[c.outcome] ?? 0) + 1
  const anyDeterministic = claims.some((c) => c.outcome !== "unverifiable-here")
  return {
    deliverableSha256: sha256(input.deliverable),
    sources: (input.sources ?? []).map((s) => ({ label: s.label, sha256: sha256(s.text) })),
    claims,
    tally,
    replay: {
      deterministic: anyDeterministic,
      note: anyDeterministic
        ? "the outcomes above other than unverifiable-here are string and grep work over the recorded " +
          "bytes: re-run them on the same deliverable and sources and they answer the same"
        : "nothing here was decided without a model, so nothing here is reproducible by a reader",
    },
  }
}

/**
 * Fold a record into the file's contents, newest wins for the same deliverable.
 *
 * Keyed by the deliverable's hash rather than appended blindly: re-checking the same text should
 * replace what was said about it, not accumulate contradictory entries about identical bytes.
 */
export function upsertAttestation(existing: unknown, next: Attestation, cap = 50): Attestation[] {
  const list = Array.isArray(existing) ? (existing as Attestation[]).filter((a) => a?.deliverableSha256) : []
  const kept = list.filter((a) => a.deliverableSha256 !== next.deliverableSha256)
  return [...kept, next].slice(-cap)
}
