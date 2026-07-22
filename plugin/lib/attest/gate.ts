// fabula-attest — the gate orchestrator (design B, the cost-inverted pipeline). callAux is INJECTED so
// the exact same code path runs from the plugin (real aux), a hermetic test (mock aux), and the live
// bench (aux → :1235). Decompose → type-by-form → free deterministic pass over ALL claims → the SIGNAL
// residue ONLY reaches the quarantined entailment oracle → one verdict model → typed re-entry steer.

import { buildDecomposePrompt, parseDecompose } from "./decompose"
import { typeClaim, bindLoadBearing } from "./claims"
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
}
export interface GateOutput {
  verdict: GateVerdict
  steer: string
  claims: Claim[]
  results: ClaimResult[]
  auxCalls: number // measured cost (decompose + entail); the deterministic pass is free
}

export async function runAttestGate(inp: GateInput): Promise<GateOutput> {
  const empty: GateOutput = { verdict: computeVerdict([]), steer: "", claims: [], results: [], auxCalls: 0 }
  if (!inp.deliverable || inp.deliverable.length < 40) return empty

  let auxCalls = 0
  let raw: Array<{ text: string; attribution?: string }>
  try {
    auxCalls++
    raw = parseDecompose((await inp.callAux(buildDecomposePrompt(inp.deliverable), { maxTokens: 1800, timeoutMs: 120000 })).text)
  } catch {
    return { ...empty, auxCalls } // aux unreachable → degrade to silence, never crash
  }
  if (!raw.length) return { ...empty, auxCalls }

  let claims: Claim[] = raw.map((c, i) => ({ id: `a${i}`, text: c.text, type: typeClaim(c.text), attribution: c.attribution, loadBearing: false }))
  claims = bindLoadBearing(claims, inp.contract)

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
      if (budget > 0 && inp.sources.length) {
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
      } else budgetExhausted = true
    }
    results.push({ claim, pass1, verdict: claimVerdict({ type: claim.type, pass1, entailFaithful, budgetExhausted }), evidenceSpan: span, failure, confidence })
  }

  const verdict = computeVerdict(results)
  return { verdict, steer: verdict.done ? "" : buildReentrySteer(verdict.residue), claims, results, auxCalls }
}
