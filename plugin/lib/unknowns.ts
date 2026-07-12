// "Finding your unknowns" — the harness ACTIVELY closes the prompt↔codebase gap for the local model,
// instead of hoping the model self-invokes a skill (RULE #9: model-won't-do-X-reliably ⇒ build the
// mechanism that fires X itself). Productizes Thariq Shihipar's techniques as ACTIVE plugin pieces:
//   reference_hunt   — read working source as the spec: find analogous code, digest its semantics.
//   surface_unknowns — blindspot pass: surface unknown-unknowns in an unfamiliar area, refine the ask.
//   reference-first gate — a tool.execute.after steer that fires on the first source edit made without
//                          a prior reference/unknowns pass (mirrors the reproduce-first gate).
//
// PURE core (prompt builders + parsers + gate state). The plugin does grep/read/callAux + hook wiring.

// ── reference-hunt ───────────────────────────────────────────────────────────
/** Derive grep search terms from a free-text goal when the caller didn't pass an explicit pattern:
 * identifiers, dotted names, quoted strings — the tokens most likely to name analogous code. */
export function refHuntTerms(goal: string): string[] {
  if (!goal || typeof goal !== "string") return []
  const terms = new Set<string>()
  for (const m of goal.matchAll(/`([^`]{2,60})`|"([^"]{2,60})"|'([^'\n]{2,60})'/g))
    terms.add((m[1] || m[2] || m[3]).trim())
  for (const m of goal.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)+|[A-Z][a-zA-Z0-9]{3,}|[a-z_][a-z0-9_]{4,})\b/g))
    terms.add(m[1])
  // drop common English/filler tokens that would match everything
  const stop = new Set(["implement", "function", "feature", "should", "behavior", "handle", "return", "create", "update", "support", "using", "which", "where", "there", "value", "class", "method"])
  return [...terms].filter((t) => !stop.has(t.toLowerCase())).slice(0, 8)
}

/** Prompt: digest the FOUND reference code into a behavior/semantics spec BEFORE reimplementing.
 * The aux model must summarize what the reference does (contract), not judge or rewrite it. */
export function refDigestPrompt(goal: string, snippets: string): string {
  return [
    "You are reading EXISTING working code to use it as a SPECIFICATION for a new implementation.",
    "Write a terse SEMANTICS SUMMARY of how the reference below works — the contract a reimplementation",
    "must satisfy. Cover: the exact inputs/outputs & their shapes, the ordered control flow / decision",
    "branches, edge cases & error handling (quote exact messages), invariants that must be preserved,",
    "and any non-obvious gotchas. Do NOT rewrite the code and do NOT critique it — only describe behavior.",
    "Bulleted, no preamble. If the snippets are irrelevant to the goal, say so in one line.",
    "",
    "=== GOAL (what we are about to implement) ===",
    (goal || "").trim(),
    "",
    "=== REFERENCE CODE FOUND IN THE REPO ===",
    (snippets || "(none found)").trim(),
  ].join("\n")
}

// ── blindspot / surface-unknowns ─────────────────────────────────────────────
/** Prompt: surface the UNKNOWN-UNKNOWNS for a task in an unfamiliar area, grounded in the real code,
 * then rewrite the ask so the implementation won't silently guess wrong. */
export function blindspotPrompt(task: string, codeContext: string): string {
  return [
    "You are doing a BLINDSPOT PASS before implementation, to move unknown-unknowns into the known.",
    "Given the task and the REAL surrounding code, list the specific things an implementer would need to",
    "know but the task DOESN'T state — hidden conventions, existing helpers to reuse, invariants, edge",
    "cases, error/return contracts, config/flags, and where a naive guess would diverge from this codebase.",
    "Ground every point in the code (name the file/symbol). Then output a REFINED TASK: the original ask",
    "rewritten to bake in what you found, so the implementation is unambiguous.",
    "Format EXACTLY:",
    "UNKNOWNS:",
    "- <grounded point> (file/symbol)",
    "REFINED TASK:",
    "<the rewritten, unambiguous task>",
    "",
    "=== TASK ===",
    (task || "").trim(),
    "",
    "=== SURROUNDING CODE ===",
    (codeContext || "(none provided)").trim(),
  ].join("\n")
}

/** Split a blindspot reply into the unknowns list and the refined task (best-effort, never throws). */
export function parseBlindspot(text: string): { unknowns: string; refined: string } {
  const t = typeof text === "string" ? text : ""
  const rm = t.match(/REFINED TASK:\s*([\s\S]*)$/i)
  const refined = rm ? rm[1].trim() : ""
  const um = t.match(/UNKNOWNS:\s*([\s\S]*?)(?:REFINED TASK:|$)/i)
  const unknowns = um ? um[1].trim() : t.trim()
  return { unknowns, refined }
}

// ── reference-first gate (active steer) ──────────────────────────────────────
const SRC_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rs|rb|java|c|cc|cpp|cxx|h|hpp|php|swift|kt|kts|scala|cs|m|mm)$/
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs)\//
const TEST_FILE = /(^|[._-])(test|spec)\.[a-z0-9]+$|^test_.*\.[a-z0-9]+$|_(test|spec)\.[a-z0-9]+$/

/** True for a SOURCE file (a non-test code file) — editing one is when the reference pass matters. */
export function isSourceFile(p: string): boolean {
  if (!p || typeof p !== "string") return false
  const f = p.replace(/\\/g, "/").toLowerCase()
  const base = f.split("/").pop() || ""
  if (TEST_DIR.test(f) || TEST_FILE.test(base)) return false
  return SRC_EXT.test(base)
}

export interface UnknownsState {
  didReferencePass: boolean // reference_hunt / surface_unknowns was called this task
  steered: boolean          // the reference-first steer already fired once (don't nag every edit)
}
export function newUnknownsState(): UnknownsState {
  return { didReferencePass: false, steered: false }
}

export const REFERENCE_FIRST_STEER =
  "\n\n⚠️ REFERENCE-FIRST: you're editing SOURCE in this task without having read analogous working code " +
  "or surfaced the unknowns first. On an unfamiliar area a local-first agent's #1 failure is silently " +
  "guessing a convention the codebase already fixes. Before you go further, call `reference_hunt` (find " +
  "and digest an existing implementation to copy the contract from) and/or `surface_unknowns` (list what " +
  "the task doesn't state, grounded in the real code), then proceed with the refined understanding."

/** Decide whether the reference-first steer should fire on this edit. Fires once per task, only when a
 * SOURCE file is edited and no reference/unknowns pass has happened yet. */
export function shouldSteerReferenceFirst(st: UnknownsState, editedPath: string): boolean {
  return !st.didReferencePass && !st.steered && isSourceFile(editedPath)
}
