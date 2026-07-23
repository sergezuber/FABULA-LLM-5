// fabula-attest — the gate orchestrator (design B, the cost-inverted pipeline). callAux is INJECTED so
// the exact same code path runs from the plugin (real aux), a hermetic test (mock aux), and the live
// bench (aux → :1235). Decompose (folding the contract's conclusions in) → type-by-form → optional
// second self-consistency pass merged by executor-aware UNION → free deterministic pass over ALL claims →
// the SIGNAL residue ONLY reaches the quarantined entailment oracle → one verdict model → typed steer.

import { buildDecomposePrompt, parseDecomposeFull } from "./decompose"
import { typeClaim, bindLoadBearing, reconcileDecompositions } from "./claims"
import { checkCitation, checkMeasurement, checkProcess } from "./executors"
import { quarantine } from "./quarantine"
import { buildEntailPrompt, parseEntail } from "./entailment"
import { claimVerdict, computeVerdict } from "./verdict"
import { buildReentrySteer } from "./remediation"
import type { Claim, ClaimResult, Contract, SourceDoc, LedgerView, GateVerdict, CheckOutcome } from "./types"

export type AuxFn = (prompt: string, opts?: any) => Promise<{ text: string }>

export interface GateInput {
  deliverable: string
  sources: SourceDoc[]
  ledger: LedgerView
  contract: Contract
  callAux: AuxFn
  budget: number
  /** the user's task text — folds contract-conclusion mining into the one decompose call */
  taskText?: string
  /** run a 2nd independent decomposition and merge by union (coverage over cost); default off */
  selfConsistency?: boolean
  /** wall-clock ceiling in ms for the whole gate; 0 = none */
  wallclockMs?: number
}
export interface GateOutput {
  verdict: GateVerdict
  steer: string
  claims: Claim[]
  results: ClaimResult[]
  auxCalls: number // measured cost (decompose + entail); the deterministic pass is free
  conclusions: string[] // the task's mined required outcomes (contract), for the caller/receipt
}

function claimsFrom(raw: Array<{ text: string; attribution?: string }>): Claim[] {
  return raw.map((c, i) => ({ id: `a${i}`, text: c.text, type: typeClaim(c.text), attribution: c.attribution, loadBearing: false }))
}

export async function runAttestGate(inp: GateInput): Promise<GateOutput> {
  const empty: GateOutput = { verdict: computeVerdict([]), steer: "", claims: [], results: [], auxCalls: 0, conclusions: [] }
  if (!inp.deliverable || inp.deliverable.length < 40) return empty
  const deadline = inp.wallclockMs && inp.wallclockMs > 0 ? Date.now() + inp.wallclockMs : 0
  const overtime = () => deadline > 0 && Date.now() > deadline

  let auxCalls = 0
  let conclusions: string[] = inp.contract?.conclusions ?? []
  let claims: Claim[]
  try {
    auxCalls++
    const r = parseDecomposeFull((await inp.callAux(buildDecomposePrompt(inp.deliverable, inp.taskText), { maxTokens: 1800, timeoutMs: 120000 })).text)
    if (r.conclusions.length) conclusions = r.conclusions
    claims = claimsFrom(r.claims)
    // optional second independent decomposition → executor-aware UNION (coverage), never intersection
    if (inp.selfConsistency && !overtime()) {
      auxCalls++
      const r2 = parseDecomposeFull((await inp.callAux(buildDecomposePrompt(inp.deliverable, inp.taskText), { maxTokens: 1800, timeoutMs: 120000 })).text)
      claims = reconcileDecompositions(claims, claimsFrom(r2.claims))
    }
  } catch {
    return { ...empty, auxCalls, conclusions } // aux unreachable → degrade to silence, never crash
  }
  if (!claims.length) return { ...empty, auxCalls, conclusions }

  const contract: Contract = { ...(inp.contract ?? { verifiable: true, criteria: [], terminals: ["verified"] }), conclusions }
  claims = bindLoadBearing(claims, contract)

  const results: ClaimResult[] = []
  let budget = inp.budget
  for (const claim of claims) {
    let pass1: CheckOutcome = "NA"
    let span: string | undefined
    if (claim.type === "citation") { const r = checkCitation(claim, inp.sources); pass1 = r.outcome; span = r.span }
    else if (claim.type === "measurement") pass1 = checkMeasurement(claim, inp.sources).outcome
    else if (claim.type === "process") pass1 = checkProcess(claim, inp.ledger).outcome

    let entailFaithful: boolean | undefined
    let failure: ClaimResult["failure"]
    let confidence: number | undefined
    let budgetExhausted = false
    if (pass1 === "SIGNAL") {
      if (budget > 0 && inp.sources.length && !overtime()) {
        budget--
        try {
          const scoped = claim.attribution
            ? inp.sources.filter((s) => s.label.toLowerCase().includes(String(claim.attribution).toLowerCase()))
            : inp.sources
          const evidence = quarantine((scoped.length ? scoped : inp.sources).map((s) => `[${s.label}] ${s.text}`).join("\n\n"), "local-source")
          auxCalls++
          const e = parseEntail((await inp.callAux(buildEntailPrompt(claim, evidence), { maxTokens: 400, timeoutMs: 90000 })).text)
          confidence = e.confidence
          if (e.faithful === true) entailFaithful = true
          else if (e.faithful === false) { entailFaithful = false; failure = claim.type === "measurement" ? "broken-measurement" : "fabrication" }
        } catch { budgetExhausted = true }
      } else budgetExhausted = true // budget spent OR wall-clock exceeded → honest unchecked
    }
    results.push({ claim, pass1, verdict: claimVerdict({ type: claim.type, pass1, entailFaithful, budgetExhausted }), evidenceSpan: span, failure, confidence })
  }

  const verdict = computeVerdict(results)
  return { verdict, steer: verdict.done ? "" : buildReentrySteer(verdict.residue), claims, results, auxCalls, conclusions }
}
