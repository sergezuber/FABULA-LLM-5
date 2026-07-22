// fabula-attest — typed remediation (design E). A bare re-entry ("wrong, try again") is the IAL loop the
// review flagged: the model thrashes (fabricates another quote, or DELETES real content to zero the
// count). So each refuted claim carries a class-specific corrective action, and a guard flags
// load-bearing claims that VANISH between rounds (Goodhart-by-deletion). Pure, unit-tested.

import type { Claim, ClaimResult } from "./types"

function clip(s: string, n = 120): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n) + "…" : t
}

/** The corrective action for one refuted claim, keyed on its failure class — NOT a generic nudge. */
export function repairSteer(r: ClaimResult): string {
  const c = clip(r.claim.text)
  const span = r.evidenceSpan ? ` (closest source span: “${clip(r.evidenceSpan, 80)}”)` : ""
  switch (r.failure) {
    case "fabrication":
      return `Not grounded — «${c}»: remove it, or replace with a re-fetched VERBATIM quote from the source. Do NOT invent a different quote.`
    case "paraphrase-in-quotes":
      return `Presented as a verbatim quote but it is a paraphrase${span}: un-quote it or mark it as a paraphrase of that span. Do NOT delete the point.`
    case "broken-measurement":
      return `Number not found in the source — «${c}»: recompute it from the cited source, or remove the figure.`
    case "unsupported-superlative":
      return `Superlative with no grounding — «${c}»: cite specific evidence for it, or cut it.`
    case "process-lie":
      return `Contradicts the run ledger — «${c}»: state only what was actually read/done this run.`
    case "contradiction":
      return `Internal contradiction — «${c}»: reconcile the conflicting figures against the source.`
    default:
      return `Unsupported load-bearing claim — «${c}»: ground it in the source, or explicitly mark it as unverified judgment.`
  }
}

/** Assemble the full re-entry steer from the refuted load-bearing residue (bounded, typed). */
export function buildReentrySteer(residue: ClaimResult[]): string {
  const refuted = (residue || []).filter((r) => r.verdict === "refuted" && r.claim.loadBearing)
  if (!refuted.length) return ""
  const lines = refuted.slice(0, 8).map((r, i) => `${i + 1}. ${repairSteer(r)}`)
  return (
    "\n\n⏳ NOT YET DONE (attest gate) — these load-bearing claims are not grounded. Fix each as directed, " +
    "then continue. Do not remove a claim just to pass; ground it or mark it honestly:\n" +
    lines.join("\n")
  )
}

function key(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

/** Goodhart-by-deletion guard (design E): a load-bearing claim present last round that DISAPPEARED this
 *  round is flagged — the model may be zeroing the "unconfirmed" count by cutting real content instead of
 *  grounding it. Returns the ids of vanished load-bearing claims. */
export function detectStripped(prev: Claim[], cur: Claim[]): string[] {
  const curKeys = new Set((cur || []).map((x) => key(x.text)).filter(Boolean))
  return (prev || [])
    .filter((p) => p.loadBearing && !curKeys.has(key(p.text)))
    .map((p) => p.id)
}
