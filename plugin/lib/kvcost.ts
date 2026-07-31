// What one token of context window costs in memory — learned from this machine, never tabulated.
//
// The planner (lib/windowplan.ts) needs one number it cannot read anywhere: the bytes a single token of
// window costs for a given model. It depends on the architecture, the number of key/value heads, the head
// dimension, the cache quantisation and the serving runtime — a table of it would be wrong for the next
// model, and wrong silently.
//
// It does not have to be looked up, because the serving API already reports the two things it is made of.
// Load a model at window W and the API reports total resident bytes T. That is a straight line:
//
//     T = weights + W · bytesPerToken
//
// Two loads at different windows give two points, and two points give the line — both the weights and the
// per-token cost, for THIS model on THIS machine, with no architecture knowledge at all. More points make
// it a least-squares fit, which shrugs off the odd noisy reading.
//
// COLD START is the part that matters for safety. With no observations the honest answer is "unknown",
// and the caller must then load SMALL (the serving default) and measure — never large and hope. On
// unified memory an over-sized load does not fail cleanly, it drives the whole machine into swap, so
// "try the maximum and back off" is not a strategy that exists here.

/** One reading from the serving API: a model was loaded at this window and held this much memory. */
export interface Observation {
  /** Context window the model was loaded at. */
  windowTokens: number
  /**
   * Bytes in use on the MACHINE at that moment — not a figure from the serving API.
   *
   * MEASURED, and it is why this field is what it is: the serving API reports no memory at all
   * (`max_context_length` and `loaded_context_length`, nothing else), and `lms ps` reports a SIZE that
   * does NOT move with the window — 21.95 GB at 32768 and 21.95 GB at 262144, because it is the weights.
   * A cost model reading either would fit a horizontal line and refuse forever, correctly and uselessly.
   * The machine's own used memory does move, so that is what gets read.
   *
   * Whatever else the machine is doing sits in this number as a CONSTANT, and the slope of a line is
   * blind to constants — so the per-token cost comes out right even though the baseline is unknown and
   * drifting. The intercept, by the same token, is meaningless here and must not be used as weights;
   * weights are read separately from the serving runtime, where they ARE reported.
   */
  totalBytes: number
}

export interface CostFit {
  /** Bytes per token of window. 0 when not yet knowable. */
  bytesPerToken: number
  /** The line's intercept. NOT the weights: the readings are machine-wide, so this carries whatever else
   *  the machine was holding. Kept for diagnostics; the planner takes weights from the runtime instead. */
  weightsBytes: number
  /** How many observations the fit rests on. One is not enough and says so. */
  points: number
  /** Plain words, for the log and for a human deciding whether to trust it. */
  reason: string
}

/** Two readings at the SAME window are one point twice over; a fit needs genuinely different windows. */
export const MIN_WINDOW_SPREAD = 1024

/**
 * A reading taken DURING a request, which is where the cache actually appears.
 *
 * WHY THIS EXISTS — measured 2026-07-26, and it refutes the assumption the load-time `Observation`
 * above rests on. That model says machine memory after a load is `weights + W · bytesPerToken`, with
 * everything else entering as a constant the slope is blind to. On a runtime that allocates the cache
 * LAZILY, there is no `W` term in that number at all: loading at a larger window allocates nothing extra,
 * because the cache is created per request as tokens arrive. The fit is then regressing drift against W,
 * and the slope it returns is noise — on this machine it came out NEGATIVE (-54 203 B/token across three
 * readings), which `fitCost` correctly refused, and would have gone on refusing forever.
 *
 * The evidence, from one model on one machine, watching wired memory across a prefill of known size:
 *
 *     idle after load        26.92 GiB      (weights, wired)
 *      60 332 prompt tokens  +5.42 GiB      →  96 461 B/token
 *     131 021 prompt tokens +12.59 GiB      → 103 177 B/token   (marginal between them: 108 910)
 *     request finished       cache released, wired falls back
 *
 * Rising, consistent, and physically meaningful — because it samples the quantity being governed rather
 * than a quantity that merely correlates with it when the runtime happens to pre-allocate.
 *
 * It also dissolves the cold-start deadlock the load-time path needs `safeSecondWindow` to escape: the
 * baseline is subtracted by construction, so the line passes through the origin and ONE sample already
 * determines it. And the sample comes from ordinary traffic — every response reports its own
 * `prompt_tokens` — so nothing has to be probed.
 *
 * The load-time path is kept, not deleted: a runtime that really does pre-allocate its cache at load
 * WOULD put the signal there, and refusing to model that would hardcode this file to one serving stack.
 * Callers prefer samples when they have them.
 */
