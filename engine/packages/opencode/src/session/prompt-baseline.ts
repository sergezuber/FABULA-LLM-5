/**
 * ONE definition of a session's IRREDUCIBLE PROMPT COST, and of how a window fraction is mapped into
 * the room the CONVERSATION actually has.
 *
 * WHY THIS MODULE EXISTS. Two independent mechanisms compare a token count against a fraction of the
 * context window — the checkpoint thresholds (`prune.ts`) and the compaction trigger (`overflow.ts`).
 * Both are crossed by a quantity that has nothing to do with progress: the system prompt plus every
 * tool schema, re-sent verbatim on every single request. `prune.ts` was corrected for this in
 * v0.171.0; `overflow.ts` was not, and the two then disagreed about what a threshold measures — this
 * project's most-repeated defect, one rule with two definitions. The baseline and the rescale now
 * live here, and both consumers read them.
 *
 * MEASURED, on the run that produced the fix (session ses_feb7b41c3ffe…, 2026-08-18):
 *   context window                       69 632
 *   irreducible prefix (measured twice)   47 616 / 47 779   (LM Studio: `using 0/47779 tokens`)
 *   compaction's `usable()`               29 632  = 69 632 − 20 000 output − 20 000 summary
 * The prefix exceeded the whole input budget by 61%, so `count >= usable` was true on the FIRST turn
 * of every session and stayed true forever. Compaction rewrites the CONVERSATION; it cannot shrink a
 * prefix, so each firing recovered nothing and the next turn tripped the same threshold: five
 * summarizer runs in 30 minutes, zero progress, and — because a rewritten conversation shares no
 * prefix with the cached one — every turn then paid a full ~49 000-token prefill (`using 0/49413`)
 * instead of reusing the cache. Prefill collapsed 455 → 12.6 tok/s as the machine went into swap, and
 * the last request needed 770s against the adapter's 300s idle watchdog.
 *
 * THE BASELINE IS MEASURED, NEVER CONFIGURED: the smallest total ever observed for the session. That
 * is the cost of the prompt for this model, this prompt and this tool belt. Change any of them and it
 * re-derives itself. Taking the MINIMUM makes it self-correcting — a baseline first observed
 * mid-session (after a restart) repairs itself downward instead of holding the threshold too high
 * forever.
 */

/**
 * Map thresholds expressed as fractions of a window into the region ABOVE the baseline, so a fraction
 * keeps its meaning ("a fifth of the room the conversation has") instead of measuring the prompt.
 *
 * Subtracting the baseline outright is the obvious move and it is WRONG: on a 131 072 window with a
 * 40 291 baseline the last threshold would land at `baseline + 0.8·window = 145 148`, i.e. PAST the
 * window — so the final save, the one that exists to rescue state before overflow, would fire after
 * the overflow it guards against. Mapping the fraction into the room keeps every threshold inside the
 * window by construction (0.8 → 112 916 on the same numbers).
 *
 * A baseline at or above the window is not a measurement we can use, so the thresholds are returned
 * untouched — degrade to the previous absolute behaviour rather than to nonsense.
 */
export function rescaleAboveBaseline(
  thresholds: readonly number[],
  thresholdSpace: number,
  baseline: number,
  roomWindow: number = thresholdSpace,
): number[] {
  if (!(thresholdSpace > 0) || !(roomWindow > 0)) return [...thresholds]
  if (!(baseline > 0) || baseline >= roomWindow) return [...thresholds]
  const room = roomWindow - baseline
  return thresholds.map((t) => Math.round(baseline + (t / thresholdSpace) * room))
}

/**
 * Bound on how many sessions carry a remembered baseline. An unbounded per-session map in a
 * long-lived process is a leak; the number itself is not load-bearing (a forgotten baseline is
 * re-observed on the session's next turn, costing nothing but one turn of the previous behaviour).
 */
const MAX_SESSIONS = 512

const baselines = new Map<string, number>()

/**
 * The baseline belongs to the SLICE whose tokens are being measured, not to the session.
 *
 * MEASURED DEFECT this prevents (found by independent verification, 2026-08-18): subagents share the
 * parent's sessionID (`processor.ts:211` says so outright, and `prompt.ts` routes a non-main agentID
 * through the same overflow check). Their prompt and tool belt are smaller, so their totals are
 * smaller — and the baseline is a MINIMUM. One `explore` or `checkpoint-writer` turn of ~6,000 tokens
 * therefore pulled the main conversation's baseline from 48,027 down to 6,000, collapsing the
 * threshold from 57,221 back to 33,079 and re-arming the exact loop this module exists to remove. The
 * failing run had both kinds of subagent in it, so keying by session alone would have been defeated
 * in production on the very first background pass.
 *
 * A slice with no agent named is the main one — that is what an absent `agentID` means everywhere
 * else in the engine (`processor.ts:215`).
 */
function baselineKey(sessionID: string, agentID?: string) {
  return `${sessionID}\u0000${agentID || "main"}`
}

/**
 * Record an observed total for a session and return the baseline in force after it.
 *
 * LRU by RE-INSERTION, which is the whole reason this is not a plain `set`: a Map iterates in
 * insertion order, so evicting the "first" key without re-inserting on access evicts the session that
 * has been active longest — measured as exactly the wrong one in W6.
 */
export function observeBaseline(sessionID: string, total: number, agentID?: string): number {
  const key = baselineKey(sessionID, agentID)
  if (!sessionID || !Number.isFinite(total) || total <= 0) return baselines.get(key) ?? 0
  const seen = baselines.get(key)
  const next = seen === undefined ? total : Math.min(seen, total)
  baselines.delete(key)
  baselines.set(key, next)
  if (baselines.size > MAX_SESSIONS) {
    const oldest = baselines.keys().next()
    if (!oldest.done) baselines.delete(oldest.value)
  }
  return next
}

/** The baseline remembered for a slice, or 0 when none has been observed yet. */
export function baselineFor(sessionID: string, agentID?: string): number {
  const key = baselineKey(sessionID, agentID)
  const seen = baselines.get(key)
  if (seen === undefined) return 0
  baselines.delete(key)
  baselines.set(key, seen)
  return seen
}

/** Drop remembered baselines. Tests only — production never needs to forget a measurement. */
export function resetBaselines() {
  baselines.clear()
}
