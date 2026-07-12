// Autonomous spec-mining + reproduction-test generation — PURE core (prompt builders + output
// parsers). The tool wrapper does the network (callAux) and file IO. This productizes the two levers
// proven on SWE-bench Pro 479aa075, but WITHOUT a human hand-feeding anything:
//   #1 spec-mining — derive an exact behavioral spec from the issue text + relevant code, so the
//      agent implements the precise contract (exact error strings, order, preserved behavior).
//   #2 reproduce-first — turn that spec into a reproduction test that EXERCISES the new behavior, so
//      the reproduce-gate has something real to gate on (a green existing suite doesn't prove a fix).
//
// Kept pure so prompts/parsers are unit-tested with no model call; the live callAux path is exercised
// separately (real backend, per the project's no-mocks testing rule).

export type Language = "python" | "typescript" | "javascript" | "go" | "rust" | "ruby" | "unknown"

/** Best-effort language from a test-file path (drives framework wording + the sanity gate). */
export function languageOf(pathOrExt: string): Language {
  const e = (pathOrExt || "").toLowerCase()
  if (/\.py$/.test(e) || e === "python") return "python"
  if (/\.tsx?$/.test(e) || e === "typescript") return "typescript"
  if (/\.jsx?$/.test(e) || e === "javascript") return "javascript"
  if (/\.go$/.test(e) || e === "go") return "go"
  if (/\.rs$/.test(e) || e === "rust") return "rust"
  if (/\.rb$/.test(e) || e === "ruby") return "ruby"
  return "unknown"
}

const FRAMEWORK: Record<Language, string> = {
  python: "pytest (def test_*, plain assert / pytest.raises)",
  typescript: "the project's test runner (describe/test + expect)",
  javascript: "the project's test runner (describe/test + expect)",
  go: "the standard library testing package (func TestXxx(t *testing.T))",
  rust: "#[test] functions with assert!/assert_eq!",
  ruby: "the project's test framework (RSpec/minitest)",
  unknown: "the project's existing test framework",
}

/**
 * Prompt: mine an EXACT behavioral spec from the issue + relevant code. The aux model must not solve
 * the bug — only state, unambiguously, what a correct fix must do (this is what closed the spec gap).
 */
export function specPrompt(issue: string, codeContext: string): string {
  return [
    "You are a precise software SPEC EXTRACTOR. Read the issue and the relevant code, then state the",
    "EXACT intended behavior a correct fix must implement. Do NOT write the fix. Be unambiguous:",
    "- exact function/method signatures involved",
    "- the EXACT error messages / exception types (quote them verbatim)",
    "- the ordered decision logic (what is tried first, then the fallback)",
    "- which EXISTING behavior must be preserved (do not break current callers/tests)",
    "- concrete input→output / input→error examples for the new case AND the existing case",
    "Output a terse bulleted spec only — no preamble, no fix.",
    "",
    "=== ISSUE ===",
    issue.trim(),
    "",
    "=== RELEVANT CODE ===",
    (codeContext || "(none provided)").trim(),
  ].join("\n")
}

/**
 * Prompt: turn the spec into a REPRODUCTION TEST. It must exercise the NEW behavior end-to-end and
 * assert the exact expected output / error, plus a sanity case for the existing behavior. Output is
 * ONLY the test file's source (no prose) so the caller can write it straight to disk.
 */
