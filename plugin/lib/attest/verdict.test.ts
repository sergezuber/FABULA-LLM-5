import { test, expect } from "bun:test"
import { computeVerdict, claimVerdict } from "./verdict"
import { repairSteer, buildReentrySteer, detectStripped } from "./remediation"
import { buildEntailPrompt, parseEntail } from "./entailment"
import type { Claim, ClaimResult } from "./types"

const R = ({ claim, ...rest }: Partial<ClaimResult> & { claim: Partial<Claim> }): ClaimResult => ({
  claim: { id: "x", text: "t", type: "citation", loadBearing: true, ...claim } as Claim,
  pass1: "PASS",
  verdict: "confirmed",
  ...rest,
})

test("computeVerdict: done only when no load-bearing refuted AND every load-bearing hard claim is resolved", () => {
  expect(computeVerdict([R({ claim: {}, verdict: "confirmed" })]).done).toBe(true)
  expect(computeVerdict([R({ claim: {}, verdict: "refuted" })]).done).toBe(false)
  // unverifiable-here on a hard load-bearing claim is OK (honest) → done
  expect(computeVerdict([R({ claim: {}, verdict: "unverifiable-here" })]).done).toBe(true)
})

test("computeVerdict: a load-bearing HARD claim left unchecked-budget BLOCKS done (flood channel closed)", () => {
  const v = computeVerdict([
    R({ claim: { type: "citation", loadBearing: true }, verdict: "unchecked-budget" }),
  ])
  expect(v.done).toBe(false)
})

test("computeVerdict: soft/judgment load-bearing claims never block done, but are disclosed", () => {
  const v = computeVerdict([
    R({ claim: { type: "citation", loadBearing: true }, verdict: "confirmed" }),
    R({ claim: { type: "judgment", loadBearing: true }, verdict: "judgment-marked" }),
    R({ claim: { type: "inference", loadBearing: true }, verdict: "unverifiable-here" }),
  ])
  expect(v.done).toBe(true)
  expect(v.tally["judgment-marked"]).toBe(1)
  // residue discloses the unverifiable inference but not the judgment mark
  expect(v.residue.some((r) => r.claim.type === "inference")).toBe(true)
})

test("claimVerdict: layer mapping is coherent", () => {
  expect(claimVerdict({ type: "citation", pass1: "PASS" })).toBe("confirmed")
  expect(claimVerdict({ type: "citation", pass1: "SIGNAL", entailFaithful: false })).toBe("refuted")
  expect(claimVerdict({ type: "citation", pass1: "SIGNAL", entailFaithful: true })).toBe("confirmed")
  expect(claimVerdict({ type: "citation", pass1: "NA" })).toBe("unverifiable-here")
  expect(claimVerdict({ type: "judgment", pass1: "NA" })).toBe("judgment-marked")
  expect(claimVerdict({ type: "measurement", pass1: "SIGNAL", budgetExhausted: true })).toBe("unchecked-budget")
})

test("repairSteer: typed action per failure class (not a generic nudge)", () => {
  expect(repairSteer(R({ claim: { text: "fake" }, verdict: "refuted", failure: "fabrication" }))).toContain("Do NOT invent")
  expect(repairSteer(R({ claim: {}, verdict: "refuted", failure: "paraphrase-in-quotes" }))).toContain("Do NOT delete")
  expect(repairSteer(R({ claim: {}, verdict: "refuted", failure: "process-lie" }))).toContain("ledger")
})

test("buildReentrySteer: only refuted load-bearing claims; empty when none", () => {
  expect(buildReentrySteer([R({ claim: {}, verdict: "confirmed" })])).toBe("")
  const s = buildReentrySteer([R({ claim: { text: "bad" }, verdict: "refuted", failure: "fabrication" })])
  expect(s).toContain("NOT YET DONE")
  expect(s).toContain("Do not remove a claim just to pass")
})

test("detectStripped: a load-bearing claim that vanished between rounds is flagged (Goodhart-by-deletion)", () => {
  const prev: Claim[] = [
    { id: "1", text: "correlation is 0.9999", type: "measurement", loadBearing: true },
    { id: "2", text: "the cup was warm", type: "citation", loadBearing: false },
  ]
  const cur: Claim[] = [{ id: "2", text: "the cup was warm", type: "citation", loadBearing: false }]
  expect(detectStripped(prev, cur)).toEqual(["1"])
})

test("parseEntail: reads the LAST verdict (reasoning-first), extracts span + confidence", () => {
  const reasoned =
    "Let me think... it might be FABRICATION at first glance, but actually the evidence has it.\n" +
    "VERDICT: FAITHFUL\nSPAN: The cup was warm on its own.\nCONFIDENCE: 0.9"
  const r = parseEntail(reasoned)
  expect(r.faithful).toBe(true)
  expect(r.span).toContain("cup was warm")
  expect(r.confidence).toBeCloseTo(0.9)
})

test("parseEntail: no parseable verdict → faithful null (undecided, never a false confirm)", () => {
  expect(parseEntail("I am not sure about this one.").faithful).toBe(null)
})

test("buildEntailPrompt: embeds claim + evidence + the untrusted-data guard", () => {
  const p = buildEntailPrompt({ id: "1", text: "the claim", type: "citation", loadBearing: true }, "some evidence")
  expect(p).toContain("VERDICT: FAITHFUL | FABRICATION")
  expect(p).toContain("untrusted data")
  expect(p).toContain("some evidence")
})
