// interview-me — surface the ONE architecture-changing question that only the human can answer
// (Thariq Shihipar), built active per RULE #9. Key discipline: NEVER ask what the codebase can answer
// (those get resolved by reading — reference_hunt / surface_unknowns); ask ONLY the decision the code
// cannot settle, one at a time, highest-leverage first. In an autonomous run there's no human, so the
// same triage yields explicit ASSUMPTIONS to state and proceed on. PURE core: prompt builder + parser
// + an underspecified-task heuristic for the auto-nudge.

/** Prompt: triage a task's unknowns into CODE-ANSWERABLE (resolve by reading) vs HUMAN-ONLY (a real
 * decision), grounded in the surrounding code, and surface the single most important human question. */
export function triagePrompt(task: string, codeContext: string): string {
  return [
    "You are triaging what's UNKNOWN about a task before implementation, to avoid guessing wrong.",
    "Split the unknowns into two buckets, grounded in the REAL surrounding code:",
    "  CODE-ANSWERABLE — things the codebase already fixes (conventions, existing helpers, signatures,",
    "    invariants). These must be RESOLVED BY READING, never asked of the human. Name the file/symbol.",
    "  HUMAN-ONLY — genuine decisions the code cannot settle (product intent, tradeoffs, scope). ",
    "Then give THE ONE question, highest-leverage / most architecture-changing, that only the human can",
    "answer — and a safe DEFAULT assumption to proceed on if no human replies.",
    "Format EXACTLY:",
    "CODE-ANSWERABLE:",
    "- <item> (file/symbol) — resolve by reading",
    "HUMAN-ONLY:",
    "- <item>",
    "TOP QUESTION: <the single most important question for the human>",
    "DEFAULT IF NO ANSWER: <the assumption you'll proceed on>",
    "",
    "=== TASK ===",
    (task || "").trim(),
    "",
    "=== SURROUNDING CODE ===",
    (codeContext || "(none provided)").trim(),
  ].join("\n")
}

/** Parse a triage reply into its sections (best-effort, never throws). */
export function parseTriage(text: string): { codeAnswerable: string; humanOnly: string; topQuestion: string; defaultAssumption: string } {
  const t = typeof text === "string" ? text : ""
  const sec = (label: string, next: string[]) => {
    const stop = next.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    const re = new RegExp(label + "\\s*:?\\s*([\\s\\S]*?)(?:" + (stop || "$") + "|$)", "i")
    const m = t.match(re)
    return m ? m[1].trim() : ""
  }
  return {
    codeAnswerable: sec("CODE-ANSWERABLE", ["HUMAN-ONLY", "TOP QUESTION", "DEFAULT IF NO ANSWER"]),
    humanOnly: sec("HUMAN-ONLY", ["TOP QUESTION", "DEFAULT IF NO ANSWER"]),
    topQuestion: sec("TOP QUESTION", ["DEFAULT IF NO ANSWER"]),
    defaultAssumption: sec("DEFAULT IF NO ANSWER", []),
  }
}

// ── underspecified-task heuristic (drives the auto-nudge that fires itself) ───
const IMPL_VERB = /\b(add|implement|build|create|write|make|refactor|change|fix|support|integrate|wire|port|migrate|hook up|set up)\b/i
// concrete-spec signals: file paths, symbols, quoted strings, exact values — presence means less need to interview
const HAS_PATH = /[\w./-]+\.[a-z]{1,5}\b|\//
const HAS_SYMBOL = /`[^`]+`|\b[a-z_][a-z0-9_]*\([^)]*\)|\b[A-Z][a-zA-Z0-9]{3,}\b/
const HAS_QUOTE = /"[^"]{3,}"|'[^'\n]{3,}'/

/** True when a task reads like an implementation ask but is thin on concrete spec — the moment an
 * up-front interview / unknowns pass pays off. Deterministic, so the harness can fire the nudge itself
 * instead of hoping the model notices. */
export function looksUnderspecified(task: string): boolean {
  if (!task || typeof task !== "string") return false
  const t = task.trim()
  if (!IMPL_VERB.test(t)) return false          // not an implementation ask → nothing to interview
  const concreteSignals = [HAS_PATH, HAS_SYMBOL, HAS_QUOTE].filter((re) => re.test(t)).length
  // short + few concrete anchors ⇒ underspecified; long or well-anchored ⇒ leave it alone
  return t.length < 240 && concreteSignals < 2
}

export const INTERVIEW_NUDGE =
  "\n\n[FABULA interview-me] This task reads as underspecified for its area. Before implementing, run " +
  "`interview_me` — it separates what the CODEBASE can answer (resolve those by reading, e.g. via " +
  "reference_hunt) from the ONE decision only the human can make, so you don't silently guess an " +
  "architecture. State your assumption explicitly if you proceed without an answer."