export interface KvSample {
  /** Tokens the request actually asked the model to hold — its own `prompt_tokens`, as reported. */
  contextTokens: number
  /** Bytes the cache grew by while that request was in flight: memory at peak minus memory at idle. */
  kvBytes: number
}

/** Slopes further apart than this factor are not measuring the same thing; the fit says so out loud. */
export const SAMPLE_DISPERSION_LIMIT = 2

/**
 * The smallest context a reading may be taken at.
 *
 * MEASURED, by getting it wrong first. A calibration at 8 207 tokens reported 470 013 bytes per token —
 * four times the truth — because the cache it allocated (~0.85 GiB at the real cost) was smaller than
 * the memory the rest of the machine moved while the request ran (~2.7 GiB). The reading was not noisy
 * around the right answer; it was dominated by something else entirely.
 *
 * The two readings that DID agree were taken at 60 332 and 131 021 tokens, where the cache is 5–13 GiB
 * and nothing else on the machine moves that much in a minute. So a reading has to be big enough that
 * the signal dwarfs ordinary drift, and below this floor it is discarded rather than believed.
 *
 * This is POLICY, not physics — a judgement about how much drift a desktop can produce — so it is named
 * here in one place instead of dissolved into the arithmetic.
 */
export const MIN_SIGNAL_TOKENS = 32_768

/**
 * Fit the line through the observations. PURE.
 *
 * Returns a zero cost — not a guess — when the readings cannot determine one. A caller that receives zero
 * must load small and measure; that is the whole contract, and it is what keeps a wrong number from
 * reaching a load command.
 */
export function fitCost(observations: readonly Observation[]): CostFit {
  const pts = (observations ?? [])
    .map((o) => ({ w: Number(o?.windowTokens) || 0, t: Number(o?.totalBytes) || 0 }))
    .filter((o) => o.w > 0 && o.t > 0)

  if (pts.length < 2) {
    return {
      bytesPerToken: 0,
      weightsBytes: pts[0]?.t ?? 0,
      points: pts.length,
      reason:
        pts.length === 0
          ? "no readings yet for this model — load at the serving default and measure"
          : "only one reading — a single point cannot separate weights from cache; measure at a second window",
    }
  }

  const spread = Math.max(...pts.map((p) => p.w)) - Math.min(...pts.map((p) => p.w))
  if (spread < MIN_WINDOW_SPREAD) {
    return {
      bytesPerToken: 0,
      weightsBytes: pts[0].t,
      points: pts.length,
      reason: `all ${pts.length} readings are at effectively the same window (spread ${spread}); measure at a different one`,
    }
  }

  // Least squares through the points: slope is the per-token cost, intercept the weights.
  const n = pts.length
  const meanW = pts.reduce((s, p) => s + p.w, 0) / n
  const meanT = pts.reduce((s, p) => s + p.t, 0) / n
  const cov = pts.reduce((s, p) => s + (p.w - meanW) * (p.t - meanT), 0)
  const varW = pts.reduce((s, p) => s + (p.w - meanW) ** 2, 0)
  const slope = varW > 0 ? cov / varW : 0
  const intercept = meanT - slope * meanW

  // A negative slope or negative weights means the readings disagree with the model of the world — memory
  // was measured while something else was moving. Refusing beats fitting nonsense into a load command.
  if (!(slope > 0) || intercept < 0) {
    return {
      bytesPerToken: 0,
      weightsBytes: Math.max(0, intercept),
      points: n,
      reason: `${n} readings do not fit a rising line (slope ${slope.toFixed(1)}); they were probably taken while memory was moving`,
    }
  }

  return {
    bytesPerToken: Math.round(slope),
    weightsBytes: Math.round(intercept),
    points: n,
    reason: `learned from ${n} reading(s) across a ${spread}-token spread: ${Math.round(slope)} bytes per token, ${(intercept / 1024 ** 3).toFixed(2)} GiB of weights`,
  }
}

