// The answer must be written in the language the question was asked in — all of it.
//
// MEASURED on a live turn (2026-07-25). A Russian question got a Russian answer with Chinese spliced into
// the middle of its own sentences: "### Откуда, скорее всего, 这个故事:" and "看似 абсурдную инструкцию".
// The content was right; the text was not something a reader can hand to anyone. Code-mixing like this is
// a known behaviour of multilingual models under a long context, and it is not a property of one model —
// whatever sits in the socket can do it, so the harness is where it gets handled (RULE #9/#14): a
// deterministic steer that fires ITSELF on every turn, not a line of advice buried in a prompt.
//
// Deliberately NOT a post-hoc rewrite of the model's words. Rewriting an answer to fix its script would
// mean the harness editing content it did not verify — the cure being worse. The steer is prepended to
// the request instead, where it costs one short sentence and leaves the answer the model's own.

/** Scripts we can tell apart by codepoint alone — no model, no dictionary, no network. */
const SCRIPTS = [
  { id: "cyrillic", re: /\p{Script=Cyrillic}/gu, name: "Russian" },
  { id: "han", re: /\p{Script=Han}/gu, name: "Chinese" },
  { id: "hangul", re: /\p{Script=Hangul}/gu, name: "Korean" },
  { id: "hiragana", re: /\p{Script=Hiragana}|\p{Script=Katakana}/gu, name: "Japanese" },
  { id: "arabic", re: /\p{Script=Arabic}/gu, name: "Arabic" },
  { id: "latin", re: /\p{Script=Latin}/gu, name: "English" },
] as const

export type ScriptId = (typeof SCRIPTS)[number]["id"]

/** Count letters per script. Punctuation, digits and whitespace carry no language and are ignored. */
export function scriptCounts(text: string): Record<string, number> {
  const t = String(text ?? "")
  const out: Record<string, number> = {}
  for (const s of SCRIPTS) out[s.id] = (t.match(s.re) ?? []).length
  return out
}

/** The script the text is actually written in, or null when there are too few letters to tell. */
export function dominantScript(text: string, minLetters = 12): ScriptId | null {
  const counts = scriptCounts(text)
  let best: ScriptId | null = null
  let bestN = 0
  let total = 0
  for (const s of SCRIPTS) {
    const n = counts[s.id] ?? 0
    total += n
    if (n > bestN) {
      bestN = n
      best = s.id
    }
  }
  if (total < minLetters) return null
  return best
}

/** Human name of a script, for an instruction the model can act on. */
export function scriptName(id: ScriptId): string {
  return SCRIPTS.find((s) => s.id === id)?.name ?? id
}

/**
 * A foreign script is a DEFECT only when it is a minority intrusion into text that is clearly in another
 * script. A genuinely bilingual message, a quoted term, or a code identifier must not trip this: the
 * threshold is a fraction of the whole, so one quoted phrase is fine and a spliced clause is not.
 */
export const INTRUSION_MAX_SHARE = 0.15

/** Which scripts intrude on the dominant one? Empty when the text is clean. */
export function intrudingScripts(text: string, dominant: ScriptId): ScriptId[] {
  const counts = scriptCounts(text)
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (!total) return []
  // Latin never counts as an intrusion: technical terms, names, URLs and code identifiers are written in
  // it inside every language, and flagging those would fire on nearly every real answer.
  return SCRIPTS.filter((s) => s.id !== dominant && s.id !== "latin")
    .filter((s) => (counts[s.id] ?? 0) > 0 && (counts[s.id] ?? 0) / total <= INTRUSION_MAX_SHARE)
    .map((s) => s.id)
}

/** The steer appended to the user's turn. Empty string when the language is unclear — never guess. */
export function languageSteer(userText: string): string {
  const d = dominantScript(userText)
  if (!d) return ""
  return (
    `\n\n[Write the entire answer in ${scriptName(d)} — every heading, every sentence, every word. Sources ` +
    `you read may be in other languages; carry over their MEANING, never their characters. Before you emit ` +
    `each sentence, check it contains no Chinese, Japanese, Korean or Arabic characters. Latin-script ` +
    `technical terms, product names, URLs and code identifiers are the only exception.]`
  )
}

/** The same pin as a standing posture line, for the system channel. A single channel is a single point of
 *  failure: measured live, the user-turn steer alone left three Chinese characters in a 1929-character
 *  Russian answer — obeyed for 1926 of them, which is a steer behaving like a steer. Stating the rule in
 *  BOTH channels is what the project's other pins (date, freshness) already do. */
export function languagePosture(userText: string): string {
  const d = dominantScript(userText)
  if (!d) return ""
  return (
    `LANGUAGE: this conversation is in ${scriptName(d)}. Every answer you write is in ${scriptName(d)} ` +
    `throughout. Never emit Chinese, Japanese, Korean or Arabic characters in it, not even inside a ` +
    `single word or phrase, however natural the term feels — translate the idea instead. Latin-script ` +
    `technical terms, names, URLs and code identifiers are the only exception.`
  )
}
