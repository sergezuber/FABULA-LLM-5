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


/** How many sessions these process-lifetime channels keep. They hang off `globalThis` and the engine
 *  server is long-lived, so without a bound every session ever routed stays resident for as long as the
 *  process does — and the shadow channel retains tool CLOSURES, not just data. A cap plus insertion-order
 *  eviction keeps the newest work addressable while making unbounded growth impossible. */
const CHANNEL_MAX_SESSIONS = (() => {
  const n = Number(process.env.FABULA_CHANNEL_MAX_SESSIONS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 32
})()

function capChannel<V>(m: Map<string, V>, keep: string): void {
  // Least recently USED, not first seen. The comment here used to argue the opposite — that re-stamping
  // "refreshes nothing on purpose" because a busy session keeps being re-inserted — and that reasoning is
  // wrong for the same reason it was wrong in the engine's `stashShadow`: a plain `set` leaves an existing
  // key where it was FIRST inserted, so the session being written on every turn stays the oldest key
  // forever and is evicted by the next other session's write. Measured on this very channel: the actively
  // used session was dropped once across 60 interleaved writes, and zero times after this line.
  //
  // The engine's copy of this rule was corrected in an earlier wave and this one was not — the same rule
  // living in two modules, diverging the moment only one of them is touched.
  while (m.size > CHANNEL_MAX_SESSIONS) {
    const oldest = m.keys().next().value as string | undefined
    if (oldest === undefined || oldest === keep) break
    m.delete(oldest)
  }
}

/** Drop everything held for a session — call it when the engine says the session is gone. */
export function dropSessionChannels(sessionID: string): void {
  beltChannel().delete(sessionID)
  shadowChannel().delete(sessionID)
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

/** Stamp a session's belt entry, keeping the channel bounded. The ONLY supported way to write it —
 *  a caller that used `beltChannel().set()` directly would reintroduce the unbounded growth. */
export function setBeltEntry(sessionID: string, entry: BeltEntry): void {
  const m = beltChannel()
  m.delete(sessionID) // re-insert so this session becomes the most recent, never the eviction candidate
  m.set(sessionID, entry)
  capChannel(m, sessionID)
}

// NOTE: there is deliberately NO capped shadow WRITER here. The real writer is the engine's
// `session/belt.ts stashShadow()`, and that is where the cap lives. A second capped writer sat in this
// file with zero callers — the plausible-looking one, next to `setBeltEntry` which IS the enforcement
// point for its own channel — so a reader grepping for the bound found the dead copy first.