/**
 * Fit the per-token cost from request-time samples. PURE.
 *
 * THROUGH THE ORIGIN, deliberately. The baseline is already subtracted when the sample is taken
 * (`kvBytes` is peak minus idle), so a cache of nothing costs nothing and there is no constant to
 * recover. Fitting an intercept anyway would let two noisy points invent a large negative one and drag
 * the slope with it — the exact failure the load-time path hit.
 *
 * Returns zero rather than a guess when the readings cannot determine a cost, same contract as `fitCost`:
 * a caller receiving zero must not put a number into a load command.
 */
export function fitCostFromSamples(samples: readonly KvSample[]): CostFit {
  const usable = (samples ?? [])
    .map((s) => ({ x: Number(s?.contextTokens) || 0, y: Number(s?.kvBytes) || 0 }))
    .filter((p) => p.x > 0 && p.y > 0)
  // A reading taken over too small a context measures the machine's drift, not the cache — see
  // MIN_SIGNAL_TOKENS. Dropping it is the difference between refusing and being confidently wrong.
  const pts = usable.filter((p) => p.x >= MIN_SIGNAL_TOKENS)
  const dropped = usable.length - pts.length

  if (pts.length === 0) {
    return {
      bytesPerToken: 0,
      weightsBytes: 0,
      points: 0,
      reason: dropped
        ? `${dropped} cache reading(s) were taken over fewer than ${MIN_SIGNAL_TOKENS} tokens, where machine drift outweighs the cache; measure over a longer context`
        : "no request-time cache readings yet for this model — one real request is enough to learn it",
    }
  }

  // Least squares through the origin: the slope that best explains every sample at once.
  const sxy = pts.reduce((s, p) => s + p.x * p.y, 0)
  const sxx = pts.reduce((s, p) => s + p.x * p.x, 0)
  const slope = sxx > 0 ? sxy / sxx : 0
  if (!(slope > 0)) {
    return {
      bytesPerToken: 0,
      weightsBytes: 0,
      points: pts.length,
      reason: `${pts.length} cache reading(s) do not describe a positive cost; something else was moving memory`,
    }
  }

  // Per-sample slopes that disagree badly are not one measurement repeated — say so instead of averaging
  // the disagreement away into a confident-looking number.
  const each = pts.map((p) => p.y / p.x)
  const spread = Math.max(...each) / Math.min(...each)
  if (pts.length > 1 && spread > SAMPLE_DISPERSION_LIMIT) {
    return {
      bytesPerToken: 0,
      weightsBytes: 0,
      points: pts.length,
      reason:
        `${pts.length} cache readings disagree by ${spread.toFixed(1)}× ` +
        `(${Math.round(Math.min(...each))}–${Math.round(Math.max(...each))} bytes per token); ` +
        `they were probably taken while memory was moving`,
    }
  }

  const agreement =
    pts.length > 1 ? `${pts.length} readings agreeing within ${spread.toFixed(2)}×` : "1 reading"
  return {
    bytesPerToken: Math.round(slope),
    weightsBytes: 0,
    points: pts.length,
    reason: `learned from ${agreement}: ${Math.round(slope)} bytes per token of context`,
  }
}

/** Fold a new reading in, keeping the window spread that makes the fit possible. */
export function addObservation(
  existing: readonly Observation[],
  next: Observation,
  cap = 8,
): Observation[] {
  const w = Number(next?.windowTokens) || 0
  const t = Number(next?.totalBytes) || 0
  if (!(w > 0 && t > 0)) return [...existing]
  // Replace a reading at the same window rather than stacking duplicates — the newest measurement of a
  // given window is the truest one, and duplicates would weight the fit toward whichever window we happen
  // to load most often.
  const kept = existing.filter((o) => Math.abs((Number(o.windowTokens) || 0) - w) >= MIN_WINDOW_SPREAD)
  const out = [...kept, { windowTokens: w, totalBytes: t }]
  // Keep the extremes when trimming: the spread is what makes the line determinable, so dropping the ends
  // would be dropping exactly the information the fit is made of.
  if (out.length <= cap) return out
  const sorted = [...out].sort((a, b) => a.windowTokens - b.windowTokens)
  return [sorted[0], ...sorted.slice(-(cap - 1))]
}

