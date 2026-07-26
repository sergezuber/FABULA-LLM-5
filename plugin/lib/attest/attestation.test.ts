import { describe, test, expect } from "bun:test"
import { buildAttestation, upsertAttestation, outcomeFor, sha256, ATTESTATION_FILE } from "./attestation"
import type { Claim } from "./types"

const claim = (id: string, over: Partial<Claim> = {}): Claim =>
  ({ id, text: `claim ${id}`, type: "citation", loadBearing: false, ...over } as Claim)

describe("attestation record", () => {
  test("the deliverable is identified by its exact bytes", () => {
    const a = buildAttestation({ deliverable: "hello", sources: [], claims: [], deterministic: {} })
    expect(a.deliverableSha256).toBe(sha256("hello"))
    expect(buildAttestation({ deliverable: "hello ", sources: [], claims: [], deterministic: {} })
      .deliverableSha256).not.toBe(a.deliverableSha256)
  })

  test("sources are recorded by content, so a re-run can prove it read the same ones", () => {
    const a = buildAttestation({
      deliverable: "d", sources: [{ label: "ch1", text: "once upon a time" }], claims: [], deterministic: {},
    })
    expect(a.sources[0]).toEqual({ label: "ch1", sha256: sha256("once upon a time") })
  })

  test("a deterministic outcome is kept as the fact it is", () => {
    const a = buildAttestation({
      deliverable: "d", sources: [], claims: [claim("c1")], deterministic: { c1: "PASS" },
    })
    expect(a.claims[0].outcome).toBe("PASS")
    expect(a.replay.deterministic).toBe(true)
  })

  test("a verdict only the model could reach is recorded as an honest absence, never as a pass", () => {
    // temperature 0.4, no seed, model resolved as whatever was loaded — a reader cannot reproduce it.
    const a = buildAttestation({
      deliverable: "d", sources: [], claims: [claim("c1")], deterministic: {},
      modelVerdicts: { c1: "confirmed" },
    })
    expect(a.claims[0].outcome).toBe("unverifiable-here")
    expect(a.tally["unverifiable-here"]).toBe(1)
  })

  test("a refuted model verdict is ALSO an absence — the record does not launder it into a fact", () => {
    const a = buildAttestation({
      deliverable: "d", sources: [], claims: [claim("c1")], deterministic: {},
      modelVerdicts: { c1: "refuted" },
    })
    expect(a.claims[0].outcome).toBe("unverifiable-here")
  })

  test("the deterministic layer wins when both spoke — it is the one a reader can re-run", () => {
    expect(outcomeFor("SIGNAL", "confirmed")).toBe("SIGNAL")
  })

  test("the note says plainly when nothing here is reproducible", () => {
    const a = buildAttestation({
      deliverable: "d", sources: [], claims: [claim("c1")], deterministic: {},
      modelVerdicts: { c1: "confirmed" },
    })
    expect(a.replay.deterministic).toBe(false)
    expect(a.replay.note).toContain("nothing here is reproducible")
  })

  test("load-bearing and attribution survive into the record", () => {
    const a = buildAttestation({
      deliverable: "d", sources: [], claims: [claim("c1", { loadBearing: true, attribution: "ch3" })],
      deterministic: { c1: "PASS" },
    })
    expect(a.claims[0].loadBearing).toBe(true)
    expect(a.claims[0].attribution).toBe("ch3")
  })

  test("re-checking the same text REPLACES what was said about it", () => {
    const first = buildAttestation({ deliverable: "d", sources: [], claims: [claim("c1")], deterministic: { c1: "PASS" } })
    const second = buildAttestation({ deliverable: "d", sources: [], claims: [claim("c1")], deterministic: { c1: "SIGNAL" } })
    const out = upsertAttestation([first], second)
    expect(out).toHaveLength(1)
    expect(out[0].claims[0].outcome).toBe("SIGNAL")
  })

  test("a different deliverable is kept alongside, not overwritten", () => {
    const a = buildAttestation({ deliverable: "one", sources: [], claims: [], deterministic: {} })
    const b = buildAttestation({ deliverable: "two", sources: [], claims: [], deterministic: {} })
    expect(upsertAttestation([a], b)).toHaveLength(2)
  })

  test("a malformed file normalises instead of throwing", () => {
    const a = buildAttestation({ deliverable: "d", sources: [], claims: [], deterministic: {} })
    for (const junk of [null, "nope", 42, [{ no: "key" }]]) {
      expect(upsertAttestation(junk, a)).toHaveLength(1)
    }
  })

  test("it is pure — same inputs, byte-identical record", () => {
    const mk = () => buildAttestation({
      deliverable: "d", sources: [{ label: "s", text: "t" }], claims: [claim("c1")], deterministic: { c1: "PASS" },
    })
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()))
  })

  test("it sits beside the witness record, by the same reasoning", () => {
    expect(ATTESTATION_FILE).toBe("attestations.json")
  })
})
