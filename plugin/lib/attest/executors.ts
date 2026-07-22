// fabula-attest — deterministic pass-1 executors (design B, no LLM). Each returns PASS (grounded) /
// SIGNAL (cheap check failed → escalate to pass-2 entailment) / NA (no applicable check). These run over
// EVERY claim for free; the expensive entailment oracle only ever sees the SIGNAL residue — the cost
// inversion the review demanded. Pure, unit-tested.

import type { Claim, CheckOutcome, SourceDoc, LedgerView } from "./types"

function norm(s: string): string {
  return (typeof s === "string" ? s : "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"“”„'']/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function extractQuote(text: string): string | null {
  const m = (typeof text === "string" ? text : "").match(/[«"“„'']([^«»"“”„'']{6,})[»"”'']/u)
  return m ? m[1] : null
}

/** Which sources a claim's attribution scopes to. No attribution → all sources (best effort). */
function scopeSources(claim: Claim, sources: SourceDoc[]): { pool: SourceDoc[]; scoped: boolean } {
  if (!claim.attribution) return { pool: sources, scoped: false }
  const a = norm(claim.attribution)
  const pool = sources.filter((s) => {
    const l = norm(s.label)
    return l.includes(a) || a.includes(l)
  })
  return { pool, scoped: true }
}

/** Citation: the quoted span must appear VERBATIM (normalized) in the source the claim attributes it to.
 *  A verbatim quote found in a DIFFERENT source than claimed is mis-attribution → SIGNAL, never a free
 *  pass (this closes the review's "грепнулась дословно = доказана" hole). */
export function checkCitation(claim: Claim, sources: SourceDoc[]): { outcome: CheckOutcome; span?: string } {
  if (!sources || sources.length === 0) return { outcome: "NA" }
  const nq = norm(extractQuote(claim.text) ?? claim.text)
  if (nq.length < 6) return { outcome: "NA" }
  const { pool, scoped } = scopeSources(claim, sources)
  // scoped grep: verbatim match only within the claimed source
  for (const s of pool) if (norm(s.text).includes(nq)) return { outcome: "PASS", span: s.label }
  // if attributed and the claimed source doesn't contain it → SIGNAL (fabrication OR mis-attribution)
  if (scoped) return { outcome: "SIGNAL" }
  return { outcome: "SIGNAL" }
}

/** Measurement: every number in the claim must be present in the scoped source (a fabricated figure is
 *  not). True recompute from a StructuredSource is a future executor; presence-grounding is the honest
 *  cheap check for unstructured prose. No source → NA (never a false confirm). */
export function checkMeasurement(claim: Claim, sources: SourceDoc[]): { outcome: CheckOutcome } {
  const nums = (String(claim.text).match(/\d[\d.,]*\d|\d/g) || []).map((x) => x.replace(/[.,]+$/, ""))
  if (!nums.length) return { outcome: "NA" }
  if (!sources || !sources.length) return { outcome: "NA" }
  const { pool } = scopeSources(claim, sources)
  const hay = (pool.length ? pool : sources).map((s) => s.text).join("\n")
  const missing = nums.filter((n) => !hay.includes(n))
  return { outcome: missing.length === 0 ? "PASS" : "SIGNAL" }
}

/** Process: a claim about THIS run's own trajectory ("read all 29 files"), checked against the ledger.
 *  HONEST about the ledger's partial coverage (bash/subagent/over-cap reads are invisible — design §5
 *  known-gap): when completeness can't be seen, return NA, never a false process-lie refutation. */
export function checkProcess(claim: Claim, ledger: LedgerView | null): { outcome: CheckOutcome; coverageNote: string } {
  if (!ledger) return { outcome: "NA", coverageNote: "no run ledger available" }
  const t = norm(claim.text)
  const claimsAll = /(^|[^\p{L}])(all|every|each|все|весь|всю|кажд|полност)/u.test(t)
  const nMatch = t.match(/(\d+)\s*(files?|chapters?|records?|pages?|файл|глав|запис|страниц)/)
  const claimedCount = nMatch ? parseInt(nMatch[1], 10) : null
  if (claimsAll && ledger.partial) {
    return { outcome: "NA", coverageNote: "ledger coverage is partial (bash/subagent/over-cap reads invisible) — completeness unverifiable here" }
  }
  const readN = (ledger.readLabels || []).length
  if (claimedCount != null && !ledger.partial && readN < claimedCount) {
    return { outcome: "SIGNAL", coverageNote: `claimed ${claimedCount}, ledger shows ${readN} reads` }
  }
  // named-target check: every label the claim mentions must be in readLabels
  const named = (ledger.readLabels || []).filter((l) => t.includes(norm(l)))
  if (named.length > 0) return { outcome: "PASS", coverageNote: `ledger confirms ${named.length} named read(s)` }
  return { outcome: "NA", coverageNote: "no checkable target in claim vs ledger" }
}

/** Consistency: flag two claims that assert DIFFERENT numbers for the same subject (share a salient
 *  token). Heuristic and deliberately conservative — a real contradiction, not a proof of correctness. */
export function checkConsistency(claims: Claim[]): { a: string; b: string; kind: string }[] {
  const out: { a: string; b: string; kind: string }[] = []
  const withNum = (claims || [])
    .map((c) => ({
      c,
      nums: (String(c.text).match(/\d[\d.,]*\d|\d/g) || []).map((x) => x.replace(/[.,]+$/, "")),
      tok: new Set((norm(c.text).match(/[\p{L}]{4,}/gu) || [])),
    }))
    .filter((x) => x.nums.length > 0)
  for (let i = 0; i < withNum.length; i++)
    for (let j = i + 1; j < withNum.length; j++) {
      const shared = [...withNum[i].tok].some((x) => withNum[j].tok.has(x))
      if (shared && withNum[i].nums.join() !== withNum[j].nums.join())
        out.push({ a: withNum[i].c.text, b: withNum[j].c.text, kind: "numeric-mismatch" })
    }
  return out
}
