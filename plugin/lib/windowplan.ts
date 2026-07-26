// How wide a context window to load a model at — computed, never written down.
//
// WHY THIS EXISTS. The window a model runs at was set by hand every time: someone typed a number into
// `lms load --context-length`. Measured 2026-07-25, both directions of that mistake in one day — a model
// whose passport says 262144 was loaded at 65536 because that figure had been typed once, and every
// request then arrived six times larger than the call could hold, so half the prefix was re-prefilled on
// every step and the machine looked hung when it was only queueing. A typed number is a snapshot of a
// decision, and it goes stale the moment the model changes.
//
// THE RULE, in one line: load at the largest window the MODEL supports that the MACHINE can actually
// hold. Both figures are read at the moment of the decision — the passport from the serving API, the
// ceiling from this machine's memory and whatever else is living in it.
//
// WHAT IS AND IS NOT A CONSTANT HERE. Facts about the model — its passport, its weights, the cost of a
// token of window — are never written down; they are read or learned (see lib/kvcost.ts). What IS written
// down is POLICY: how much memory to leave the rest of the computer, and how close to the edge we are
// willing to run. Policy cannot be derived from anything — it is a judgement about how the owner's
// machine should feel to use — so it lives here, named and in one place, rather than dissolved into the
// arithmetic where nobody could find or change it.
//
// NOT A PROBE. The ceiling is computed BEFORE loading, never discovered by trying. On unified memory a
// load that does not fit does not fail cleanly: it drives the whole machine into swap, and the thing that
// becomes unusable is the desktop, not the process. "Try the maximum and back off" is not available here.

/** Memory left to the rest of the computer. POLICY — a judgement, not a measurement. */
export interface WindowPolicy {
  /** Never hand the model memory the system needs to stay responsive. */
  systemReserveBytes: number
  /** Of what remains, the share we are willing to commit. Below 1 so a growing app does not hit the wall. */
  commitFraction: number
  /** A window below this is not worth loading; report the shortfall instead of pretending. */
  floorTokens: number
  /** Windows are rounded DOWN to this, so the figure is stable across tiny memory fluctuations and does
   *  not cause a reload every time a browser tab opens. */
  quantumTokens: number
}

/**
 * The default policy. These four numbers are the ONLY written-down values in this decision, and each is
 * a choice rather than a fact:
 *  - 6 GiB to the system: macOS plus a browser plus the app itself, measured comfortable on a 48 GB Mac.
 *  - 90% of the remainder: leaves room for the working set to breathe without swapping.
 *  - 8192 floor: below this a window buys nothing worth a reload.
 *  - 4096 quantum: coarse enough that ordinary memory noise never moves the answer.
 */
export const DEFAULT_POLICY: WindowPolicy = {
  systemReserveBytes: 6 * 1024 ** 3,
  commitFraction: 0.9,
  floorTokens: 8192,
  quantumTokens: 4096,
}

/** Something else already holding memory: another model, an embedding model, anything loaded. */
export interface Resident {
  id: string
  bytes: number
}

export interface WindowPlanInput {
  /** The model's own maximum, read from the serving API. Never assumed. */
  passportTokens: number
  /** This machine's total memory. */
  totalBytes: number
  /** Weights of the model we are about to load. */
  weightsBytes: number
  /** Learned cost of ONE token of window, in bytes. See lib/kvcost.ts — measured, not tabulated. */
  bytesPerToken: number
  /** Everything else currently resident. The model is not alone: an embedding model and a witness model
   *  can both be loaded, and a ceiling that ignores them is a ceiling that is wrong exactly when it
   *  matters. */
  residents?: readonly Resident[]
  policy?: WindowPolicy
}

export interface WindowPlan {
  /** The window to load at. 0 when not even the floor fits. */
  tokens: number
  /** Did the machine, rather than the model, decide this? */
  cappedByMachine: boolean
  /** Does anything at all fit? */
  fits: boolean
  /** Plain words for the log — a decision nobody can read is a decision nobody can check. */
  reason: string
  /** The arithmetic, so a surprising answer can be understood without re-deriving it. */
  budgetBytes: number
  ceilingTokens: number
}

const GIB = 1024 ** 3
const gib = (b: number) => (b / GIB).toFixed(1)

/** Round DOWN to the policy quantum: a window is only ever what we are sure fits. */
function quantise(tokens: number, q: number): number {
  if (!(q > 0)) return Math.floor(tokens)
  return Math.floor(tokens / q) * q
}

/**
 * Decide the window. PURE — no network, no filesystem, no clock. Everything it knows arrives as an
 * argument, so the same inputs always give the same answer and the decision can be tested exactly.
 */
export function planWindow(input: WindowPlanInput): WindowPlan {
  const policy = input.policy ?? DEFAULT_POLICY
  const passport = Math.max(0, Math.floor(Number(input.passportTokens) || 0))
  const total = Math.max(0, Number(input.totalBytes) || 0)
  const weights = Math.max(0, Number(input.weightsBytes) || 0)
  const perToken = Number(input.bytesPerToken) || 0
  const residents = input.residents ?? []
  const residentBytes = residents.reduce((sum, r) => sum + Math.max(0, Number(r.bytes) || 0), 0)

  // What is left for this model's cache once the system, the other residents and this model's own
  // weights are paid for.
  const available = (total - policy.systemReserveBytes - residentBytes) * policy.commitFraction - weights
  const budgetBytes = Math.max(0, available)

  if (passport <= 0) {
    return {
      tokens: 0, cappedByMachine: false, fits: false, budgetBytes, ceilingTokens: 0,
      reason: "the model did not report a maximum window; nothing to plan from",
    }
  }

  // Without a learned cost we cannot say what a window costs. Refusing is correct: guessing here is the
  // one move that can take the whole machine down with it.
  if (!(perToken > 0)) {
    return {
      tokens: 0, cappedByMachine: false, fits: false, budgetBytes, ceilingTokens: 0,
      reason: "the cost of a token of window is not known yet for this model; load small and measure first",
    }
  }

  const ceiling = quantise(budgetBytes / perToken, policy.quantumTokens)

  if (ceiling < policy.floorTokens) {
    const others = residents.length ? `, ${residents.length} other model(s) holding ${gib(residentBytes)} GiB` : ""
    return {
      tokens: 0, cappedByMachine: true, fits: false, budgetBytes, ceilingTokens: Math.max(0, ceiling),
      reason:
        `this machine cannot hold a usable window for it: ${gib(total)} GiB total, ${gib(weights)} GiB of ` +
        `weights${others}, leaving ${gib(budgetBytes)} GiB for cache — under the ${policy.floorTokens}-token floor`,
    }
  }

  if (passport <= ceiling) {
    return {
      tokens: passport, cappedByMachine: false, fits: true, budgetBytes, ceilingTokens: ceiling,
      reason: `the model's full window of ${passport} fits: this machine holds up to ${ceiling}`,
    }
  }

  const others = residents.length ? ` and ${gib(residentBytes)} GiB held by ${residents.length} other model(s)` : ""
  return {
    tokens: ceiling, cappedByMachine: true, fits: true, budgetBytes, ceilingTokens: ceiling,
    reason:
      `capped at ${ceiling} by memory, not by the model — its passport says ${passport}, but after ` +
      `${gib(policy.systemReserveBytes)} GiB reserved for the system, ${gib(weights)} GiB of weights${others}, ` +
      `${gib(budgetBytes)} GiB remains for cache at ${perToken} bytes per token`,
  }
}
