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
