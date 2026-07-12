import { describe, expect, test, afterEach } from "bun:test"
import { contextProvenanceFor } from "./provenance"
import { buildReceipt, newReceiptState, renderReceiptMarkdown, renderReceiptJSON } from "./receipt"
import type { ReceiptVerification } from "./receipt"

const PROVENANCE_KEY = "__FABULA_SESSION_PROVENANCE__"
const BELT_KEY = "__FABULA_SESSION_BELT__"

const ENTRY = {
  bundlePrefixHash: "a".repeat(64),
  systemHash: "b".repeat(64),
  toolsHash: "c".repeat(64),
  toolCount: 104,
  modelID: "qwen-test",
  engineVersion: "0.0.0-test",
  at: 1,
  step: 7,
}

function setChannel(key: string, sid: string, value: unknown) {
  const g = globalThis as Record<string, unknown>
  if (!(g[key] instanceof Map)) g[key] = new Map()
  ;(g[key] as Map<string, unknown>).set(sid, value)
}

afterEach(() => {
  const g = globalThis as Record<string, unknown>
  for (const k of [PROVENANCE_KEY, BELT_KEY]) if (g[k] instanceof Map) (g[k] as Map<string, unknown>).clear()
})

describe("contextProvenanceFor", () => {
  test("undefined without a published entry or session id", () => {
    expect(contextProvenanceFor(undefined)).toBeUndefined()
    expect(contextProvenanceFor("ses_none")).toBeUndefined()
  })

  test("joins engine digest with router decision", () => {
    setChannel(PROVENANCE_KEY, "ses_1", ENTRY)
    setChannel(BELT_KEY, "ses_1", { profileId: "coding", hide: [], hideGlobs: [], watermark: "msg_42" })
    const p = contextProvenanceFor("ses_1")
    expect(p?.bundlePrefixHash).toBe(ENTRY.bundlePrefixHash)
    expect(p?.routerProfile).toBe("coding")
    expect(p?.routerWatermark).toBe("msg_42")
    expect(p?.step).toBe(7)
  })

  test("router off → digest only, no router fields", () => {
    setChannel(PROVENANCE_KEY, "ses_2", ENTRY)
    const p = contextProvenanceFor("ses_2")
    expect(p?.bundlePrefixHash).toBe(ENTRY.bundlePrefixHash)
    expect(p?.routerProfile).toBeUndefined()
  })

  test("inputHash passes through when the engine published it; absent stays absent", () => {
    setChannel(PROVENANCE_KEY, "ses_ih", { ...ENTRY, inputHash: "d".repeat(64) })
    expect(contextProvenanceFor("ses_ih")?.inputHash).toBe("d".repeat(64))
    setChannel(PROVENANCE_KEY, "ses_no_ih", ENTRY)
    expect(contextProvenanceFor("ses_no_ih")?.inputHash).toBeUndefined()
  })
})

describe("receipt with provenance", () => {
  const verify: ReceiptVerification = { cmd: "bun test", exitCode: 0, passed: true, outputTail: "ok" }
  const base = {
    state: newReceiptState(),
    verify,
    diff: "diff --git a/x b/x\n",
    workdir: "/tmp/x",
    mintedAt: 1000,
  }

  test("provenance lands in JSON and markdown; absent stays absent (v0 compat)", () => {
    setChannel(PROVENANCE_KEY, "ses_3", ENTRY)
    setChannel(BELT_KEY, "ses_3", { profileId: "coding", watermark: "msg_9" })
    const withProv = buildReceipt({ ...base, provenance: contextProvenanceFor("ses_3") })
    const j = JSON.parse(renderReceiptJSON(withProv))
    expect(j.provenance.bundlePrefixHash).toBe(ENTRY.bundlePrefixHash)
    expect(j.provenance.routerProfile).toBe("coding")
    const md = renderReceiptMarkdown(withProv)
    expect(md).toContain("## Context provenance")
    expect(md).toContain(ENTRY.bundlePrefixHash.slice(0, 16))
    expect(md).toContain("router profile:** coding")

    const withoutProv = buildReceipt({ ...base })
    expect(JSON.parse(renderReceiptJSON(withoutProv)).provenance).toBeUndefined()
    expect(renderReceiptMarkdown(withoutProv)).not.toContain("Context provenance")
  })

  test("byte-stability line: held at 0 breaks, loud warning otherwise", () => {
    setChannel(PROVENANCE_KEY, "ses_4", { ...ENTRY, midTurnBreaks: 0 })
    const held = renderReceiptMarkdown(buildReceipt({ ...base, provenance: contextProvenanceFor("ses_4") }))
    expect(held).toContain("byte-stability:** held")

    setChannel(PROVENANCE_KEY, "ses_5", { ...ENTRY, midTurnBreaks: 2 })
    const broken = renderReceiptMarkdown(buildReceipt({ ...base, provenance: contextProvenanceFor("ses_5") }))
    expect(broken).toContain("2 unplanned mid-turn prefix change(s)")
  })

  test("v0.2 identity fields render honestly: input hash, descriptor (not-a-weights-hash), real weights digest", () => {
    setChannel(PROVENANCE_KEY, "ses_6", { ...ENTRY, inputHash: "d".repeat(64) })
    const prov = {
      ...contextProvenanceFor("ses_6")!,
      modelDescriptorHash: "e".repeat(64),
      modelDescriptor: { id: "qwen-test", arch: "qwen3_5_moe", quantization: "4bit", publisher: "froggeric" },
      weightsDigest: { digest: "f".repeat(64), files: 3, bytes: 21_500_000_000 },
    }
    const md = renderReceiptMarkdown(buildReceipt({ ...base, provenance: prov }))
    expect(md).toContain(`input:** \`${"d".repeat(16)}\``)
    expect(md).toContain("not a weights hash") // descriptor line must self-declare what it is NOT
    expect(md).toContain("qwen3_5_moe · 4bit · froggeric")
    expect(md).toContain("21.50 GB actually hashed")
    const j = JSON.parse(renderReceiptJSON(buildReceipt({ ...base, provenance: prov })))
    expect(j.provenance.inputHash).toBe("d".repeat(64))
    expect(j.provenance.modelDescriptorHash).toBe("e".repeat(64))
    expect(j.provenance.weightsDigest.files).toBe(3)
  })
})
