// fabula-attest — decomposition prompt/parse (design B/G, pure part; the callAux lives in the plugin).
// Splits a deliverable into atomic claims, each carrying the source it attributes itself to (for the
// scoped-grep mis-attribution check). Deliberately conservative parse. Pure, unit-tested.

function clip(s: string, n: number): string {
  const t = String(s ?? "")
  return t.length > n ? t.slice(0, n) + "…" : t
}

export function buildDecomposePrompt(deliverable: string): string {
  return [
    "Extract the atomic factual CLAIMS from the TEXT below. A claim is a single assertion that could be",
    "checked: a quote, a number/total, a stated behavior, a claim about what was read/done, or a factual",
    "statement. Skip pure opinion unless it is stated as fact.",
    "Output ONE claim per line, in this exact form:",
    "  <the claim sentence> @@ <the source/file/section it attributes to, or NONE>",
    "Max 40 lines. No preamble, no numbering.",
    "",
    "TEXT:",
    clip(deliverable, 8000),
  ].join("\n")
}

/** Parse decomposition lines into {text, attribution}. Drops preamble/empties; caps at 40. */
export function parseDecompose(auxText: string): Array<{ text: string; attribution?: string }> {
  return String(auxText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 8 && !/^(text:|claims?:|here (are|is)|the following)/i.test(l))
    .map((l) => {
      const idx = l.indexOf("@@")
      // strip only a list marker (- * • or "1." / "2)"), NOT a bare leading number that is part of the
      // claim (e.g. "9 analysts …") — the latter would corrupt a measurement claim.
      const rawText = (idx >= 0 ? l.slice(0, idx) : l).replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "").trim()
      const rawAttr = idx >= 0 ? l.slice(idx + 2).trim() : ""
      const attribution = rawAttr && !/^none$/i.test(rawAttr) ? rawAttr : undefined
      return { text: rawText, attribution }
    })
    .filter((c) => c.text.length > 6)
    .slice(0, 40)
}
