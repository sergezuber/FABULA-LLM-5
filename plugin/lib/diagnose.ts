// Structured root-cause steer for auto-rewind (W2). PROBE (arXiv:2605.08717) / AgentDebug (arXiv:2509.25370):
// a generic "try a different approach" recovers materially worse than an evidence-grounded diagnosis. This
// is PURE + deterministic (RULE #9 — no model call): it classifies the recurring failure signature across
// the red streak and names the specific corrective, grounded in the real verify output + the edited files.

export type ErrorClass = "assertion" | "import" | "type" | "timeout" | "syntax" | "lint" | "runtime" | "unknown"

const PATTERNS: [ErrorClass, RegExp][] = [
  ["assertion", /\bassert(ion)?\b|assertionerror|expected\b.*\b(got|but|to)\b/i],
  ["import", /\bimporterror\b|no module named|cannot find module|module ?not ?found|unresolved import/i],
  ["type", /\btype ?error\b|is not a function|has no attribute|not callable|nonetype|undefined is not/i],
  ["timeout", /\btime(d)? ?out\b|timeouterror|exceeded .*\btime\b|deadline exceeded/i],
  ["syntax", /\bsyntax ?error\b|unexpected token|invalid syntax|parse error|unexpected end of/i],
  ["lint", /\beslint\b|\bruff\b|\bflake8\b|\blint\b|no-unused|prefer-const/i],
]

export function classifyError(text: string): ErrorClass {
  const t = (text || "")
  for (const [cls, re] of PATTERNS) if (re.test(t)) return cls
  return /\b(error|fail(ed|ure)?|traceback|exception|panic|fault|core dumped|segfault|abort(ed)?|raise[sd]?|✗|❌)\b/i.test(t) ? "runtime" : "unknown"
}

const HINT: Record<ErrorClass, string> = {
  assertion: "the expected value/behavior is wrong — re-read the issue/spec for the exact contract before editing the same site again",
  import: "a name or path is unresolved — the module/symbol you reference does not exist as written; verify the real API before re-adding it",
  type: "a value has the wrong shape/type at the call site — check what the function actually returns and expects, don't reshape blindly",
  timeout: "the change did not terminate in time — look for an unbounded loop/await or a wrong async contract, not the assertion",
  syntax: "the edit left the file unparseable — fix the syntax first; nothing else can be evaluated until it parses",
  lint: "a style/lint rule fails — a functional change that trips lint is still red; satisfy the rule the config enforces",
  runtime: "the code raised at runtime — read the TOP frame of the traceback for the real origin, not the last line",
  unknown: "the same check keeps failing — diagnose the actual failing line before repeating the edit",
}

/** Build the grounded steer from the red-streak evidence. `notes` = the failing lines (newest last),
 *  `files` = the edited paths. Names the recurring failure signature + the class-specific corrective. */
export function diagnose(notes: string[], files: string[]): string {
  const clean = (notes || []).map((n) => (n || "").trim()).filter(Boolean)
  const fileList = files.length ? ` (edited: ${files.slice(0, 4).join(", ")}${files.length > 4 ? ", …" : ""})` : ""
  if (!clean.length) return `The last attempts all failed verify${fileList}. Diagnose the actual failing line before repeating the edit.`
  const classes = clean.map(classifyError)
  const distinct = [...new Set(classes)]
  if (distinct.length === 1) {
    const cls = distinct[0]
    const sig = clean[clean.length - 1].slice(0, 160)
    return `Root cause: the failure signature is the SAME across all ${clean.length} attempt(s) [${cls}] — \`${sig}\`${fileList}. This is not the edit SITE; ${HINT[cls]}.`
  }
  const sigs = distinct.map((c) => `[${c}] \`${(clean.find((n) => classifyError(n) === c) || "").slice(0, 80)}\``)
  return `The ${clean.length} attempts failed with DIFFERENT failure signatures — ${sigs.join(" | ")}${fileList}. Do not assume one root cause; address the CURRENT failing line, not a previous one.`
}