/**
 * The second reading has to come from somewhere.
 *
 * COLD START DEADLOCK, found by unloading the model for real: one reading cannot separate a slope from a
 * constant, so the fit refuses; refusing means nothing ever loads at a second window; and without a
 * second window the one reading stays one forever. Every part behaves exactly as designed and the whole
 * stands still.
 *
 * WHAT MAKES A STEP SAFE — and this was measured, not assumed. The serving runtime has its OWN guardrail:
 * asked to load a window this machine could not hold, LM Studio refused outright — "Model loading was
 * stopped due to insufficient system resources… would likely overload your system" — rather than
 * accepting it and driving the Mac into swap. That refusal is the protection, and it is stronger than any
 * arithmetic here could be, because the runtime knows what it is about to allocate and we do not.
 *
 * So the step is a doubling, bounded by the model's own maximum, and taken only when the machine has
 * headroom worth trying. A refusal costs seconds and teaches us the ceiling; it cannot hurt the machine.
 */
export function safeSecondWindow(
  reading: Observation,
  freeBytes: number,
  passportTokens: number,
): number {
  const w = Number(reading?.windowTokens) || 0
  if (!(w > 0)) return 0
  // No headroom at all means not even the runtime would say yes; do not waste a load finding out.
  if (!(Number(freeBytes) > 0)) return 0
  const passport = Math.max(0, Math.floor(Number(passportTokens) || 0))
  const next = Math.min(w * 2, passport)
  return next > w ? next : 0
}

/**
 * The marginal cost between two sized readings taken in the SAME warm state. PURE.
 *
 * MEASURED 2026-07-31, and this is the correction the whole calibration rests on: two absolute readings
 * of the SAME model at the SAME size, seconds apart with no reload between, reported 3.44 GiB and then
 * 1.22 GiB — 2.8x apart. Only the FIRST request after a load allocates; every later one is served from a
 * warm pool, so a single absolute reading measures a cache HIT and reports a cost far below the truth.
 * Six such readings clustered near 60 000 B/token against a first-reading truth of 165 058, and the
 * marginal method recovered 129 801 — within 5% of the same-architecture reference (123 758).
 *
 * Whatever is already warm serves BOTH readings, so it CANCELS in the difference, and the extra tokens
 * still have to be allocated from somewhere. The floor applies to the token DELTA, because that delta is
 * the only signal here: two large readings a few hundred tokens apart measure drift, not cache.
 */
export function marginalCost(
  a: { tokens: number; bytes: number },
  b: { tokens: number; bytes: number },
): { bytesPerToken: number; deltaTokens: number; deltaBytes: number; reason: string } {
  const lo = a.tokens <= b.tokens ? a : b
  const hi = a.tokens <= b.tokens ? b : a
  const deltaTokens = hi.tokens - lo.tokens
  const deltaBytes = hi.bytes - lo.bytes
  if (deltaTokens < MIN_SIGNAL_TOKENS) {
    return { bytesPerToken: 0, deltaTokens, deltaBytes, reason: `the two readings differ by only ${deltaTokens} tokens, under the ${MIN_SIGNAL_TOKENS} floor where drift outweighs the cache` }
  }
  if (!(deltaBytes > 0)) {
    return { bytesPerToken: 0, deltaTokens, deltaBytes, reason: `the larger context allocated no more memory (${deltaBytes} bytes) — the reading says nothing` }
  }
  return {
    bytesPerToken: Math.round(deltaBytes / deltaTokens),
    deltaTokens, deltaBytes,
    reason: `marginal over ${deltaTokens} extra tokens: ${(deltaBytes / 1024 ** 3).toFixed(2)} GiB`,
  }
}
