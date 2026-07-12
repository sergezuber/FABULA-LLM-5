import { test, expect, describe } from "bun:test"
import {
  witnessPrompt,
  parseWitness,
  witnessTargetFromEnv,
  isIndependent,
  modelFamily,
  witnessEntry,
  upsertWitness,
  attested,
  type WitnessTarget,
} from "./witness"

const T: WitnessTarget = { providerId: "nvidia", model: "qwen3.6-70b", baseURL: "https://api.x/v1", apiKeyRef: "k" }

describe("witnessPrompt", () => {
  const msgs = witnessPrompt("- old\n+ new", "fix the bug")
  test("adversarial system + parseable verdict contract", () => {
    expect(msgs[0].role).toBe("system")
    expect(msgs[0].content).toContain("adversarial")
    expect(msgs[0].content).toContain("VERDICT: CONFIRMED")
    expect(msgs[0].content).toContain("VERDICT: DISPUTED")
  })
  test("includes the task and the diff", () => {
    expect(msgs[1].content).toContain("fix the bug")
    expect(msgs[1].content).toContain("+ new")
  })
})

describe("parseWitness — verdict on the first lines", () => {
  test("CONFIRMED", () => {
    expect(parseWitness("VERDICT: CONFIRMED\nThe boundary is inclusive; tests cover it.").verdict).toBe("confirmed")
  })
  test("DISPUTED", () => {
    const r = parseWitness("VERDICT: DISPUTED\nOff-by-one on the end date.")
    expect(r.verdict).toBe("disputed")
    expect(r.detail).toContain("Off-by-one")
  })
  test("case-insensitive + bare word", () => {
    expect(parseWitness("verdict: disputed — nope").verdict).toBe("disputed")
    expect(parseWitness("Looks confirmed to me").verdict).toBe("confirmed")
  })
  test("neither → unclear (never guess a pass)", () => {
    expect(parseWitness("hmm, I am not sure about this").verdict).toBe("unclear")
  })
  test("empty → unclear", () => {
    expect(parseWitness("").verdict).toBe("unclear")
  })
  test("reasoning-first output: explicit VERDICT at the END is found (the live socket case)", () => {
    const r = parseWitness(
      "Let me analyze the diff.\nThe bound changed from <= to <.\nThat looks correct overall.\n\nVERDICT: CONFIRMED\nRetry count now matches maxRetries.",
    )
    expect(r.verdict).toBe("confirmed")
    expect(r.detail).toContain("Retry count")
  })
  test("multiple explicit verdicts: the LAST one is the final answer", () => {
    expect(parseWitness("VERDICT: CONFIRMED\n…wait, the offset math is wrong.\nVERDICT: DISPUTED\nskips rows").verdict).toBe("disputed")
  })
  test("a bare word deep inside reasoning is NOT a verdict (head-only fallback)", () => {
    expect(parseWitness("line1\nline2\nline3\nline4 the change was confirmed by tests earlier").verdict).toBe("unclear")
  })
})

describe("witnessTargetFromEnv", () => {
  test("full env → target", () => {
    expect(
      witnessTargetFromEnv({ FABULA_WITNESS_MODEL: "gpt-x", FABULA_WITNESS_URL: "https://o/v1", FABULA_WITNESS_API_KEY: "sk" }),
    ).toEqual({ providerId: "witness", model: "gpt-x", baseURL: "https://o/v1", apiKeyRef: "sk" })
  })
  test("provider override", () => {
    expect(witnessTargetFromEnv({ FABULA_WITNESS_MODEL: "m", FABULA_WITNESS_URL: "u", FABULA_WITNESS_PROVIDER: "openai" })?.providerId).toBe("openai")
  })
  test("missing model or url → null (fall back to config)", () => {
    expect(witnessTargetFromEnv({ FABULA_WITNESS_MODEL: "m" })).toBeNull()
    expect(witnessTargetFromEnv({ FABULA_WITNESS_URL: "u" })).toBeNull()
    expect(witnessTargetFromEnv({})).toBeNull()
  })
})

