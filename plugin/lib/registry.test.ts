import { test, expect, describe } from "bun:test"
import {
  receiptId,
  receiptStorePath,
  parseReceipt,
  indexEntry,
  matchesQuery,
  searchIndex,
  upsertIndex,
  resolveSource,
  publicUrl,
  type IndexEntry,
} from "./registry"

const RECEIPT = JSON.stringify({
  version: "fabula-receipt/v0",
  mintedAt: 1783675323529,
  model: { id: "qwen3.6-35b-a3b", host: "local" },
  task: '"Fix the export bug. Prove it."',
  base: "1bfcac905f27",
  gates: [{ id: "verify" }, { id: "comprehension" }],
  artifact: { kind: "git-diff", patch: ".fabula/receipts/x.patch" },
  verification: { cmd: "bun test .", exitCode: 0, passed: true, outputTail: "6 pass" },
})

describe("receiptId — content addressing", () => {
  test("same patch + same verify cmd → same id", () => {
    expect(receiptId("diff A", "bun test .")).toBe(receiptId("diff A", "bun test ."))
  })
  test("different patch → different id", () => {
    expect(receiptId("diff A", "bun test .")).not.toBe(receiptId("diff B", "bun test ."))
  })
  test("different verify cmd → different id (can't swap the check under the same patch)", () => {
    expect(receiptId("diff A", "bun test .")).not.toBe(receiptId("diff A", "echo ok"))
  })
  test("id is 64 lowercase hex", () => {
    expect(receiptId("x", "y")).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("receiptStorePath — sharding", () => {
  test("splits into two-char shards", () => {
    expect(receiptStorePath("abcdef1234567890")).toBe("proofs/ab/cd/ef1234567890")
  })
})

describe("parseReceipt", () => {
  test("accepts a real fabula receipt", () => {
    const r = parseReceipt(RECEIPT)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.receipt.verification?.cmd).toBe("bun test .")
  })
  test("rejects invalid JSON", () => {
    expect(parseReceipt("{not json").ok).toBe(false)
  })
  test("rejects a foreign JSON (no fabula version)", () => {
    const r = parseReceipt(JSON.stringify({ hello: "world" }))
    expect(r.ok).toBe(false)
  })
  test("rejects a receipt with no verification command (can't re-verify)", () => {
    const r = parseReceipt(JSON.stringify({ version: "fabula-receipt/v0", verification: {} }))
    expect(r.ok).toBe(false)
  })
})

describe("indexEntry + search", () => {
  const parsed = parseReceipt(RECEIPT)
  const id = "a".repeat(64)
  const e = parsed.ok ? indexEntry(id, parsed.receipt) : (null as never)

  test("tolerates a malformed receipt whose gates is not an array (no crash, gates=[])", () => {
    // parseReceipt only validates version + verification.cmd, so a corrupt receipt.json can carry a
    // non-array `gates` (object/null). indexEntry must not throw on `.map` — it normalizes to [].
    const bad = { version: "fabula-receipt/v0", verification: { cmd: "bun test", passed: true }, gates: { a: 1 } } as any
    expect(() => indexEntry("b".repeat(64), bad)).not.toThrow()
    expect(indexEntry("b".repeat(64), bad).gates).toEqual([])
  })

  test("strips surrounding quotes from task and records the essentials", () => {
    expect(e.task).toBe("Fix the export bug. Prove it.")
    expect(e.model).toBe("qwen3.6-35b-a3b")
    expect(e.host).toBe("local")
    expect(e.gates).toEqual(["verify", "comprehension"])
    expect(e.passed).toBe(true)
  })

  const idx: IndexEntry[] = [
    e,
    { id: "b".repeat(64), task: "add python cli", model: "kimi-k2", host: "cloud", gates: ["verify"], passed: true, base: "", mintedAt: 2000 },
    { id: "c".repeat(64), task: "swe-bench qutebrowser fix", model: "qwen3.6-35b-a3b", host: "local", gates: ["verify", "reproduce"], passed: true, base: "", mintedAt: 3000 },
  ]

  test("matchesQuery is AND across all terms", () => {
    expect(matchesQuery(e, "export prove")).toBe(true)
    expect(matchesQuery(e, "export banana")).toBe(false)
  })
  test("search filters by query and sorts newest first", () => {
    const r = searchIndex(idx, "qwen3.6")
    // e (mintedAt 1783675323529) is newer than c (mintedAt 3000) → e first
    expect(r.map((x) => x.id)).toEqual(["a".repeat(64), "c".repeat(64)])
  })
  test("search by model filter", () => {
    const r = searchIndex(idx, "", { model: "kimi" })
    expect(r).toHaveLength(1)
    expect(r[0].model).toBe("kimi-k2")
  })
  test("search respects limit", () => {
    expect(searchIndex(idx, "", { limit: 1 })).toHaveLength(1)
  })
})

describe("upsertIndex — republish replaces, never duplicates", () => {
  test("same id replaces", () => {
    const a: IndexEntry = { id: "x".repeat(64), task: "old", model: "m", host: "h", gates: [], passed: false, base: "", mintedAt: 1 }
    const b: IndexEntry = { ...a, task: "new", passed: true, mintedAt: 2 }
    const out = upsertIndex([a], b)
    expect(out).toHaveLength(1)
    expect(out[0].task).toBe("new")
  })
})

describe("resolveSource", () => {
  test("64-hex → id lookup", () => {
    expect(resolveSource("A".repeat(64))).toEqual({ kind: "id", id: "a".repeat(64) })
  })
  test("http(s) → url", () => {
    expect(resolveSource("https://x.com/r.json")).toEqual({ kind: "http", url: "https://x.com/r.json" })
  })
  test("bare path and file:// → file", () => {
    expect(resolveSource("/tmp/r.json")).toEqual({ kind: "file", path: "/tmp/r.json" })
    expect(resolveSource("file:///tmp/r.json")).toEqual({ kind: "file", path: "/tmp/r.json" })
  })
})

describe("publicUrl — real link only when a remote exists", () => {
  test("no remote → null (never fabricate a public URL)", () => {
    expect(publicUrl(undefined, "a".repeat(64))).toBeNull()
  })
  test("github ssh/https remote → tree URL", () => {
    const id = "ab" + "c".repeat(62)
    expect(publicUrl("git@github.com:me/fabula-registry.git", id)).toBe(
      `https://github.com/me/fabula-registry/tree/main/${receiptStorePath(id)}`,
    )
    expect(publicUrl("https://github.com/me/fabula-registry", id)).toBe(
      `https://github.com/me/fabula-registry/tree/main/${receiptStorePath(id)}`,
    )
  })
})
