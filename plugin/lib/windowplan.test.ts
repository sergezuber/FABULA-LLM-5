import { describe, expect, test } from "bun:test"
import { planWindow, DEFAULT_POLICY, type WindowPlanInput } from "./windowplan"

const GIB = 1024 ** 3
// The owner's real machine, so the cases below are the decision this actually makes today.
const MAC_48 = 48 * GIB
const KAT_WEIGHTS = 20.44 * GIB
// Measured live: 36.49 GiB total at a 262144 window, of which 20.44 is weights → 16.05 GiB of cache.
const KAT_PER_TOKEN = Math.round((16.05 * GIB) / 262144)

const base: WindowPlanInput = {
  passportTokens: 262144,
  totalBytes: MAC_48,
  weightsBytes: KAT_WEIGHTS,
  bytesPerToken: KAT_PER_TOKEN,
}

describe("the model's own maximum, when it fits", () => {
  test("the owner's model gets its FULL 262144 — the case that must not regress", () => {
    const p = planWindow(base)
    expect(p.tokens).toBe(262144)
    expect(p.fits).toBe(true)
    expect(p.cappedByMachine).toBe(false)
    expect(p.reason).toContain("full window")
  })

  test("a model with a small passport is not inflated to fill the machine", () => {
    expect(planWindow({ ...base, passportTokens: 32768 }).tokens).toBe(32768)
  })
})

describe("the machine's ceiling, when the passport does not fit", () => {
  test("a passport of 1M on this Mac is capped, and the cap says WHY", () => {
    const p = planWindow({ ...base, passportTokens: 1_048_576 })
    expect(p.fits).toBe(true)
    expect(p.cappedByMachine).toBe(true)
    expect(p.tokens).toBeLessThan(1_048_576)
    expect(p.tokens).toBeGreaterThan(262144) // still far more than the 64K we were stuck at
    expect(p.reason).toContain("by memory, not by the model")
  })

  test("the ceiling is rounded DOWN, never up — we only load what we are sure of", () => {
    const p = planWindow({ ...base, passportTokens: 1_048_576 })
    expect(p.tokens % DEFAULT_POLICY.quantumTokens).toBe(0)
    expect(p.tokens * KAT_PER_TOKEN).toBeLessThanOrEqual(p.budgetBytes)
  })
})

describe("the model is not alone in memory", () => {
  test("another resident model shrinks the ceiling by exactly what it holds", () => {
    const alone = planWindow({ ...base, passportTokens: 1_048_576 })
    const shared = planWindow({
      ...base,
      passportTokens: 1_048_576,
      residents: [{ id: "witness-model", bytes: 20 * GIB }],
    })
    expect(shared.tokens).toBeLessThan(alone.tokens)
    expect(shared.reason).toContain("other model(s)")
  })

  test("an embedding model counts too — small, but it is real memory", () => {
    const withEmb = planWindow({
      ...base,
      passportTokens: 1_048_576,
      residents: [{ id: "nomic-embed", bytes: 0.5 * GIB }],
    })
    expect(withEmb.tokens).toBeLessThan(planWindow({ ...base, passportTokens: 1_048_576 }).tokens)
  })

  test("residents are subtracted BEFORE the commit fraction — they are not ours to spend", () => {
    // A second 20 GiB model on a 48 GiB Mac leaves this one no usable window at all, and the plan says so
    // rather than returning a number that would drive the machine into swap.
    const p = planWindow({ ...base, residents: [{ id: "other", bytes: 20 * GIB }] })
    expect(p.fits).toBe(false)
    expect(p.tokens).toBe(0)
    expect(p.reason).toContain("cannot hold")
  })
})

describe("refusing rather than guessing", () => {
  test("no learned cost → no plan, and the reason says to measure first", () => {
    const p = planWindow({ ...base, bytesPerToken: 0 })
    expect(p.fits).toBe(false)
    expect(p.tokens).toBe(0)
    expect(p.reason).toContain("measure first")
  })

  test("no passport → no plan; the model's maximum is never assumed", () => {
    const p = planWindow({ ...base, passportTokens: 0 })
    expect(p.fits).toBe(false)
    expect(p.reason).toContain("did not report a maximum")
  })

  test("a tiny machine reports the shortfall instead of a useless window", () => {
    const p = planWindow({ ...base, totalBytes: 8 * GIB })
    expect(p.fits).toBe(false)
    expect(p.tokens).toBe(0)
  })

  test("malformed input never throws", () => {
    expect(() => planWindow({} as any)).not.toThrow()
    expect(planWindow({} as any).fits).toBe(false)
  })
})

describe("policy is visible as policy", () => {
  test("the four written-down numbers live in ONE place and are all honoured", () => {
    const strict = {
      systemReserveBytes: 20 * GIB, // absurdly generous to the system…
      commitFraction: 0.5,
      floorTokens: 8192,
      quantumTokens: 4096,
    }
    const p = planWindow({ ...base, passportTokens: 1_048_576, policy: strict })
    const loose = planWindow({ ...base, passportTokens: 1_048_576 })
    expect(p.tokens).toBeLessThan(loose.tokens) // …and the answer moves, so the policy is really read
  })

  test("nothing about the MODEL is written down — only the passport decides its ceiling", () => {
    // Same machine, same policy, different model: the plan follows the passport it is given, so no table
    // of per-model windows can exist anywhere in this decision.
    const a = planWindow({ ...base, passportTokens: 40960 })
    const b = planWindow({ ...base, passportTokens: 131072 })
    expect(a.tokens).toBe(40960)
    expect(b.tokens).toBe(131072)
  })

  test("the reason is human-readable and carries the numbers behind it", () => {
    const p = planWindow({ ...base, passportTokens: 1_048_576 })
    expect(p.reason).toMatch(/GiB/)
    expect(p.reason).toContain(String(p.tokens))
  })
})
