import { describe, expect, test } from "bun:test"
import { planWindow, DEFAULT_POLICY, type WindowPlanInput , policyFor, noPolicyReason, DEVICE_HEADROOM_FRACTION } from "./windowplan"

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

  // MEASURED 2026-08-01: residentsOther silently DROPPED any model whose size it could not read, and the
  // serving API reports none, so the ceiling was computed as if the machine were empty. Unknown is not
  // zero — treating it as zero is the single reading that can drive the desktop into swap.
  test("a resident of UNKNOWN size makes the plan refuse, not shrink", () => {
    const p = planWindow({ ...base, residents: [{ id: "mystery", bytes: 0 }] })
    expect(p.fits).toBe(false)
    expect(p.tokens).toBe(0)
    expect(p.reason).toContain("could not be measured")
    expect(p.reason).toContain("mystery")
  })

  test("a resident of KNOWN size is still planned around normally", () => {
    const p = planWindow({ ...base, residents: [{ id: "nomic-embed", bytes: 0.5 * GIB }] })
    expect(p.fits).toBe(true)
    expect(p.tokens).toBeGreaterThan(0)
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

// ── Concurrent slots (measured 2026-07-26) ───────────────────────────────────
// `parallel N` does not divide the window: a model at 262144 with parallel 4 took a single request of
// 131 021 tokens and answered from the far end of it. So each slot can fill the window on its own and
// the provisioning has to cover all of them.
describe("planWindow — concurrent slots", () => {
  // The cost this machine actually charges, from the wired-memory delta across a prefill of known size.
  const MEASURED_PER_TOKEN = 108_910

  test("omitting slots keeps the previous one-slot answer", () => {
    const one = planWindow({ ...base, bytesPerToken: MEASURED_PER_TOKEN })
    const explicit = planWindow({ ...base, bytesPerToken: MEASURED_PER_TOKEN, slots: 1 })
    expect(explicit.tokens).toBe(one.tokens)
    expect(explicit.ceilingTokens).toBe(one.ceilingTokens)
  })

  test("more slots divide the ceiling, because each can fill the window", () => {
    const one = planWindow({ ...base, bytesPerToken: MEASURED_PER_TOKEN, slots: 1 })
    const four = planWindow({ ...base, bytesPerToken: MEASURED_PER_TOKEN, slots: 4 })
    expect(four.ceilingTokens).toBeLessThan(one.ceilingTokens)
    // Four slots cost four times the cache, so the ceiling lands near a quarter (quantised down).
    expect(four.ceilingTokens).toBeLessThanOrEqual(Math.floor(one.ceilingTokens / 4) + DEFAULT_POLICY.quantumTokens)
  })

  test("the live provisioning is over budget once its own slots are counted", () => {
    // 262144 / parallel 4 is what the runtime was actually serving on 2026-07-26.
    const plan = planWindow({ ...base, bytesPerToken: MEASURED_PER_TOKEN, slots: 4 })
    expect(plan.tokens).toBeLessThan(262144)
    expect(plan.cappedByMachine).toBe(true)
  })

  test("nonsense slot counts read as the single slot every runtime has", () => {
    const one = planWindow({ ...base, bytesPerToken: MEASURED_PER_TOKEN, slots: 1 })
    for (const bad of [0, -3, Number.NaN]) {
      expect(planWindow({ ...base, bytesPerToken: MEASURED_PER_TOKEN, slots: bad }).tokens).toBe(one.tokens)
    }
  })

  test("the reason names the slot count so a surprising ceiling can be understood", () => {
    expect(planWindow({ ...base, bytesPerToken: MEASURED_PER_TOKEN, slots: 4 }).reason).toContain("4 concurrent slots")
  })

  test("enough slots put even the floor out of reach, and it says so", () => {
    const plan = planWindow({ ...base, bytesPerToken: MEASURED_PER_TOKEN, slots: 64 })
    expect(plan.fits).toBe(false)
    expect(plan.tokens).toBe(0)
  })
})

// ── A POLICY FOR THIS MACHINE ──────────────────────────────────────────────────────────────────────
//
// The defect these close: the four numbers were measured on unified memory and correctly refused
// everywhere else, which left a user with a discrete graphics card without a window plan at all. A
// product cannot be right for one machine and absent for the next.
describe("policyFor: the machine gets a policy, or an honest refusal — never someone else's numbers", () => {
  const GIB = 1024 ** 3

  test("unified memory keeps the numbers that were measured on it", () => {
    expect(policyFor({ kind: "unified", totalBytes: 48 * GIB, usedBytes: 20 * GIB })).toEqual(DEFAULT_POLICY)
    // A CPU-only pool has the same shape — one pool the system can reclaim from — so the same numbers mean
    // the same thing there.
    expect(policyFor({ kind: "cpu-only", totalBytes: 32 * GIB, usedBytes: 8 * GIB })).toEqual(DEFAULT_POLICY)
  })

  test("a discrete card gets a plan, and its reserve is MEASURED rather than judged", () => {
    const p = policyFor({ kind: "discrete-vram", totalBytes: 24 * GIB, usedBytes: 2 * GIB })!
    expect(p).not.toBeNull()
    // What is already held, plus the declared headroom — not the 6 GiB judged for somebody's desktop.
    expect(p.systemReserveBytes).toBe(Math.round(2 * GIB + 24 * GIB * DEVICE_HEADROOM_FRACTION))
    expect(p.systemReserveBytes).not.toBe(DEFAULT_POLICY.systemReserveBytes)
  })

  test("a busier card reserves more, because the reserve is a reading and readings move", () => {
    const idle = policyFor({ kind: "discrete-vram", totalBytes: 24 * GIB, usedBytes: 1 * GIB })!
    const busy = policyFor({ kind: "discrete-vram", totalBytes: 24 * GIB, usedBytes: 9 * GIB })!
    expect(busy.systemReserveBytes).toBeGreaterThan(idle.systemReserveBytes)
  })

  test("an undescribed machine is still refused — absence of a description is not a description", () => {
    expect(policyFor({ kind: "unknown", totalBytes: 0, usedBytes: 0 })).toBeNull()
    expect(policyFor({ kind: "discrete-vram", totalBytes: 0, usedBytes: 0 })).toBeNull()
    expect(noPolicyReason({ kind: "unknown", totalBytes: 0, usedBytes: 0 })).toContain("could not be determined")
  })

  test("END TO END: a card that used to get nothing now gets a window", () => {
    // The live shape of the failure: a machine whose cache lives on a 24 GiB card, weights of 8 GiB, and
    // a per-token cost measured on it. Before, the planner refused before reaching this point.
    const pool = { kind: "discrete-vram" as const, totalBytes: 24 * GIB, usedBytes: 2 * GIB }
    const policy = policyFor(pool)!
    const plan = planWindow({
      policy,
      passportTokens: 262144,
      totalBytes: pool.totalBytes,
      weightsBytes: 8 * GIB,
      bytesPerToken: 120_000,
      residents: [],
      slots: 1,
    })
    expect(plan.tokens).toBeGreaterThan(0)
    expect(plan.tokens).toBeLessThanOrEqual(262144)
  })
})
