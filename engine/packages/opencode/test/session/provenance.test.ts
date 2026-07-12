import { describe, expect, test } from "bun:test"
import {
  computeProvenance,
  publishProvenance,
  provenanceFor,
  clearProvenance,
} from "../../src/session/provenance"

const META = { modelID: "qwen-test", engineVersion: "0.0.0-test" }

describe("computeProvenance", () => {
  test("deterministic: same input → same digests", () => {
    const tools = { read: { description: "Read a file", inputSchema: { jsonSchema: { type: "object" } } } }
    const a = computeProvenance(["sys-a", "sys-b"], tools, META)
    const b = computeProvenance(["sys-a", "sys-b"], tools, META)
    expect(a.bundlePrefixHash).toBe(b.bundlePrefixHash)
    expect(a.bundlePrefixHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test("tool map insertion order does NOT change the digest (content identity)", () => {
    const t1 = { b: { description: "B" }, a: { description: "A" } }
    const t2 = { a: { description: "A" }, b: { description: "B" } }
    expect(computeProvenance([], t1, META).toolsHash).toBe(computeProvenance([], t2, META).toolsHash)
  })

  test("description change DOES change the digest", () => {
    const t1 = { read: { description: "Read a file" } }
    const t2 = { read: { description: "Read a file." } }
    expect(computeProvenance([], t1, META).toolsHash).not.toBe(computeProvenance([], t2, META).toolsHash)
  })

  test("system part boundaries matter: ['ab','c'] ≠ ['a','bc']", () => {
    expect(computeProvenance(["ab", "c"], {}, META).systemHash).not.toBe(
      computeProvenance(["a", "bc"], {}, META).systemHash,
    )
  })

  test("SDK jsonSchema wrapper and raw schema hash identically", () => {
    const raw = { type: "object", properties: { p: { type: "string" } } }
    const wrapped = { read: { description: "d", inputSchema: { jsonSchema: raw } } }
    const plain = { read: { description: "d", inputSchema: raw } }
    expect(computeProvenance([], wrapped, META).toolsHash).toBe(computeProvenance([], plain, META).toolsHash)
  })

  test("execute closures are ignored (non-serializable members can't blank the digest)", () => {
    const withFn = { read: { description: "d", inputSchema: { jsonSchema: { t: 1 } }, execute: () => {} } }
    const without = { read: { description: "d", inputSchema: { jsonSchema: { t: 1 } } } }
    expect(computeProvenance([], withFn, META).toolsHash).toBe(computeProvenance([], without, META).toolsHash)
  })
})

describe("provenance channel", () => {
  test("publish/get roundtrip; step increments per publish; clear removes", () => {
    const sid = "ses_prov_test"
    clearProvenance(sid)
    const e = computeProvenance(["s"], { t: { description: "x" } }, META)
    const p1 = publishProvenance(sid, { ...e, userMessageID: "msg_1" })
    expect(p1.step).toBe(1)
    const p2 = publishProvenance(sid, { ...e, userMessageID: "msg_1" })
    expect(p2.step).toBe(2)
    expect(provenanceFor(sid)?.bundlePrefixHash).toBe(e.bundlePrefixHash)
    clearProvenance(sid)
    expect(provenanceFor(sid)).toBeUndefined()
  })

  test("mid-turn hash change is a caught cache break; turn-boundary change is not", () => {
    const sid = "ses_prov_break"
    clearProvenance(sid)
    const a = computeProvenance(["s"], { t: { description: "x" } }, META)
    const b = computeProvenance(["s"], { t: { description: "CHANGED" } }, META)
    // step 1: baseline
    expect(publishProvenance(sid, { ...a, userMessageID: "msg_1" }).brokeMidTurn).toBe(false)
    // same turn, same hash — stable
    expect(publishProvenance(sid, { ...a, userMessageID: "msg_1" }).brokeMidTurn).toBe(false)
    // same turn, hash changed — BREAK
    const broke = publishProvenance(sid, { ...b, userMessageID: "msg_1" })
    expect(broke.brokeMidTurn).toBe(true)
    expect(broke.midTurnBreaks).toBe(1)
    // NEW user message, hash changed — legitimate re-selection, not a break
    const turn = publishProvenance(sid, { ...a, userMessageID: "msg_2" })
    expect(turn.brokeMidTurn).toBe(false)
    expect(turn.midTurnBreaks).toBe(1)
    clearProvenance(sid)
  })
})
