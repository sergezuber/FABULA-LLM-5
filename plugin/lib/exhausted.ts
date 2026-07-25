// When the search budget is spent and the model STILL has not answered, the harness answers.
//
// WHY. The loop guard stops the CALL and tells the model to synthesize — loopguard.ts returns
// stop/"web_search_budget_exceeded" once the distinct-query budget is past the point of diminishing
// returns. But stopping a call is not ending a turn: observed live in the app, a task that hunted one
// parable made fourteen near-identical searches, was blocked three times, went to "Thinking" and then
// produced NOTHING. The reader is left with a dead turn and no idea why. A harness that can tell the
// model "stop searching" must also be able to say "we could not find it" on its own, or the promise
// that a blocked loop never costs the answer is empty.
//
// This module is the DECISION only (pure, testable). The plugin does the talking.

export interface ExhaustionInput {
  /** Distinct search queries the guard recorded for this turn. */
  queries: string[]
  /** Did the guard stop a call for thrash / budget this turn? */
  blocked: boolean
  /** Assistant text the turn actually produced (already stripped of synthetic parts). */
  finalText: string
  /** Turn outcome as the engine reports it. */
  outcome: string
}

export interface ExhaustionVerdict {
  answer: string | null
  /** Why the harness did or did not speak — for the diagnostic channel, never for the reader. */
  reason: string
}

/** Minimum distinct attempts before silence counts as exhaustion rather than an ordinary short turn. */
export const MIN_ATTEMPTS = 3
/** A turn is "answered" once it produced this much real text. */
export const MIN_ANSWER_CHARS = 40

/** Should the harness answer in the model's place, and with what? Pure. */
export function decideExhausted(input: ExhaustionInput): ExhaustionVerdict {
  const text = String(input.finalText ?? "").trim()
  if (text.length >= MIN_ANSWER_CHARS) return { answer: null, reason: "turn answered" }
  // A cancelled or errored turn already has its own report; speaking over it would hide that.
  if (input.outcome !== "completed") return { answer: null, reason: `outcome=${input.outcome}` }
  const queries = (input.queries ?? []).map((q) => String(q).trim()).filter(Boolean)
  if (!input.blocked) return { answer: null, reason: "nothing was blocked" }
  if (queries.length < MIN_ATTEMPTS) return { answer: null, reason: `only ${queries.length} attempts` }
  return { answer: exhaustedAnswer(queries), reason: `exhausted after ${queries.length} distinct searches` }
}

/** The message the reader gets: what was looked for, that it was not found, and what to do next. */
export function exhaustedAnswer(queries: string[]): string {
  // Show a handful, not all fourteen — the point is "this was searched thoroughly", not a dump.
  const shown = queries.slice(0, 6)
  const rest = queries.length - shown.length
  return [
    "I could not find this.",
    "",
    `I searched ${queries.length} different ways and none of them turned up the source:`,
    ...shown.map((q) => `- ${q}`),
    ...(rest > 0 ? [`- …and ${rest} more`] : []),
    "",
    "Rather than keep rephrasing the same query, I am stopping here. If you can give me a title, an" +
      " author, a book it appears in, or a link, I can go straight to it — or say the word and I will" +
      " answer from what I already know, marking clearly which parts are not sourced.",
  ].join("\n")
}
