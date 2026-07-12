import { test, expect } from "bun:test"
import { findMatch } from "./fuzzymatch"

// The file (haystack) contains the DRIFTED unicode; the model's oldText is plain ASCII. The unicode
// normalizer must make them match, and findMatch must return the ORIGINAL (drifted) span so a caller
// replacing it preserves the file's other bytes.
const cases: Array<[string, string]> = [
  ["smart single quote", "const s = ‘hi’"],
  ["smart double quote", "say(“hello”)"],
  ["en/em/figure dashes", "a – b — c ‒ d ― e"],
  ["minus sign U+2212", "x = a − b"],
  ["non-breaking space U+00A0", "if (x) return"],
  ["thin/hair spaces U+2009/200A", "a b c"],
  ["narrow nbsp U+202F", "1 000"],
  ["ideographic space U+3000", "foo　bar"],
  ["BOM at line start U+FEFF", "﻿import x"],
]

for (const [label, drifted] of cases) {
  test(`unicode drift matches ASCII oldText: ${label}`, () => {
    const ascii = drifted
      .replace(/﻿/g, "")
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[‐-―−]/g, "-")
      .replace(/[  -   　]/g, " ")
    const hay = `line0\n${drifted}\nline2`
    const m = findMatch(hay, `line0\n${ascii}\nline2`)
    expect(m.ok).toBe(true)
    // returns the ORIGINAL drifted span (byte-preserving), not the normalized text
    expect(m.matched).toContain(drifted.replace(/﻿/g, "") === drifted ? drifted : drifted.slice(1))
    expect(m.count).toBe(1)
  })
}

test("unchanged lines are never part of the returned span", () => {
  const hay = "keep A\nfn(‘x’)\nkeep B"
  const m = findMatch(hay, "fn('x')")
  expect(m.ok).toBe(true)
  expect(m.matched).toBe("fn(‘x’)")
  expect(m.matched).not.toContain("keep")
})