export function reproPrompt(issue: string, spec: string, opts: { language: Language; testPath: string; importHint?: string }): string {
  const fw = FRAMEWORK[opts.language] || FRAMEWORK.unknown
  return [
    `Write a COMPLETE, RUNNABLE REPRODUCTION TEST file for ${opts.testPath} using ${fw}.`,
    "Rules:",
    "- Output a WHOLE file: all imports at the top, top-level test functions at column 0 (NO leading",
    "  indentation on `def`/`func`/`test(`), runnable as-is. Do NOT emit a bare snippet.",
    "- Import the real module under test (use the import path hint if given) AND the test framework",
    "  (e.g. `import pytest`). No mocks of the unit under test.",
    "- Cover the NEW behavior from the spec (the case the issue is about) AND one existing-behavior",
    "  case, asserting the EXACT expected values / error messages from the spec.",
    "- Keep it MINIMAL: 2 to 4 cases, COMPLETE and runnable (never cut off mid-line). Fewer, correct",
    "  cases beat many shaky ones.",
    "- CRITICAL — construct each input so it ACTUALLY reaches the intended code path. Re-read the",
    "  spec's matching/parsing logic step by step for every input: trace which branch it hits and what",
    "  EXACT value/error results. A tiny difference (a trailing delimiter, a missing byte, an invalid",
    "  character) can send the input down the OLD path instead of the new one — if so, your assertion",
    "  will be wrong. Only assert values you can DERIVE with certainty by simulating the spec on the input.",
    "- The test must FAIL on the current (unfixed) behavior and PASS once the fix is correct.",
    "- Output ONLY the complete test source, inside a SINGLE fenced code block. No prose, no reasoning.",
    opts.importHint ? `- Import hint: ${opts.importHint}` : "",
    "",
    "=== ISSUE ===",
    issue.trim(),
    "",
    "=== SPEC (authoritative) ===",
    spec.trim(),
  ].filter(Boolean).join("\n")
}

/**
 * Extract code from an aux-model reply: prefer the first fenced ```code``` block; else, if the whole
 * reply looks like code, return it trimmed. Returns "" when nothing usable is found.
 */
export function extractCode(auxText: string): string {
  if (typeof auxText !== "string") return ""
  let code = ""
  // closed fence — return its body
  const fence = auxText.match(/```[a-zA-Z0-9_+-]*\s*\n([\s\S]*?)```/)
  if (fence) code = fence[1]
  else {
    // unterminated opening fence (reasoning model ran out of tokens before the closing ```)
    const open = auxText.match(/```[a-zA-Z0-9_+-]*\s*\n([\s\S]*)$/)
    if (open) code = open[1].replace(/```+\s*$/, "")
    else {
      const t = auxText.trim()
      // no fence — accept only if it doesn't read like prose (has code-ish lines)
      if (/\b(def |class |func |import |from |const |describe\(|test\(|assert|#\[test\])/.test(t)) code = t
    }
  }
  return dedent(code).replace(/\s+$/, "")
}

/** Strip the common leading indentation shared by all non-blank lines (models often emit an indented
 * block, which is an IndentationError for top-level Python test functions). */
export function dedent(s: string): string {
  if (!s) return ""
  const lines = s.replace(/\t/g, "    ").split("\n")
  let min = Infinity
  for (const ln of lines) {
    if (!ln.trim()) continue
    const lead = ln.length - ln.replace(/^ +/, "").length
    if (lead < min) min = lead
  }
  if (!Number.isFinite(min) || min === 0) return s.replace(/\t/g, "    ")
  return lines.map((ln) => (ln.trim() ? ln.slice(min) : ln)).join("\n")
}

/** Sanity gate: does this look like an actual test in the target language? Guards against prose/empty. */
export function looksLikeTest(code: string, language: Language): boolean {
  if (!code || code.trim().length < 20) return false
  switch (language) {
    case "python": return /\bdef\s+test_?\w*\s*\(/.test(code) || /\bassert\b/.test(code) || /pytest\.raises/.test(code)
    case "typescript":
    case "javascript": return /\b(test|it)\s*\(/.test(code) || /\bexpect\s*\(/.test(code) || /\bdescribe\s*\(/.test(code)
    case "go": return /func\s+Test\w+\s*\(/.test(code)
    case "rust": return /#\[test\]/.test(code)
    case "ruby": return /\b(describe|it|def\s+test_|assert)/.test(code)
    default: return /\b(test|assert|expect|def\s+test|func\s+Test)\b/.test(code)
  }
}
