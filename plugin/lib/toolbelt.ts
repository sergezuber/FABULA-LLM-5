// Active-tool belts (pure, unit-testable). A "belt" is the set of tool ids the model may see on a
// given profile. Masking the rest cuts BOTH the request's tool schemas (the measured cost is ~67k
// fixed tokens/step, most of it from ~50 tool schemas irrelevant to a coding task) AND the system
// prompt prose. The engine builds every registry tool's schema regardless of the per-message
// allow/deny map (that map only becomes deny-permissions, the schema still ships), so the actual
// schema drop is an engine-side skip fed by codingMask() here. DENY-LIST by design: only tools we
// KNOW are non-coding are masked — unknown/new tools stay visible so nothing silently breaks.

export type Profile = "coding" | "full"

export interface ToolMeta {
  /** false = not relevant to a coding task (vision/browser/ops/weather/…); masked in "coding". */
  coding?: boolean
  /** one-line description for the belt-composed "Available tools" list. */
  snippet?: string
  /** guideline bullets included in the system block ONLY while the tool is active. */
  guidelines?: string[]
}

// Never masked regardless of profile: read (always safe) and the verify gate (the model must always
// be able to prove "done" — the verify lock).
export const ALWAYS_ON = new Set<string>(["view", "verify_done"])

/** Tool ids to MASK in the coding profile: those explicitly marked coding:false, minus ALWAYS_ON. */
export function codingMask(meta: Record<string, ToolMeta>): string[] {
  return Object.entries(meta)
    .filter(([id, m]) => m.coding === false && !ALWAYS_ON.has(id))
    .map(([id]) => id)
}

/** Which of the actually-registered tool ids to skip, for a profile. "full" masks nothing. */
export function maskedTools(allToolIds: string[], meta: Record<string, ToolMeta>, profile: Profile): string[] {
  if (profile === "full") return []
  const mask = new Set(codingMask(meta))
  return allToolIds.filter((id) => mask.has(id))
}

/** The active (non-masked) tool ids for a profile, preserving input order. */
export function activeTools(allToolIds: string[], meta: Record<string, ToolMeta>, profile: Profile): string[] {
  const masked = new Set(maskedTools(allToolIds, meta, profile))
  return allToolIds.filter((id) => !masked.has(id))
}

/** Assemble the belt prompt block: one line per active tool that has a snippet + merged guidelines. */
export function beltPromptBlock(activeIds: string[], meta: Record<string, ToolMeta>): string {
  const lines: string[] = []
  const listed = activeIds.filter((id) => meta[id]?.snippet)
  if (listed.length) {
    lines.push("[FABULA ACTIVE TOOLS]")
    for (const id of listed) lines.push(`- ${id}: ${meta[id]!.snippet}`)
  }
  const guides = new Set<string>()
  for (const id of activeIds) for (const g of meta[id]?.guidelines ?? []) guides.add(g)
  if (guides.size) {
    lines.push("", "[GUIDELINES]")
    for (const g of guides) lines.push(`- ${g}`)
  }
  return lines.join("\n")
}
