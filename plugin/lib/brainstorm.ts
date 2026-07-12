// brainstorm-prototypes (Thariq Shihipar) — when you know the taste/feel but can't verbalize the
// requirement, generate 3-5 WILDLY DIFFERENT throwaway variations to react to, each labeled with the
// BELIEF it bets on. Reacting to concrete options surfaces the implicit preference faster than more
// questions. PURE core: the aux prompt + a light validity check.

/** Prompt: generate N divergent throwaway approaches, each tagged with the belief/bet it makes and the
 * tradeoff it accepts, so the human can react ("this one — no, but that bit"). Not implementations —
 * sketches to choose between. */
export function brainstormPrompt(task: string, codeContext = ""): string {
  return [
    "Generate 3 to 5 WILDLY DIFFERENT throwaway design variations for the task — options to REACT to,",
    "not to build. They must genuinely diverge (different core bet, not cosmetic tweaks). For EACH:",
    "  - a short name",
    "  - BELIEF: the assumption/bet it makes about what matters here",
    "  - SKETCH: 2-4 lines of how it works (approach, key data flow / UI shape / API)",
    "  - TRADEOFF: what it optimizes for and what it gives up",
    "Spread the bets: cover the safe/obvious one AND at least one contrarian option. No preamble.",
    "Format each as:",
    "### <name>",
    "BELIEF: ...",
    "SKETCH: ...",
    "TRADEOFF: ...",
    "",
    "=== TASK ===",
    (task || "").trim(),
    codeContext ? "\n=== SURROUNDING CODE (constraints to respect) ===\n" + codeContext.trim() : "",
  ].filter(Boolean).join("\n")
}

/** Count the distinct variations in a brainstorm reply (each starts with a `### ` heading). */
export function countVariations(text: string): number {
  if (typeof text !== "string") return 0
  return (text.match(/^###\s+\S/gm) || []).length
}

/** A brainstorm reply is usable when it has >=2 variations that each bet a belief. */
export function looksLikeBrainstorm(text: string): boolean {
  return countVariations(text) >= 2 && /BELIEF:/i.test(text)
}
