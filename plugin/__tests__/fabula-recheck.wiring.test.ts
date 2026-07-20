// Wiring guard for W8 — the rendered surfaces, not the library under them.
//
// An independent verifier ran 13 wiring mutations. The frozen suite caught 11; TWO were caught by nothing
// at all, and both are the same property: an ABSENT gate verdict must render EXPLICITLY as unknown, on
// both the minted receipt and the verify output. That property is a deliberate decision of this wave —
// hook order is a glob scan, so the receipt can mint before the gate has stamped anything, and the pre-W8
// code minted a plain green in exactly that case. It was protected by no test anywhere.
//
// The frozen suite pins the gate line only when a verdict EXISTS. These two cases pin its absence.
import { test, expect } from "bun:test"
import { renderReceiptMarkdown } from "../lib/receipt"

const base = {
  version: "fabula-receipt/v0",
  mintedAt: 1_700_000_000_000,
  model: { id: "m", host: "local" as const },
  task: "t",
  gates: [{ id: "verify", forced: "ran the suite" }],
  artifact: { files: 1, bytes: 10 },
  verification: { cmd: "bun test", exitCode: 0, passed: true, outputTail: "ok" },
} as any

test("a receipt with NO gate verdict says so explicitly", () => {
  // Mutation C5: make this branch dead and the receipt simply says nothing about the reproduce probe —
  // which reads exactly like a run where the probe passed. Silence is the failure mode.
  const md = renderReceiptMarkdown({ ...base })
  expect(md).toContain("reproduce probe")
  expect(md.toLowerCase()).toContain("no verdict")
  expect(md.toLowerCase()).toContain("not a pass")
})

test("a receipt WITH a verdict carries it, and a degraded one carries its reason", () => {
  const validated = renderReceiptMarkdown({ ...base, gateProof: { claim: "validated", mark: "validated", reason: "reproduce gate VALIDATED: ok" } })
  const degraded = renderReceiptMarkdown({ ...base, gateProof: { claim: "degraded", mark: "not-validated (docker-only)", reason: "reproduce gate DEGRADED: the strict fail-to-pass probe did not run (not-validated (docker-only))" } })
  expect(validated).toContain("VALIDATED")
  expect(degraded).toContain("docker-only")
  // …and the two must not read the same to someone skimming
  expect(validated).not.toBe(degraded)
})

test("the minted receipt states the STATUS of every identity claim it prints", () => {
  // The artifact that outlives the run was the last surface still in the fourth, unstated category: it
  // printed "weights digest: … (2 files, 3.00 GB actually hashed)" — a sentence asserting a measurement —
  // with nothing to say whether anyone had checked it.
  const md = renderReceiptMarkdown({
    ...base,
    provenance: {
      engineVersion: "0", step: 1,
      bundlePrefixHash: "a".repeat(64), systemHash: "b".repeat(64), toolsHash: "c".repeat(64), toolCount: 3,
      modelDescriptorHash: "d".repeat(64), inputHash: "f".repeat(64), routerProfile: "coding", midTurnBreaks: 0,
      weightsDigest: { digest: "e".repeat(64), files: 2, bytes: 3e9 },
    },
  })
  // Iterate the SPEC's six, not the three that happened to be done. The first version of this loop
  // listed exactly the fields already implemented — a test written to the implementation, which can
  // never report the implementation incomplete. It passed while three claims (`input`, `router profile`,
  // `byte-stability`) were still printed bare, and "byte-stability: held" reads as a measured outcome.
  for (const label of ["prefix", "model descriptor", "weights digest", "input", "router profile", "byte-stability"]) {
    const line = md.split("\n").find((l) => l.includes(label))!
    expect(line).toBeTruthy()
    expect(line.toLowerCase()).toContain("not checkable here")
  }
})

test("the switch restores the pre-W8 rendering: no W8 vocabulary at all", () => {
  const saved = process.env.FABULA_RECHECK
  try {
    process.env.FABULA_RECHECK = "0"
    const md = renderReceiptMarkdown({
      ...base,
      gateProof: { claim: "degraded", mark: "not-validated (x)", reason: "degraded" },
      provenance: { engineVersion: "0", step: 1, modelDescriptorHash: "d".repeat(64) },
    })
    expect(md).not.toContain("reproduce probe")
    expect(md.toLowerCase()).not.toContain("not checkable here")
  } finally {
    saved === undefined ? delete process.env.FABULA_RECHECK : (process.env.FABULA_RECHECK = saved)
  }
})
