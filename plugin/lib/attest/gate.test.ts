import { test, expect } from "bun:test"
import { runAttestGate, type AuxFn } from "./gate"
import { detectStripped } from "./remediation"
import type { SourceDoc, Contract, LedgerView } from "./types"

const CORPUS: SourceDoc[] = [{ label: "ch01", text: "The cup was warm on its own. Correlation reached 0.9999." }]
const contract: Contract = { verifiable: true, conclusions: [], criteria: [], terminals: ["verified"] }
const ledger: LedgerView = { readLabels: ["ch01"], partial: true }

// deterministic mock model: returns the given decomposition; on an entail prompt, FABRICATION iff the
// claim mentions "moon", else FAITHFUL.
const mockAux = (decompose: string): AuxFn => async (prompt: string) => {
  if (prompt.includes("Extract the atomic")) return { text: decompose }
  const claim = /CLAIM:\s*(.+)/i.exec(prompt)?.[1] || ""
  return { text: `VERDICT: ${/moon/i.test(claim) ? "FABRICATION" : "FAITHFUL"}\nSPAN: NONE\nCONFIDENCE: 0.9` }
}

test("full pipeline (mock aux): clean claims pass free; only the fabrication spends an entail call and is refuted", async () => {
  const decompose = [
    "«The cup was warm on its own.» @@ ch01", // verbatim → PASS, no entail
    "«The moon wept over the silent archive.» @@ ch01", // not in corpus → SIGNAL → entail FABRICATION → refuted
    "correlation reached 0.9999 @@ ch01", // number present → PASS, no entail
  ].join("\n")
  const out = await runAttestGate({ deliverable: "A written analysis. ".repeat(4), sources: CORPUS, ledger, contract, callAux: mockAux(decompose), budget: 6 })
  expect(out.verdict.done).toBe(false) // the fabrication blocks done
  expect(out.steer).toContain("NOT YET DONE")
  expect(out.steer.toLowerCase()).toContain("moon") // the specific refuted claim, with a typed repair
  expect(out.auxCalls).toBe(2) // 1 decompose + 1 entail — cost inversion (NOT 3 entails for 3 claims)
  const refuted = out.results.filter((r) => r.verdict === "refuted")
  expect(refuted.length).toBe(1)
  expect(refuted[0].failure).toBe("fabrication")
})

test("full pipeline (mock aux): an all-grounded deliverable → done, ZERO entail calls (only decompose)", async () => {
  const decompose = ["«The cup was warm on its own.» @@ ch01", "correlation reached 0.9999 @@ ch01"].join("\n")
  const out = await runAttestGate({ deliverable: "x".repeat(60), sources: CORPUS, ledger, contract, callAux: mockAux(decompose), budget: 6 })
  expect(out.verdict.done).toBe(true)
  expect(out.steer).toBe("")
  expect(out.auxCalls).toBe(1) // decompose only; deterministic PASS needs no model
})

test("full pipeline: aux unreachable → degrade to silence, never throw (fail-open, never traps a correct deliverable)", async () => {
  const boom: AuxFn = async () => { throw new Error("no endpoint") }
  const out = await runAttestGate({ deliverable: "x".repeat(60), sources: CORPUS, ledger, contract, callAux: boom, budget: 6 })
  expect(out.verdict.done).toBe(true)
  expect(out.steer).toBe("")
})

test("round-over-round: detectStripped flags a load-bearing claim deleted between gate runs (the plugin's Goodhart guard, #3 wired)", async () => {
  const auxWith = (json: string): AuxFn => async (p: string) => (/grounding checker/i.test(p) ? { text: "VERDICT: FABRICATION" } : { text: json })
  // round 1: two load-bearing citation claims (quotes → hard type → load-bearing)
  const r1 = await runAttestGate({ deliverable: "x".repeat(60), sources: CORPUS, ledger, contract, callAux: auxWith(JSON.stringify([{ text: "«claim A not in corpus»" }, { text: "«claim B not in corpus»" }])), budget: 6 })
  // round 2: claim A deleted, only B remains — exactly the pattern the plugin passes to detectStripped
  const r2 = await runAttestGate({ deliverable: "y".repeat(60), sources: CORPUS, ledger, contract, callAux: auxWith(JSON.stringify([{ text: "«claim B not in corpus»" }])), budget: 6 })
  expect(r1.claims.length).toBe(2)
  expect(detectStripped(r1.claims, r2.claims).length).toBe(1) // claim A vanished between rounds → flagged
})

test("gate mines the task's conclusions and returns them (contract wiring, #1)", async () => {
  const aux: AuxFn = async (prompt: string) => {
    if (/grounding checker/i.test(prompt)) return { text: "VERDICT: FAITHFUL\nSPAN: NONE\nCONFIDENCE: 0.9" }
    return { text: JSON.stringify({ conclusions: ["cover every chapter"], claims: [{ text: "«The cup was warm on its own.»", src: "ch01" }] }) }
  }
  const out = await runAttestGate({ deliverable: "x".repeat(60), sources: CORPUS, ledger, contract, callAux: aux, budget: 6, taskText: "analyze the book" })
  expect(out.conclusions).toEqual(["cover every chapter"])
})

