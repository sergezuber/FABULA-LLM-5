import { test, expect, describe } from "bun:test"
import {
  witnessPrompt,
  parseWitness,
  witnessTargetFromEnv,
  isIndependent,
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

describe("isIndependent — a witness can't be the author", () => {
  test("same model id → not independent", () => {
    expect(isIndependent({ ...T, model: "qwen-35b" }, "qwen-35b")).toBe(false)
    expect(isIndependent({ ...T, model: "Qwen-35B" }, "qwen-35b")).toBe(false)
  })
  test("different model → independent", () => {
    expect(isIndependent(T, "qwen-35b")).toBe(true)
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
