// fabula-attest — decomposition prompt/parse (design B/G, pure part; the callAux lives in the plugin).
// A reasoning model pours its whole chain-of-thought into the response (measured live 2026-07-22: the
// adapter moves reasoning_content→content, so a line parser scoops up 40 lines of "Let's…/Claim N:/Wait…"
// noise). RULE #9: don't chase the rambling with a denylist — make extraction DETERMINISTIC. We ask for a
// JSON array and lift the LAST valid array out of the text (reasoning-first: the answer is at the end),
// ignoring everything else. A line-based heuristic remains as a fallback for models that don't emit JSON.

function clip(s: string, n: number): string {
  const t = String(s ?? "")
  return t.length > n ? t.slice(0, n) + "…" : t
}

export function buildDecomposePrompt(deliverable: string, taskText?: string): string {
  const claimsSpec =
    'each item {"text": "<the claim>", "src": "<the file/section it attributes to, or null>"}. Max 40 items.'
  if (taskText && taskText.trim()) {
    // fold contract-mining (the TASK's required conclusions) into the SAME call — no extra LLM round-trip.
    return [
      "Below are a TASK and the DELIVERABLE written for it.",
      'Respond with ONLY a JSON object (no prose): {"conclusions": ["<each outcome the TASK required, short>"],',
      `"claims": [${claimsSpec}]}.`,
      "A claim is a single checkable assertion in the DELIVERABLE: a quote, a number/total, a stated behavior,",
      "a claim about what was read/done, or a factual statement. Skip pure opinion unless stated as fact.",
      "",
      "TASK:",
      clip(taskText, 1500),
      "",
      "DELIVERABLE:",
      clip(deliverable, 7000),
    ].join("\n")
  }
  return [
    "Extract the atomic factual CLAIMS from the TEXT below. A claim is a single assertion that could be",
    "checked: a quote, a number/total, a stated behavior, a claim about what was read/done, or a factual",
    "statement. Skip pure opinion unless it is stated as fact.",
    `Respond with ONLY a JSON array (no prose before or after), ${claimsSpec}`,
    "",
    "TEXT:",
    clip(deliverable, 8000),
  ].join("\n")
}

/** Lift the LAST bracket-balanced JSON object out of a possibly reasoning-laden response. */
function lastJsonObject(text: string): any | null {
  for (let start = text.lastIndexOf("{"); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    let depth = 0
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          try {
            const v = JSON.parse(text.slice(start, i + 1))
            if (v && typeof v === "object" && (Array.isArray(v.claims) || Array.isArray(v.conclusions))) return v
          } catch {}
          break
        }
      }
    }
  }
  return null
}

/** Parse a decomposition that may carry conclusions (the contract) alongside claims. Falls back to the
 *  claims-only array form. Conclusions drive load-bearing binding (design F). */
export function parseDecomposeFull(auxText: string): { conclusions: string[]; claims: Array<{ text: string; attribution?: string }> } {
  const obj = lastJsonObject(String(auxText ?? ""))
  if (obj && Array.isArray(obj.claims)) {
    const conclusions = Array.isArray(obj.conclusions)
      ? obj.conclusions.map((c: any) => String(c ?? "").trim()).filter((c: string) => c.length > 2).slice(0, 20)
      : []
    return { conclusions, claims: normalizeClaimObjs(obj.claims) }
  }
  return { conclusions: [], claims: parseDecompose(auxText) }
}

function normalizeClaimObjs(arr: any[]): Array<{ text: string; attribution?: string }> {
  const seen = new Set<string>()
  const out: Array<{ text: string; attribution?: string }> = []
  for (const o of arr) {
    const t = String((o && (o.text ?? o.claim ?? o.c)) ?? "").trim()
    if (t.length <= 6) continue
    const key = t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    if (seen.has(key)) continue
    seen.add(key)
    const src = o && (o.src ?? o.source ?? o.attribution)
    out.push({ text: t, attribution: src && typeof src === "string" && !/^(none|null)$/i.test(src.trim()) ? src.trim() : undefined })
    if (out.length >= 40) break
  }
  return out
}

/** Lift the LAST bracket-balanced JSON array out of a possibly reasoning-laden response. */
function lastJsonArray(text: string): any[] | null {
  for (let start = text.lastIndexOf("["); start >= 0; start = text.lastIndexOf("[", start - 1)) {
    let depth = 0
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (ch === "[") depth++
      else if (ch === "]") {
        depth--
        if (depth === 0) {
          try {
            const v = JSON.parse(text.slice(start, i + 1))
            if (Array.isArray(v) && v.length) return v
          } catch {}
          break
        }
      }
    }
  }
  return null
}

const META =
  /^(here'?s|let'?s|okay|wait|first,|next,|now,|line\s*\d|analyze|deconstruct|identify|filter|refine|refined|self-correction|constraint|definition|output\s*format|input\s*text|check\b|atomic|factual|format:|the\s+following|verify|since\b|i'?ll\b|i\s+will|one\s+(minor|consideration)|thinking|task:|deliverable|the\s+prompt|the\s+quotes?\s+are|all\s+(good|match))/i

function stripMarkers(line: string): string {
  return line
    .replace(/^\**\s*(?:claim|line)\s*\d+\s*[:.)-]\s*/i, "")
    .replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "")
    .replace(/^\*\*(.+?)\*\*:?\s*$/, "$1")
    .replace(/^\**\s*/, "")
    .trim()
}

/** Fallback line parser (non-JSON models): strip reasoning scaffolding, keep claim-shaped lines, dedupe. */
function parseLines(text: string): Array<{ text: string; attribution?: string }> {
  const seen = new Set<string>()
  const out: Array<{ text: string; attribution?: string }> = []
  for (const rawLine of text.replace(/<think>[\s\S]*?<\/think>/gi, " ").split("\n")) {
    const line = stripMarkers(rawLine.trim())
    if (line.length < 10 || META.test(line)) continue
    const looksClaim = /[«"“„]/.test(line) || /\d/.test(line) || (line.length > 24 && /[a-zа-яё]/i.test(line))
    if (!looksClaim) continue
    const idx = line.indexOf("@@")
    const t = (idx >= 0 ? line.slice(0, idx) : line).trim()
    if (t.length <= 6) continue
    const key = t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    if (seen.has(key)) continue
    seen.add(key)
    const attr = idx >= 0 ? line.slice(idx + 2).trim() : ""
    out.push({ text: t, attribution: attr && !/^none$/i.test(attr) ? attr : undefined })
    if (out.length >= 40) break
  }
  return out
}

/** Parse the decomposition. JSON array first (robust to reasoning models); line heuristic as fallback. */
export function parseDecompose(auxText: string): Array<{ text: string; attribution?: string }> {
  const text = String(auxText ?? "")
  const arr = lastJsonArray(text)
  if (arr) {
    const seen = new Set<string>()
    const out: Array<{ text: string; attribution?: string }> = []
    for (const o of arr) {
      const t = String((o && (o.text ?? o.claim ?? o.c)) ?? "").trim()
      if (t.length <= 6) continue
      const key = t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
      if (seen.has(key)) continue
      seen.add(key)
      const src = o && (o.src ?? o.source ?? o.attribution)
      const attribution = src && typeof src === "string" && !/^(none|null)$/i.test(src.trim()) ? src.trim() : undefined
      out.push({ text: t, attribution })
      if (out.length >= 40) break
    }
    if (out.length) return out
  }
  return parseLines(text)
}