test("selfConsistency: a 2nd decomposition is run and merged by union — reconcile is LIVE (#2)", async () => {
  let decomposeCalls = 0
  const aux: AuxFn = async (prompt: string) => {
    if (/grounding checker/i.test(prompt)) return { text: "VERDICT: FABRICATION\nSPAN: NONE\nCONFIDENCE: 0.9" }
    decomposeCalls++
    return decomposeCalls === 1
      ? { text: JSON.stringify([{ text: "«The cup was warm on its own.»", src: "ch01" }]) }
      : { text: JSON.stringify([{ text: "«The cup was warm on its own.»", src: "ch01" }, { text: "«a fabricated moon line»", src: "ch01" }]) }
  }
  const out = await runAttestGate({ deliverable: "x".repeat(60), sources: CORPUS, ledger, contract, callAux: aux, budget: 6, selfConsistency: true })
  expect(decomposeCalls).toBe(2)
  expect(out.claims.length).toBe(2)
})

test("wallclock ceiling: an exceeded deadline skips entailment → unchecked-budget, never a false confirm", async () => {
  const aux: AuxFn = async (prompt: string) => {
    if (/grounding checker/i.test(prompt)) return { text: "VERDICT: FABRICATION" }
    // decompose takes long enough that the 5ms wall-clock is already spent before entailment is considered
    await new Promise((r) => setTimeout(r, 15))
    return { text: JSON.stringify([{ text: "«a fabricated moon line that is not in the corpus at all»", src: "ch01" }]) }
  }
  const out = await runAttestGate({ deliverable: "x".repeat(60), sources: CORPUS, ledger, contract, callAux: aux, budget: 6, wallclockMs: 5 })
  expect(out.results[0].verdict).toBe("unchecked-budget")
})

test("full pipeline: budget cap forces unchecked-budget on a SIGNAL hard claim → blocks done (flood channel closed)", async () => {
  const decompose = ["«The moon wept over the silent archive.» @@ ch01"].join("\n")
  const out = await runAttestGate({ deliverable: "x".repeat(60), sources: CORPUS, ledger, contract, callAux: mockAux(decompose), budget: 0 })
  expect(out.results[0].verdict).toBe("unchecked-budget")
  expect(out.verdict.done).toBe(false) // a load-bearing hard claim left unchecked blocks done
})

// checkConsistency wired via the oracle (design §2 self-contradiction). Source carries BOTH figures, so
// each claim PASSes pass-1 on its own — only the CROSS-claim contradiction can block, and only once the
// oracle confirms the loose numeric-mismatch heuristic is a REAL contradiction.
const NUM_CORPUS: SourceDoc[] = [{ label: "ch01", text: "The review used 9 analysts. Then the review used 7 analysts." }]
// The mined conclusion is UNRELATED to the two claims, so bindLoadBearing marks BOTH non-load-bearing.
// That isolates the contradiction blocker: with no load-bearing claim, `anyRefuted`/`unresolvedHard` are
// both false, so ONLY the anyContradiction path can flip done → the test is non-vacuous for that line.
const contraAux = (verdict: "CONTRADICTION" | "CONSISTENT"): AuxFn => async (prompt: string) => {
  if (/genuinely CONTRADICT/i.test(prompt)) return { text: `VERDICT: ${verdict}\nCONFIDENCE: 0.9` }
  if (/grounding checker/i.test(prompt)) return { text: "VERDICT: FAITHFUL\nSPAN: NONE\nCONFIDENCE: 0.9" }
  return { text: JSON.stringify({ conclusions: ["the deployment pipeline latency"], claims: [{ text: "The review used 9 analysts.", src: "ch01" }, { text: "The review used 7 analysts.", src: "ch01" }] }) }
}
test("cross-claim contradiction: oracle CONFIRMS → both non-load-bearing claims refuted, done blocked purely by the contradiction (checkConsistency now wired)", async () => {
  const out = await runAttestGate({ deliverable: "x".repeat(60), sources: NUM_CORPUS, ledger, contract, callAux: contraAux("CONTRADICTION"), budget: 6 })
  expect(out.results.every((r) => !r.claim.loadBearing)).toBe(true) // neither claim is load-bearing…
  expect(out.verdict.done).toBe(false) // …so done is blocked SOLELY by anyContradiction
  expect(out.results.filter((r) => r.failure === "contradiction").length).toBe(2)
  expect(out.auxCalls).toBe(2) // 1 decompose + 1 contradiction adjudication (both claims PASS pass-1 → no entail)
})
test("cross-claim contradiction: oracle says CONSISTENT → the loose heuristic flag is filtered, done NOT blocked (fail-open)", async () => {
  const out = await runAttestGate({ deliverable: "x".repeat(60), sources: NUM_CORPUS, ledger, contract, callAux: contraAux("CONSISTENT"), budget: 6 })
  expect(out.verdict.done).toBe(true) // a false-positive numeric-mismatch never blocks a grounded deliverable
  expect(out.results.some((r) => r.failure === "contradiction")).toBe(false)
})
test("cross-claim contradiction: no budget for adjudication → not blocked (fail-open, never a raw-heuristic block)", async () => {
  const out = await runAttestGate({ deliverable: "x".repeat(60), sources: NUM_CORPUS, ledger, contract, callAux: contraAux("CONTRADICTION"), budget: 0 })
  expect(out.verdict.done).toBe(true) // budget 0 → the flagged pair is left unadjudicated, never hard-blocked
})
