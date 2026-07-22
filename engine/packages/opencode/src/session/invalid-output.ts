/**
 * Progress-aware bound for the think-only / invalid-output auto-continue re-entry edge.
 *
 * A reasoning model routinely finishes an INTERMEDIATE turn with reasoning only (no final text, no
 * tool call) — it is thinking toward an action across turns. The old bound was a run-lifetime tally
 * with a hard cap of 2 and no reset, so two such turns anywhere in a long task — even with real tool
 * work between them — tripped a terminal InvalidOutputError (measured live, ses_079ede1e4ffe…,
 * 2026-07-21: a book-analysis run died mid-task exactly there).
 *
 * The line between "the model is working" and "the model is stuck" is PROGRESS, not a count (the same
 * principle the loop guard uses): a think-only turn whose reasoning CHANGED is progress and does not
 * spend the soft budget; a repeated/identical reasoning is a real stall and does. An absolute
 * `hardLimit` still guarantees termination regardless of progress (the W4 re-entry-bound contract),
 * so a model that reasons forever without ever acting is still cut off.
 *
 * Pure: no I/O, no mutation of inputs. `runLoop` holds the counters and applies the returned ones.
 */

/**
 * Canonical signature of a step's REAL reasoning (reasoning parts, whitespace-collapsed). Two think-only
 * turns with the same signature are the model repeating itself — a stall.
 *
 * HONEST NOTE on what this bounds: the soft (stall) limit only bites when the signature is IDENTICAL
 * across turns. A reasoning model that varies any token — a paraphrase, a step counter — makes every
 * think-only turn look like progress, so in practice the effective bound for such a model is the HARD
 * ceiling, not the soft one. That is intended (a moving reasoning is not a stall), but do not read the
 * soft limit as the usual bound — it catches only a truly stuck, verbatim-repeating model.
 * (`synthetic` is filtered defensively; reasoning parts carry no synthetic flag today, only text parts do.)
 */
export function reasoningSignature(
  parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }>,
): string {
  return parts
    .filter((p) => p.type === "reasoning" && !p.synthetic && typeof p.text === "string")
    .map((p) => (p.text as string).replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0)
    .join(" ")
}

/**
 * Did this step produce real work — a tool call, or a non-empty non-synthetic final text? Such a step
 * means the model is no longer stuck, so the think-only budget resets. Keyed on PARTS, not on the
 * step's `classification.type`, because "continue" is multivalued (a genuine tool step AND a stale
 * assistant predating a fresh nudge both classify as continue — resetting on the latter zeroed the
 * counter every iteration and defeated the bound entirely, found in the integration suite 2026-07-21).
 */
export function isProductiveStep(
  parts: ReadonlyArray<{ type: string; text?: string; synthetic?: boolean }>,
): boolean {
  return parts.some(
    (p) =>
      p.type === "tool" ||
      (p.type === "text" && !p.synthetic && typeof p.text === "string" && p.text.trim().length > 0),
  )
}

export function decideInvalidContinuation(input: {
  /** consecutive NON-progressing think-only turns so far (the stall streak) */
  stalls: number
  /** total think-only turns this run (the absolute bound) */
  total: number
  /** did this turn's reasoning differ from the previous think-only turn's? */
  progressed: boolean
  /** stall ceiling — a repeated identical reasoning this many times is a genuine stall */
  softLimit: number
  /** absolute ceiling regardless of progress — guarantees the edge terminates */
  hardLimit: number
}): { proceed: boolean; stalls: number } {
  // Both limits are checked BEFORE this turn is counted (matching the original counter semantics: a
  // softLimit of 2 allows two stall continuations, then the third stop is terminal). The hard ceiling
  // bounds a run of genuine progress; the soft ceiling bounds a stall (repeated identical reasoning).
  if (input.total >= input.hardLimit) return { proceed: false, stalls: input.stalls }
  if (!input.progressed && input.stalls >= input.softLimit) return { proceed: false, stalls: input.stalls }
  // Progress zeroes the stall streak; a repeat extends it by one for the next decision.
  return { proceed: true, stalls: input.progressed ? 0 : input.stalls + 1 }
}
