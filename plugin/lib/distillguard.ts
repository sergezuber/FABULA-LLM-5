// FABULA-LLM-5 — block the engine's auto-`distill` self-improvement pass when it would run on an UNCENSORED
// model (pure, unit-testable core).
//
// User policy: an uncensored / decensored model must NEVER autonomously "distill" — i.e. review past
// chats (the raw trajectory DB) and package them into skills/agents/commands. Other (aligned) models
// may distill normally. The engine's `distill.auto` is a GLOBAL boolean with no per-model switch, so we gate
// it per-model in a chat hook: detect a distill run AND an uncensored model → neutralize that one run.

// Default markers of an uncensored/decensored build. Override/extend via FABULA_DISTILL_BLOCK_MODELS
// (a regex, or a comma-separated list of substrings).
const DEFAULT_UNCENSORED = /uncensor(ed)?|heretic|abliterat|\bablit\b|decensor|dolphin|\blewd\b|\bnsfw\b|unfilter|unaligned/i

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }

/** Resolve the "is this an uncensored model" matcher, honoring an env override. */
export function uncensoredPattern(env?: Record<string, string | undefined>): RegExp {
  const custom = env?.FABULA_DISTILL_BLOCK_MODELS?.trim()
  if (custom) {
    // A comma means an explicit substring LIST (escaped) — disambiguate from a regex, since a CSV like
    // "a, b" is itself a valid (but wrong) regex and would otherwise never reach this branch.
    if (custom.includes(",")) {
      const parts = custom.split(",").map((s) => s.trim()).filter(Boolean).map(escapeRe)
      if (parts.length) return new RegExp(parts.join("|"), "i")
    }
    try { return new RegExp(custom, "i") } catch { return new RegExp(escapeRe(custom), "i") }
  }
  return DEFAULT_UNCENSORED
}

export function isUncensoredModel(modelID: unknown, pat: RegExp): boolean {
  return typeof modelID === "string" && pat.test(modelID)
}

/** Is this turn the auto-distill pass? Primary signal: the subagent name "distill"; fallback: the
 *  stable prompt signature (kept specific so a user merely typing "distill" is NOT caught). */
export function isDistillRun(opts: { agent?: unknown; text?: unknown }): boolean {
  if (typeof opts.agent === "string" && opts.agent.trim().toLowerCase() === "distill") return true
  const t = typeof opts.text === "string" ? opts.text.toLowerCase() : ""
  if (!t) return false
  if (/\bautomatic distill pass\b/.test(t)) return true
  return /\bdistill pass\b/.test(t) && /trajectory database|repeated manual workflows|cross-session patterns/.test(t)
}

/** Block iff it's a distill run AND the model is uncensored (the only forbidden combination). */
export function shouldBlockDistill(opts: { agent?: unknown; text?: unknown; modelID: unknown; pat: RegExp }): boolean {
  return isDistillRun(opts) && isUncensoredModel(opts.modelID, opts.pat)
}

// Replacement injected in place of the distill instructions so the uncensored model does NOTHING:
// no DB inspection, no reading sessions, no asset creation — just a one-line acknowledgement.
export const DISTILL_SKIP_NOTICE =
  "FABULA policy: `distill` is DISABLED on uncensored models. Do NOT inspect any database, read any " +
  "past sessions, or create/modify any skills, agents, or commands. Ignore all earlier instructions in " +
  "this message. Reply with EXACTLY this one line and nothing else:\n" +
  "Distill skipped — disabled on uncensored models (FABULA policy)."
