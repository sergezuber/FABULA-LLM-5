// Durable guards for the claim re-checker.
//
// The wave shipped with ZERO tracked coverage: an independent verifier ran 13 wiring mutations and all 13
// left the tracked suite at its usual green. The frozen acceptance suite caught 11 — but a frozen suite is
// retired when its wave ends, and on that day 100% of this mechanism would have been unguarded. Two of the
// 13 were caught by nothing at all, and both are the SAME property: that an ABSENT gate verdict renders
// explicitly as unknown rather than silently as nothing. That property is a decision this wave made on
// purpose (hook order is a glob scan, so the receipt can mint before the gate has spoken) and it was
// protected by no test anywhere.
import { test, expect } from "bun:test"
import { checkIdentity, gateVerdictOf, renderIdentity, renderGate, recheckEnabled, IDENTITY_FIELDS } from "./recheck"

// ── the three states, and the fact that there is no fourth ────────────────────────────────────────
test("a claim the receipt makes and the machine confirms is re-verified", () => {
  const v = checkIdentity({ modelDescriptorHash: "abc" }, { modelDescriptorHash: "abc" })
  expect(v.claims[0]!.state).toBe("re-verified here")
  expect(v.reVerified).toBe(1)
  expect(v.contradicted).toBe(0)
})

test("a claim the machine cannot derive is NOT checkable — never quietly a match", () => {
  const v = checkIdentity({ modelDescriptorHash: "abc" }, {})
  expect(v.claims[0]!.state).toBe("not checkable here")
  expect(v.reVerified).toBe(0)
})

test("a claim the machine contradicts is a failure, in the words of failure", () => {
  // "Contradicted here" was the first wording — precise to its author and invisible to anyone scanning
  // for the ordinary vocabulary. A state nobody can find is a state nobody acts on.
  const v = checkIdentity({ modelDescriptorHash: "abc" }, { modelDescriptorHash: "xyz" })
  expect(v.claims[0]!.state).toBe("contradicted here")
  expect(v.claims[0]!.reason.toLowerCase()).toMatch(/mismatch|does not match|disagree/)
  expect(v.ok).toBe(false)
})

test("a claim the receipt never made stays SILENT — absence of a claim is not a state", () => {
  // Announcing "weights digest: not claimed" on every receipt would be noise wearing the costume of rigour.
  const v = checkIdentity({ modelDescriptorHash: "abc" }, { modelDescriptorHash: "abc" })
  expect(v.claims.length).toBe(1)
  expect(v.claims.map((c) => c.field)).not.toContain("weightsDigest")
})

test("every rendered claim says which of the three it is, by name", () => {
  const v = checkIdentity(
    { modelDescriptorHash: "a", weightsDigest: { digest: "b", files: 1, bytes: 1 }, inputHash: "c" },
    { modelDescriptorHash: "a", weightsDigest: { digest: "ZZZ", files: 1, bytes: 1 } },
  )
  const text = renderIdentity(v)
  for (const c of v.claims) expect(text).toContain(c.field)
  expect(text.toLowerCase()).toMatch(/re-verified here/)
  expect(text.toLowerCase()).toMatch(/mismatch|does not match/)
  expect(text.toLowerCase()).toMatch(/not checkable here/)
})

test("a mismatch anywhere makes the whole verdict not-ok, and the summary says so", () => {
  const v = checkIdentity({ modelDescriptorHash: "a", inputHash: "b" }, { modelDescriptorHash: "a", inputHash: "WRONG" })
  expect(v.ok).toBe(false)
  expect(v.summary.toLowerCase()).toMatch(/mismatch|do not match|disagree/)
})

test("all-unchecked never reads as verified", () => {
  // The honest expectation for most receipts on most machines. It must not look like success.
  const v = checkIdentity(Object.fromEntries(IDENTITY_FIELDS.map((f) => [f, "x"])), {})
  expect(v.reVerified).toBe(0)
  expect(v.summary.toLowerCase()).toContain("not checkable")
  expect(v.summary.toLowerCase()).not.toMatch(/\bverified\b(?!.*not)/)
})

// ── the gate verdict, including its ABSENCE ───────────────────────────────────────────────────────
test("NO gate mark renders as UNKNOWN and never as a pass", () => {
  // This is one of the two properties nothing guarded. Hook order is a glob scan, so the receipt can mint
  // before the gate has stamped anything — and the pre-W8 code minted a plain green in exactly that case.
  const v = gateVerdictOf(undefined)
  expect(v.claim).toBe("unknown")
  expect(v.reason.toLowerCase()).toContain("not a pass")
  expect(renderGate(v)).not.toContain("✅")
})

test("a degraded probe reads as weaker than a validated one", () => {
  const degraded = gateVerdictOf({ failToPass: "not-validated (docker-only)" })
  const validated = gateVerdictOf({ failToPass: "validated" })
  expect(degraded.claim).toBe("degraded")
  expect(validated.claim).toBe("validated")
  // the REASON must carry the cause, or one degradation is indistinguishable from another
  expect(degraded.reason).toContain("docker-only")
  expect(renderGate(degraded)).not.toContain("✅")
  expect(renderGate(validated)).toContain("✅")
})

test("a fake or regressing probe is a failure, not a degradation", () => {
  expect(gateVerdictOf({ failToPass: "fake (passes on base)" }).claim).toBe("failed")
  expect(gateVerdictOf({ failToPass: "post-fails" }).claim).toBe("failed")
  expect(gateVerdictOf({ failToPass: "validated", passToPass: "sibling-failed" }).claim).toBe("failed")
})

test("an unrecognised mark is unknown, never a pass", () => {
  // The safe direction: a verdict this code does not understand must not be read as success.
  const v = gateVerdictOf({ failToPass: "something nobody has written yet" })
  expect(v.claim).toBe("unknown")
  expect(renderGate(v)).not.toContain("✅")
})

// ── the switch ────────────────────────────────────────────────────────────────────────────────────
test("the wave switch is read at CALL time, not captured at import", () => {
  // Shipped twice before as a module-level const, which makes a switch unreachable to every test and to
  // anyone who sets it after start.
  const saved = process.env.FABULA_RECHECK
  try {
    process.env.FABULA_RECHECK = "0"
    expect(recheckEnabled()).toBe(false)
    process.env.FABULA_RECHECK = "1"
    expect(recheckEnabled()).toBe(true)
    delete process.env.FABULA_RECHECK
    expect(recheckEnabled()).toBe(true) // default ON: the cheap checks are the wave's whole point
  } finally {
    saved === undefined ? delete process.env.FABULA_RECHECK : (process.env.FABULA_RECHECK = saved)
  }
})

test("garbage input never throws and never invents a verdict", () => {
  for (const junk of [null, undefined, "nonsense", 42, []]) {
    const v = checkIdentity(junk as any, junk as any)
    expect(v.claims.length).toBe(0)
    expect(v.contradicted).toBe(0)
  }
})
