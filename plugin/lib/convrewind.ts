// Conversation-tree rewind (W2). arXiv:2605.08563: retrying with the failed attempt still in context
// multiplies the per-step error ~7× (contaminated retry); a clean restart dominates. When the harness
// rewinds the FILES to the last green, the failed-attempt TRANSCRIPT must also leave the context — else the
// model reasons from the very edits it was just told are gone. This PURE helper collapses the failed span
// (every message after the last green watermark) into ONE compact summary, MUTATING the array in place (the
// engine uses the passed `output.messages` by reference — session/prompt.ts:3172). Whole-message granularity
// only, so a dropped assistant tool-call and its tool result always go together — pairs never split. Honest
// degrade: with no known boundary it does NOT mutate (a corrupted conversation is worse than a contaminated one).

export interface Msg { info: { id?: string; role?: string; sessionID?: string }; parts: any[] }

export interface CollapseResult { applied: boolean; reason?: string; dropped: number }

/** Collapse messages with `info.id > greenBoundary` into a single summary message, MUTATING `messages` in
 *  place. Returns whether it applied (and how many messages it dropped). Boundary/ids are compared as
 *  strings (ULID / zero-padded — monotonic and lexicographically sortable, matching engine id semantics). */
export function collapseFailedSpan(messages: Msg[], greenBoundary: string | undefined, summary: string): CollapseResult {
  if (!Array.isArray(messages) || !greenBoundary || !summary) return { applied: false, reason: "no boundary", dropped: 0 }
  const span = messages.filter((m) => typeof m?.info?.id === "string" && (m.info!.id as string) > greenBoundary)
  if (!span.length) return { applied: false, reason: "empty span", dropped: 0 }
  const sid = messages.find((m) => m?.info?.sessionID)?.info?.sessionID
  // Drop the whole failed span in place (reverse iteration — safe splice). Whole messages only ⇒ a
  // tool-call part and its tool-result message drop together; no orphan can remain.
  for (let i = messages.length - 1; i >= 0; i--) {
    const id = messages[i]?.info?.id
    if (typeof id === "string" && id > greenBoundary) messages.splice(i, 1)
  }
  // Inject ONE synthetic summary as a user-role note. id === greenBoundary so it is kept (not re-dropped)
  // and never inflates a future max(id) boundary recapture.
  messages.push({ info: { id: greenBoundary, role: "user", sessionID: sid }, parts: [{ type: "text", text: summary }] })
  return { applied: true, dropped: span.length }
}
