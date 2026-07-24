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
