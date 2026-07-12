// Fuzzy str_replace matcher. Pure + testable.
// Local models often produce an `old_str` that's *almost* right (trailing spaces, re-indented,
// smart-quotes, missing middle). We try progressively looser strategies, but ALWAYS return a span
// that is an EXACT substring of the original file, so the replacement stays byte-correct. A strategy
// is only accepted if it matches UNIQUELY (no ambiguous edits).

export interface MatchResult {
  ok: boolean
  matched: string   // exact original substring to replace (valid only if ok)
  strategy: string
  count: number     // occurrences found by the winning/most-specific strategy
}

function occurrences(hay: string, needle: string): number {
  if (!needle) return 0
  let n = 0, i = 0
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length }
  return n
}

// per-line normalizers, strict → loose
const NORMALIZERS: Array<[string, (l: string) => string]> = [
  ["trim_trailing", (l) => l.replace(/[ \t]+$/, "")],
  ["strip_indent", (l) => l.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "")],
  // Full unicode-drift class: a local model reproducing a file often substitutes a smart quote, ANY
  // unicode dash, a non-breaking/ideographic space, or leaves a BOM — normalize all of them so the
  // near-miss still matches. Byte-preservation is inherent: findMatch returns the ORIGINAL span.
  ["unicode", (l) => l
    .replace(/﻿/g, "")                              // strip BOM / zero-width no-break space
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")         // single smart quotes
    .replace(/[“”„‟]/g, '"')         // double smart quotes
    .replace(/[‐-―−]/g, "-")              // all hyphens/dashes + minus sign
    .replace(/[  -   　]/g, " ") // NBSP + all special spaces
    .replace(/[ \t]+$/, "")],
  ["collapse_ws", (l) => l.replace(/\s+/g, " ").trim()],
]

function lineMatch(hayLines: string[], needleLines: string[], f: (l: string) => string): number[] {
  const nNorm = needleLines.map(f)
  const L = nNorm.length
  const starts: number[] = []
  for (let i = 0; i + L <= hayLines.length; i++) {
    let ok = true
    for (let j = 0; j < L; j++) if (f(hayLines[i + j]) !== nNorm[j]) { ok = false; break }
    if (ok) starts.push(i)
  }
  return starts
}

/** Find the unique original-text span to replace. */
export function findMatch(haystack: string, needle: string): MatchResult {
  if (typeof haystack !== "string" || typeof needle !== "string" || !needle)
    return { ok: false, matched: "", strategy: "none", count: 0 }

  // 1. exact
  const exact = occurrences(haystack, needle)
  if (exact === 1) return { ok: true, matched: needle, strategy: "exact", count: 1 }
  if (exact > 1) return { ok: false, matched: "", strategy: "exact", count: exact }

  // 2. line-based, strict → loose; first strategy with a UNIQUE match wins
  const hayLines = haystack.split("\n")
  const needleLines = needle.split("\n")
  for (const [name, f] of NORMALIZERS) {
    const starts = lineMatch(hayLines, needleLines, f)
    if (starts.length === 1) {
      const i = starts[0]
      const matched = hayLines.slice(i, i + needleLines.length).join("\n")
      if (occurrences(haystack, matched) === 1) return { ok: true, matched, strategy: name, count: 1 }
    } else if (starts.length > 1) {
      return { ok: false, matched: "", strategy: name, count: starts.length }
    }
  }

  // 3. block-anchor: first & last needle lines (trimmed) bound a unique span of the same length
  if (needleLines.length >= 2) {
    const first = needleLines[0].trim(), last = needleLines[needleLines.length - 1].trim()
    const L = needleLines.length
    const starts: number[] = []
    for (let i = 0; i + L <= hayLines.length; i++) {
      if (hayLines[i].trim() === first && hayLines[i + L - 1].trim() === last) starts.push(i)
    }
    if (starts.length === 1) {
      const matched = hayLines.slice(starts[0], starts[0] + L).join("\n")
      if (occurrences(haystack, matched) === 1) return { ok: true, matched, strategy: "block_anchor", count: 1 }
    }
  }

  return { ok: false, matched: "", strategy: "none", count: 0 }
}

// ── escape-drift guard ──
// Local models sometimes emit the two characters backslash+n instead of a real newline.
export interface EscapeDrift { drift: boolean; fixed: string }
export function checkEscapeDrift(newStr: string): EscapeDrift {
  if (typeof newStr !== "string") return { drift: false, fixed: newStr }
  const literalNL = (newStr.match(/\\n/g) || []).length
  const realNL = (newStr.match(/\n/g) || []).length
  // strong signal: several literal "\n" sequences and NO real newlines → almost certainly a mistake
  const drift = literalNL >= 2 && realNL === 0
  const fixed = newStr.replace(/\\n/g, "\n").replace(/\\t/g, "\t")
  return { drift, fixed }
}
