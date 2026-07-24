// fabula-attest — text-only deliverable detection (design §4, §17.I). The motivating case for the
// whole gate is a literary analysis delivered AS TEXT IN THE CHAT, not a file. The file path
// (tool.execute.after on WRITE_TOOLS) covers written artifacts; this module decides when the
// FINAL ASSISTANT TEXT itself is the deliverable worth verifying. Pure, unit-tested.
//
// The detector is model-free and fail-silent: it never fires on a turn that was NOT armed as a
// deliverable task (so a chat/opinion turn is untouched), and it requires the text to be substantial
// AND structured like a real analysis (not a one-liner or a tool-call summary). The combination is
// what keeps the gate from firing on every long answer — a long but non-deliverable chat reply stays
// silent because the arming pre-screen already said "this is not a checkable deliverable".

export const TEXT_DELIVERABLE_MIN_CHARS = 600 // a real analysis, not a paragraph answer

// Structural markers of an analytical deliverable (headings, section labels, enumerated claims).
// A bare wall of prose — even a long one — is ambiguous; a structured breakdown signals the author
// framed it as a deliverable with discrete, checkable claims.
const STRUCTURE_RU = [
  /глава\s*\d+/i, // «глава 3», «Глава 10» — chapter-by-chapter analysis
  /\bраздел\b/i,
  /\bтезис\b/i,
  /\bвывод\b/i,
  /\bитог[ои]\b/i,
  /\bзаключение\b/i,
  /-\s+[А-ЯA-Z]/, // markdown-ish bullet list with a capital lead
  /^\s*#+\s/m, // markdown heading
]
const STRUCTURE_EN = [
  /chapter\s+\d+/i,
  /\bsection\b/i,
  /\bthesis\b/i,
  /\bconclusion\b/i,
  /\bfinding[s]?\b/i,
  /^\s*#+\s/m,
  /^\s*[-*]\s+\w/m, // bullet list
]

/** Inputs to the text-deliverable decision. */
export interface TextDeliverableInput {
  /** True iff the chat.message arming pre-screen flagged this task as a checkable deliverable. */
  armed: boolean
  /** The session outcome from session.post: only "completed" turns are candidates. */
  outcome: string | undefined
  /** The agentID of the slice that just finished. Subagents (compaction, summarizer) are excluded. */
  agentID: string | undefined
  /** The final assistant text (session.post input.finalText). */
  finalText: string | undefined
  /** True if ANY write/edit tool ran during this turn → the deliverable is a FILE, not the text. */
  hadWriteTool: boolean
  /** Set of agentIDs known to be background/subagents (compaction, summarizer, explore, etc.). */
  subagents: ReadonlySet<string>
  /** True if the gate already verified the text this turn (recursion guard). */
  alreadyChecked: boolean
}

/** A named list of background agent roles whose finalText is NEVER a user-facing deliverable. */
export const SUBAGENT_ROLES = new Set([
  "compaction",
  "summarizer",
  "summary",
  "explore",
  "research",
  "planner",
  "task",
])

/** Decide whether the final assistant text IS the deliverable to verify. Fail-silent on any doubt. */
export function isTextDeliverable(inp: TextDeliverableInput): boolean {
  // Hard preconditions — each one alone can veto the gate.
  if (!inp.armed) return false // a chat/opinion turn never arms (arming.ts CONVERSATIONAL filter)
  if (inp.outcome !== "completed") return false // error / cancelled → nothing to verify
  if (inp.alreadyChecked) return false // recursion: we already verified + sent a remark this turn
  if (inp.hadWriteTool) return false // the deliverable was written to a file (file path covers it)
  if (!inp.finalText) return false
  const text = inp.finalText
  if (text.length < TEXT_DELIVERABLE_MIN_CHARS) return false // too short to be a substantive deliverable
  // Exclude subagent slices: a compaction/summarizer/summary "finalText" is internal, not the deliverable.
  const agent = (inp.agentID || "").toLowerCase()
  if (agent && (SUBAGENT_ROLES.has(agent) || inp.subagents.has(agent))) return false
  // Structural signal: an analytical deliverable is organized (chapters/sections/headings/bullets),
  // not a flat wall of prose. This is the second guard against firing on a merely-long chat reply.
  const structured = STRUCTURE_RU.some((re) => re.test(text)) || STRUCTURE_EN.some((re) => re.test(text))
  return structured
}

/** Should a remark be sent (refuted load-bearing claim)? Pure predicate over the gate output. */
export function shouldRemark(done: boolean, refutedCount: number, minRefuted: number = 1): boolean {
  return !done && refutedCount >= minRefuted
}
