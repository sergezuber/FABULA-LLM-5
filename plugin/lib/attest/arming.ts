// fabula-attest — arming (design A), the invariant that fixes the review's two killers (IAL re-open +
// chat breakage): the gate is SILENT by default and engages ONLY when a task requests a checkable
// deliverable. This screen is deterministic and model-free (keeps chat.message free of an LLM call), and
// FAIL-SILENT: ambiguous / conversational / opinion asks are NOT armed, so a chat turn is never punished
// with a NOT-DONE. Pure, unit-tested.

function norm(s: string): string {
  return (typeof s === "string" ? s : "").normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim()
}

// Pure-conversational / opinion asks — the gate must stay silent (all-judgment, no verifiable artifact).
const CONVERSATIONAL = [
  /\bwhat\s+do\s+you\s+think\b/,
  /\byour\s+opinion\b/,
  /\bhow\s+do\s+you\s+feel\b/,
  /\bdo\s+you\s+(like|prefer)\b/,
  /\bthoughts\s+on\b/,
  /(что\s+думаешь|как\s+тебе|тво[её]\s+мнение|нравится\s+ли|как\s+считаешь|что\s+скажешь\s+о)/,
]

// Verbs that request a checkable deliverable — arm the gate.
const DELIVERABLE_EN =
  /\b(analyz|review|summariz|write|creat|build|implement|fix|refactor|plan|comput|calculat|list|extract|compare|research|draft|design|audit|verify|check)\w*/
const DELIVERABLE_RU =
  /(проанализир|разбер|разбор|резюмир|сведи|свод|сдела|напиш|создай|постро|реализ|исправ|отрефактор|составь|посчита|вычисл|перечисл|извлеки|сравни|ресёрч|ресерч|спроектир|проверь|audit|аудит)/

/** True iff the task requests a checkable deliverable (arm the gate). Fail-silent on ambiguity. */
export function taskIsVerifiable(text: string): boolean {
  const t = norm(text)
  if (t.length < 12) return false // greeting / trivial
  if (CONVERSATIONAL.some((re) => re.test(t))) return false // opinion ask → stay silent
  return DELIVERABLE_EN.test(t) || DELIVERABLE_RU.test(t)
}
