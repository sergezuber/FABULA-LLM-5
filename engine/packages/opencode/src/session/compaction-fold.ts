// Compaction must not build a request the model cannot hold.
//
// MEASURED 2026-07-28, twice, on the same task. The summariser is handed the whole head of the
// conversation — `structuredClone(selected.head)` — and sends it in one call. Six chapters of a book were
// enough: the request reached 188 870 units against a model holding 135 168, and the serving process died
// allocating cache for it. What the reader saw was "the model has crashed" and "compaction did not
// finish"; what the run lost was every chapter it had already read.
//
// Knowing the right limit does not help by itself. The limit was measured and correct on that very run —
// nothing was reading it before deciding how much to send. So the input is folded instead: summarise the
// oldest slice, carry that summary into the next, and so on. Each call is bounded; the whole is not.
//
// NO CONSTANT DECIDES THE SIZE. The budget arrives from the caller, which computes it from the window the
// runtime actually reports. The one figure written down here is how many characters to assume per token,
// which is not a fact about any model — it is a deliberately pessimistic reading rule, named once so that
// a reader can find and change it rather than discovering it inlined in arithmetic.

/** Characters assumed per token when sizing a slice. POLICY, and deliberately low: under-estimating the
 *  token count of a slice makes slices SMALLER, which costs an extra call; over-estimating makes them too
 *  big, which is the failure this file exists to prevent. Erring cheap is the whole point. */
export const CHARS_PER_TOKEN = 2.5

/** A message as this module needs to see it: something with a measurable size. */
export interface Sizable {
  content?: unknown
  [k: string]: unknown
}

/** Rough size of a message in tokens. Deliberately counts the whole serialised shape — roles, tool names,
 *  arguments — because all of it reaches the model, not just the prose a reader would notice. */
export function estimateTokens(m: Sizable, charsPerToken = CHARS_PER_TOKEN): number {
  let chars = 0
  try {
    chars = JSON.stringify(m)?.length ?? 0
  } catch {
    chars = String((m as { content?: unknown })?.content ?? "").length
  }
  return Math.ceil(chars / Math.max(1, charsPerToken))
}

export interface FoldPlan {
  /** Slices in order. One slice means the head already fits and today's single call is unchanged. */
  slices: Sizable[][]
  /** Words for the log: a decision nobody can read is a decision nobody can check. */
  reason: string
}

/**
 * Split the head into slices that each fit the budget. PURE.
 *
 * A single message larger than the budget cannot be split by this function — splitting it would mean
 * cutting inside a tool result or a user's own words — so it is placed in a slice of its own and the
 * caller is told. That request may still be too large, but it is the smallest one that can be made, and
 * saying so beats pretending otherwise.
 */
export function planFold(head: readonly Sizable[], budgetTokens: number, charsPerToken = CHARS_PER_TOKEN): FoldPlan {
  const msgs = [...(head ?? [])]
  if (!msgs.length) return { slices: [], reason: "nothing to compact" }
  if (!(budgetTokens > 0)) {
    return { slices: [msgs], reason: "no budget known; sending the head as one call, as before" }
  }

  const total = msgs.reduce((s, m) => s + estimateTokens(m, charsPerToken), 0)
  if (total <= budgetTokens) {
    return { slices: [msgs], reason: `head fits in one call (~${total} of ${budgetTokens} tokens)` }
  }

  const slices: Sizable[][] = []
  let current: Sizable[] = []
  let currentTokens = 0
  let oversize = 0
  for (const m of msgs) {
    const t = estimateTokens(m, charsPerToken)
    if (t > budgetTokens) {
      // Cannot be divided without cutting inside somebody's words. Its own slice, and counted.
      if (current.length) { slices.push(current); current = []; currentTokens = 0 }
      slices.push([m])
      oversize++
      continue
    }
    if (currentTokens + t > budgetTokens && current.length) {
      slices.push(current)
      current = []
      currentTokens = 0
    }
    current.push(m)
    currentTokens += t
  }
  if (current.length) slices.push(current)

  const note = oversize ? `; ${oversize} message(s) exceed the budget alone and are sent as they are` : ""
  return {
    slices,
    reason: `head is ~${total} tokens against a ${budgetTokens} budget — folding into ${slices.length} passes${note}`,
  }
}

/** The instruction carried into every pass after the first, so each one knows it is continuing. */
export function foldContinuation(previousSummary: string, passIndex: number, passes: number): string {
  return [
    `This is part ${passIndex + 1} of ${passes} of a conversation being summarised in order, because the`,
    "whole of it does not fit in one request. Below is the summary of everything that came before, then",
    "the next part of the conversation itself. Produce ONE summary covering both — carry forward what",
    "still matters and drop what the earlier summary already settled. Do not mention this arrangement.",
    "",
    "=== SUMMARY SO FAR ===",
    previousSummary.trim() || "(nothing yet)",
    "=== END SUMMARY SO FAR ===",
  ].join("\n")
}
