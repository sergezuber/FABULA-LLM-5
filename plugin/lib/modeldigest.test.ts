import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  pickDescriptor,
  descriptorHash,
  weightsDigestForDir,
  resolveModelDir,
  loadWeightsCache,
  saveWeightsCache,
  type WeightsCache,
} from "./modeldigest"

// The REAL shape LM Studio's /api/v0/models returns (captured from a live server 2026-07-16).
const LMS_PAYLOAD = {
  object: "list",
  data: [
    {
      id: "qwen3.6-35b-a3b-uncensored-heretic-mlx",
      object: "model",
      type: "llm",
      publisher: "froggeric",
      arch: "qwen3_5_moe",
      compatibility_type: "mlx",
      quantization: "4bit",
      state: "loaded",
      max_context_length: 262144,
    },
    { id: "text-embedding-nomic", object: "model", type: "embeddings" },
  ],
}

describe("pickDescriptor", () => {
  test("finds the serving model in a real LM Studio payload (case-insensitive)", () => {
    const d = pickDescriptor(LMS_PAYLOAD, "QWEN3.6-35B-A3B-UNCENSORED-HERETIC-MLX")
    expect(d).toEqual({
      id: "qwen3.6-35b-a3b-uncensored-heretic-mlx",
      arch: "qwen3_5_moe",
      quantization: "4bit",
      publisher: "froggeric",
      compatibilityType: "mlx",
    })
  })
  test("bare array payload (OpenAI /v1/models shape) also works — extra fields simply absent", () => {
    expect(pickDescriptor([{ id: "gpt-x", object: "model" }], "gpt-x")).toEqual({ id: "gpt-x" })
  })
  test("unknown id / malformed payload → undefined, never a throw", () => {
    expect(pickDescriptor(LMS_PAYLOAD, "nope")).toBeUndefined()
    expect(pickDescriptor(null, "x")).toBeUndefined()
    expect(pickDescriptor("garbage", "x")).toBeUndefined()
    expect(pickDescriptor({ data: "not-an-array" }, "x")).toBeUndefined()
  })
})

describe("descriptorHash", () => {
  test("key order can never change the hash (canonical JSON)", () => {
    const a = descriptorHash({ id: "m", arch: "a", quantization: "q" })
    const b = descriptorHash({ quantization: "q", arch: "a", id: "m" } as any)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
  test("a quant/arch change changes the hash", () => {
    expect(descriptorHash({ id: "m", quantization: "4bit" })).not.toBe(descriptorHash({ id: "m", quantization: "8bit" }))
  })
})

describe("weightsDigestForDir — REAL files, real hashing", () => {
  const make = () => {
    const dir = mkdtempSync(join(tmpdir(), "fab-weights-"))
    mkdirSync(join(dir, "shards"))
    writeFileSync(join(dir, "config.json"), '{"arch":"test"}')
    writeFileSync(join(dir, "shards", "model-00001.bin"), Buffer.alloc(1024 * 1024, 7))
    writeFileSync(join(dir, "shards", "model-00002.bin"), Buffer.alloc(512 * 1024, 9))
    return dir
  }
  test("digest is stable, counts files/bytes, and CHANGES when a weight byte changes", () => {
    const dir = make()
    try {
      const a = weightsDigestForDir(dir)
      const b = weightsDigestForDir(dir)
      expect(a).toBeDefined()
      expect(a!.digest).toBe(b!.digest)
      expect(a!.files).toBe(3)
      expect(a!.bytes).toBe(1024 * 1024 + 512 * 1024 + '{"arch":"test"}'.length)
      writeFileSync(join(dir, "shards", "model-00002.bin"), Buffer.alloc(512 * 1024, 8))
      expect(weightsDigestForDir(dir)!.digest).not.toBe(a!.digest)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("cache is honored on size+mtime match and filled for misses", () => {
    const dir = make()
    try {
      const cache: WeightsCache = {}
      const a = weightsDigestForDir(dir, cache)
      expect(Object.keys(cache).length).toBe(3)
      // poison one cache entry keeping size+mtime → the poisoned sha is TRUSTED (cache semantics)
      const key = Object.keys(cache).find((k) => k.endsWith("model-00001.bin"))!
      cache[key] = { ...cache[key], sha256: "f".repeat(64) }
      expect(weightsDigestForDir(dir, cache)!.digest).not.toBe(a!.digest)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("missing or empty dir → undefined (never a fabricated digest)", () => {
    expect(weightsDigestForDir("/nonexistent/nope")).toBeUndefined()
    const empty = mkdtempSync(join(tmpdir(), "fab-empty-"))
    try {
      expect(weightsDigestForDir(empty)).toBeUndefined()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe("resolveModelDir — LM Studio <root>/<publisher>/<name> layout", () => {
  test("matches the id tail case-insensitively; override wins; nothing → undefined", () => {
    const root = mkdtempSync(join(tmpdir(), "fab-models-"))
    try {
      mkdirSync(join(root, "froggeric", "qwen-test-4bit"), { recursive: true })
      expect(resolveModelDir("org/QWEN-TEST-4bit", root)).toBe(join(root, "froggeric", "qwen-test-4bit"))
      expect(resolveModelDir("missing-model", root)).toBeUndefined()
      expect(resolveModelDir("x", root, join(root, "froggeric", "qwen-test-4bit"))).toBe(join(root, "froggeric", "qwen-test-4bit"))
      expect(resolveModelDir("x", root, "/nonexistent/override")).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("quant-suffix drift between id and dir name matches by prefix (real LM Studio layout)", () => {
    const root = mkdtempSync(join(tmpdir(), "fab-models2-"))
    try {
      // dir carries a -4bit suffix the id doesn't (the real on-disk case)
      mkdirSync(join(root, "froggeric", "Qwen-Test-Heretic-MLX-4bit"), { recursive: true })
      expect(resolveModelDir("qwen-test-heretic-mlx", root)).toBe(join(root, "froggeric", "Qwen-Test-Heretic-MLX-4bit"))
      // and the reverse: id longer than the dir
      mkdirSync(join(root, "acme", "shortname"), { recursive: true })
      expect(resolveModelDir("shortname-q4-km", root)).toBe(join(root, "acme", "shortname"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("weights cache persistence", () => {
  test("roundtrip + corrupt file → {}", () => {
    const dir = mkdtempSync(join(tmpdir(), "fab-cache-"))
    const file = join(dir, "sub", "cache.json")
    try {
      const cache: WeightsCache = { "a.bin": { size: 1, mtimeMs: 2, sha256: "e".repeat(64) } }
      saveWeightsCache(file, cache)
      expect(loadWeightsCache(file)).toEqual(cache)
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(cache)
      writeFileSync(file, "{corrupt")
      expect(loadWeightsCache(file)).toEqual({})
      expect(loadWeightsCache("/nonexistent/c.json")).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