describe("modelFamily — vendor/lineage detection", () => {
  test("known families, with provider prefixes and versions", () => {
    expect(modelFamily("gpt-4o-mini")).toBe("openai")
    expect(modelFamily("openai/o3-pro")).toBe("openai")
    expect(modelFamily("qwen3.6-35b-a3b-nvidia-nvfp4-512k")).toBe("qwen")
    expect(modelFamily("deepseek-v4-flash")).toBe("deepseek")
    expect(modelFamily("GLM-4.5")).toBe("glm")
    expect(modelFamily("meta-llama/Llama-3.3-70B")).toBe("llama")
    expect(modelFamily("rwkv6-7b")).toBe("rwkv")
  })
  test("unknown vendor → conservative name-stem fallback (digits stripped, descriptors ignored)", () => {
    expect(modelFamily("mycoder-7b")).toBe("mycoder")
    expect(modelFamily("mycoder2-70b-instruct")).toBe("mycoder")
  })
})

describe("isIndependent — a witness can't be the author OR the author's family", () => {
  test("same model id → not independent", () => {
    expect(isIndependent({ ...T, model: "qwen-35b" }, "qwen-35b")).toBe(false)
    expect(isIndependent({ ...T, model: "Qwen-35B" }, "qwen-35b")).toBe(false)
  })
  test("SAME FAMILY, different id → NOT independent (the gpt-4o vs gpt-4o-mini hole)", () => {
    expect(isIndependent({ ...T, model: "gpt-4o" }, "gpt-4o-mini")).toBe(false)
    expect(isIndependent({ ...T, model: "o3-pro" }, "gpt-4o")).toBe(false)
    expect(isIndependent(T, "qwen-35b")).toBe(false) // qwen3.6-70b vs qwen-35b: both qwen
  })
  test("unknown vendors: shared lineage stem → NOT independent, vendor prefix included", () => {
    expect(isIndependent({ ...T, model: "mycoder-70b" }, "mycoder-7b")).toBe(false)
    expect(isIndependent({ ...T, model: "acme/coolmodel2-large" }, "coolmodel-9b")).toBe(false)
  })
  test("generic descriptors are never lineage: foo-coder vs bar-coder → independent", () => {
    expect(isIndependent({ ...T, model: "foo-coder-7b" }, "bar-coder-33b")).toBe(true)
  })
  test("different family → independent (table wins over shared descriptors)", () => {
    expect(isIndependent({ ...T, model: "glm-4.5" }, "qwen3.6-35b")).toBe(true)
    expect(isIndependent({ ...T, model: "deepseek-v4-flash" }, "gpt-4o")).toBe(true)
    expect(isIndependent({ ...T, model: "rwkv6-7b" }, "qwen3.6-35b")).toBe(true)
    expect(isIndependent({ ...T, model: "qwen2.5-coder" }, "deepseek-coder")).toBe(true)
  })
  test("unknown author → allowed", () => {
    expect(isIndependent(T, undefined)).toBe(true)
  })
})

describe("witness ledger", () => {
  test("entry shape matches the receipt companion", () => {
    expect(witnessEntry(T, "confirmed", 42)).toEqual({ model: "qwen3.6-70b", provider: "nvidia", verdict: "confirmed", method: "diff-review", at: 42 })
  })
  test("upsert replaces the same model's prior verdict", () => {
    const a = witnessEntry(T, "disputed", 1)
    const b = witnessEntry(T, "confirmed", 2)
    const out = upsertWitness([a], b)
    expect(out).toHaveLength(1)
    expect(out[0].verdict).toBe("confirmed")
  })
  test("attested = a confirmed witness and no dispute", () => {
    expect(attested([witnessEntry(T, "confirmed", 1)])).toBe(true)
    expect(attested([witnessEntry(T, "confirmed", 1), witnessEntry({ ...T, model: "gpt" }, "disputed", 2)])).toBe(false)
    expect(attested([witnessEntry(T, "unclear", 1)])).toBe(false)
    expect(attested([])).toBe(false)
  })
})
