// Terse per-role preambles for isolated sub-agents (LEAN code-string form, not a
// 40-60-line persona). At the FABULA layer subagent_type is otherwise decorative (only a tool-allowlist); the
// ONLY per-role carrier that reaches an isolated sub-agent is its op.prompt, which fabula-reliability already
// rewrites. We PREPEND a 3-6 line role + hard boundary + STOP there. GATED behind FABULA_SOULS=1 (default OFF)
// until a MEASURE-FIRST A/B shows it actually reduces wandering — weak local models may ignore prose (the very
// reason loopguard became a hard throw), so we ship it inert until measured, never as an unmeasured default.

const SOULS: Record<string, string> = {
  explore:
    "ROLE: explorer (READ-ONLY). Find the relevant files/symbols and report a concise list of file:line refs " +
    "plus a 1-2 line summary. BOUNDARY: do NOT edit, create, or run mutating commands. " +
    "STOP as soon as you have the answer — never re-read a file you already read.",
  build:
    "ROLE: builder. Make the SMALLEST change that satisfies the task. BOUNDARY: after editing you MUST run the " +
    "project's verify command before declaring done. STOP when the change is made and verified — do not wander " +
    "into unrelated files.",
}

/** A terse role preamble for an isolated sub-agent, or "" for unknown/unset types. */
export function rolePreamble(subagentType: unknown): string {
  const t = typeof subagentType === "string" ? subagentType.trim().toLowerCase() : ""
  return SOULS[t] || ""
}

export function soulsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FABULA_SOULS === "1"
}
