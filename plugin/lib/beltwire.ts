// Context OS Phase 1 — the tool-router plugin's wiring helpers (pure where possible; kept in
// lib/ so fabula-toolrouter.ts exports EXACTLY ONE Fabula* factory, per the plugin contract).
import { route, type Profile as RouteProfile } from "./toolrouter"
import { BELT_PROFILES, buildToolCards, hideSetFor } from "./toolcards"

export const BELT_CHANNEL_KEY = "__FABULA_SESSION_BELT__"

export type BeltEntry = {
  profileId: string
  hide: readonly string[]
  hideGlobs: readonly string[]
  watermark?: string
}

/** The session-keyed handoff map the engine's session/belt.ts reads (same process). */
export function beltChannel(): Map<string, BeltEntry> {
  const g = globalThis as Record<string, unknown>
  if (!(g[BELT_CHANNEL_KEY] instanceof Map)) g[BELT_CHANNEL_KEY] = new Map<string, BeltEntry>()
  return g[BELT_CHANNEL_KEY] as Map<string, BeltEntry>
}

export function routerOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.FABULA_TOOL_ROUTER === "1"
}

/** Extract the task text from a chat.message output payload (non-synthetic text parts). */
export function taskTextFrom(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p: any) => p && p.type === "text" && !p.synthetic && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n")
    .trim()
}

/** Pure decision step (unit-tested): route the task text and produce the belt entry. */
export function decideBelt(taskText: string, current?: string): { entry: BeltEntry; reason: string } {
  const cards = buildToolCards()
  const profiles: RouteProfile[] = BELT_PROFILES.map((p) => ({ id: p.id, tools: p.visibleForScoring(cards) }))
  const d = route(cards, profiles, taskText, { current })
  const hide = hideSetFor(d.profileId, [...d.pinned])
  return {
    entry: { profileId: d.profileId, hide: hide.exact, hideGlobs: hide.globs },
    reason: d.reason,
  }
}

/**
 * The RESIDENT catalog of hidden tools (design §4.5, MANDATORY): the model must know the
 * NAMES of masked tools to reach them. Two attempt paths, both harness-routed (RULE #9):
 * calling the hidden tool BY NAME (the engine repairs the call into expand_tools) or calling
 * `expand_tools` directly. BYTE-STABLE per profile: content depends only on the sorted hide
 * list, so within a segment the block never changes (cache-safe) — it changes exactly when
 * the profile changes (an already-planned prefix break).
 */
export function catalogBlock(entry: Pick<BeltEntry, "profileId" | "hide" | "hideGlobs"> | undefined): string {
  if (!entry || (!entry.hide.length && !entry.hideGlobs.length)) return ""
  const lines = [
    "[FABULA TOOL CATALOG — hidden by the active belt]",
    `Active profile: ${entry.profileId}. The tools below are HIDDEN from your schema list to keep`,
    "the context lean, but they still EXIST. To use one: call `expand_tools` with",
    '{"tool":"<name>","args":{...}} to execute it, or {"tool":"<name>"} alone to get its schema',
    "first. (Calling the hidden name directly also works — the harness reroutes it.) Do not",
    "invent tools that are not listed here or in your schemas.",
    ...[...entry.hide].sort().map((id) => `- ${id}`),
    ...[...entry.hideGlobs].sort().map((g) => `- ${g.replace(/_\*$/, "")} (server: all its tools)`),
  ]
  return lines.join("\n")
}

// ---- shadow access (reader side of the engine's per-session shadow-executor channel) ----

const SHADOW_KEY = "__FABULA_SESSION_SHADOW__"

export type ShadowTool = {
  description?: string
  inputSchema?: { jsonSchema?: unknown }
  execute: (args: unknown, options: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal }) => PromiseLike<unknown>
}

function shadowChannel(): Map<string, Map<string, ShadowTool>> {
  const g = globalThis as Record<string, unknown>
  if (!(g[SHADOW_KEY] instanceof Map)) g[SHADOW_KEY] = new Map()
  return g[SHADOW_KEY] as Map<string, Map<string, ShadowTool>>
}

export function shadowToolFor(sessionID: string, name: string): ShadowTool | undefined {
  return shadowChannel().get(sessionID)?.get(name)
}

export function shadowNamesFor(sessionID: string): string[] {
  return [...(shadowChannel().get(sessionID)?.keys() ?? [])].sort()
}
