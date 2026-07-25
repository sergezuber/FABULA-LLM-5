// A session title is a one-line plain-text LABEL, not a markdown surface. The sidebar row, the window
// header and the search results all render it as raw characters, so any syntax the model emits is shown
// literally — observed live, a session listed as: **Status**: success | partial | failed | blocked.
// Stripping is the right move rather than rendering: a one-line label has nowhere to put emphasis, and
// the same string is reused in places (window title, tab label) that cannot render markup at all.

/** Reduce a generated title to plain text: markdown syntax removed, whitespace collapsed, one line. */
export function plainTitle(raw: string): string {
  let t = String(raw ?? "").replace(/\r?\n[\s\S]*$/, "") // a title is the FIRST line, never a block
  t = t.replace(/^\s{0,3}#{1,6}\s+/, "") // heading marker
  t = t.replace(/^\s{0,3}>\s?/, "") // block quote marker
  t = t.replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/, "") // list bullet / ordered marker
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links and images → their label
  t = t.replace(/`+([^`]+)`+/g, "$1") // code spans → their content
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, "$1") // bold+italic
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1") // bold
  t = t.replace(/__([^_]+)__/g, "$1")
  t = t.replace(/\*([^*\s][^*]*)\*/g, "$1") // italic (never an unpaired lone asterisk)
  t = t.replace(/~~([^~]+)~~/g, "$1") // strikethrough
  t = t.replace(/[*_`~]{2,}/g, "") // leftover runs from unpaired syntax
  return t.replace(/\s+/g, " ").trim()
}

// ── The title must be ABOUT the conversation ───────────────────────────────────────────────────────────
//
// Stripping syntax was never enough. The title call hands the model the agent's OWN system prompt
// (llm.ts builds `system` from `input.agent.prompt`), then asks it to "Generate a title" — and the
// acceptance code took the FIRST non-empty line with no check at all. Observed live: a session about an
// Osho parable was titled `**Status**: success | partial | failed | blocked`, which is a line out of the
// "Subagent return format" section of that very prompt. Removing the asterisks left the same defect
// wearing cleaner clothes.
//
// The rule below is deterministic and general (no string is special-cased): a candidate that appears
// VERBATIM in the text we sent is an echo of our own instructions, not a summary of the conversation.
// Whatever the model quotes — this line or one nobody has seen yet — the same test catches it. When
// nothing survives, the title is derived from the user's own words, which are always on topic.

/** Fold to a comparison form: case, punctuation and spacing carry no meaning for "is this the same line". */
function foldForCompare(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/** Below this many folded characters a candidate is too short for a verbatim hit to mean anything: a
 *  two-word title can collide with a long prompt by chance, and discarding a good title is the worse
 *  error. Long candidates appearing word-for-word in what we sent are echoes, effectively always. */
export const ECHO_MIN_CHARS = 14

/** Does this candidate merely quote the instructions we sent the model? */
export function echoesPrompt(candidate: string, promptText: string): boolean {
  const c = foldForCompare(candidate)
  if (c.length < ECHO_MIN_CHARS) return false
  const p = foldForCompare(promptText)
  if (!p) return false
  return p.includes(c)
}

/** Last resort: the user's own opening words. Always about the conversation, by construction. */
export function titleFromUser(userText: string, max = 60): string {
  const t = plainTitle(String(userText ?? "").replace(/\s+/g, " "))
  if (!t) return ""
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const sp = cut.lastIndexOf(" ")
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).trim() + "…"
}

/** Pick the title: the first model line that is not an echo of our own prompt, else the user's words. */
export function chooseTitle(input: { raw: string; promptText?: string; userText?: string }): string {
  const lines = String(input.raw ?? "")
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .map((l) => plainTitle(l))
    .filter((l) => l.length > 0)
  // Markup is not a title. Live, a session came back named `<tool_calls>` — the model emitted a control
  // token where prose was asked for, and it is too short for the echo test to reach. A title is something
  // a person reads; anything that is entirely a tag, or carries no letters at all, is not one.
  // A title is prose. The first version only refused a line that was ENTIRELY a tag, and the model
  // promptly produced `<tool_call>web_search{"query": ...}` — a tag with a payload after it, which sailed
  // through. An angle-bracket token together with a brace is machine output, never something a person
  // would name a chat; either one alone is left alone, so "Как работает <div> в вёрстке" survives.
  const machine = (l: string) => /<[^>\s]+>/.test(l) && /[{}]/.test(l)
  const prose = (l: string) =>
    /\p{L}/u.test(l) && !machine(l) && !/^<[^>]*>?$/.test(l) && !/^\[[^\]]*\]?$/.test(l)
  const own = lines.find((l) => prose(l) && !echoesPrompt(l, input.promptText ?? ""))
  return own ?? titleFromUser(input.userText ?? "")
}
