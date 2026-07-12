// Context OS section 7 calibration — offline golden set (pure). Labels come from history: the FIRST
// real user message of a session → the DISTINCT tools that session actually used. The router
// is then evaluated OFFLINE (recall = did the selected profile cover the used tools; size =
// what it would have cost), gating Phase 1 BEFORE anything goes live (RULE #4/#13).

import type { Profile, RouteDecision, ToolCard } from "./toolrouter"
import { buildIndex, route } from "./toolrouter"

export type GoldenCase = {
  sessionId: string
  /** first real user message text (the router's input at session start) */
  task: string
  /** distinct tools the session actually called (the label) */
  tools: string[]
}

export type SessionRow = { sessionId: string; firstUserText: string | null; tool: string }

/** Assemble golden cases from flat (session, firstUserText, tool) rows. Sessions without a
 *  usable first user text or without tool calls are dropped (counted by the caller). */
export function buildGoldenCases(rows: readonly SessionRow[]): GoldenCase[] {
  const bySession = new Map<string, { task: string; tools: Set<string> }>()
  for (const r of rows) {
    if (!r.firstUserText || !r.firstUserText.trim() || !r.tool) continue
    let e = bySession.get(r.sessionId)
    if (!e) bySession.set(r.sessionId, (e = { task: r.firstUserText, tools: new Set() }))
    e.tools.add(r.tool)
  }
  return [...bySession.entries()].map(([sessionId, e]) => ({
    sessionId,
    task: e.task,
    tools: [...e.tools].sort(),
  }))
}

export type EvalResult = {
  cases: number
  /** share of cases where EVERY used tool was visible (T0 ∪ profile ∪ pinned) — the recall gate */
  fullCoverage: number
  /** mean share of used tools visible per case */
  meanCoverage: number
  /** mean visible-set size (precision proxy — smaller is leaner) */
  meanVisible: number
  /** cases where the router would have hidden ≥1 used tool, with the misses (for calibration) */
  misses: { sessionId: string; profileId: string; missed: string[] }[]
}

/**
 * Offline evaluation: for each golden case, run the router on the FIRST user text and check
 * whether the tools the session ACTUALLY used would have been visible.
 * Visible = T0 (never masked) ∪ chosen profile members ∪ verbatim pins.
 */
export function evaluateRouter(
  cases: readonly GoldenCase[],
  cards: readonly ToolCard[],
  profiles: readonly Profile[],
  t0: ReadonlySet<string>,
  opts: { margin?: number } = {},
): EvalResult {
  const index = buildIndex(cards)
  const known = new Set(cards.map((c) => c.id))
  let full = 0
  let covSum = 0
  let visSum = 0
  const misses: EvalResult["misses"] = []
  for (const gc of cases) {
    const d: RouteDecision = route(cards, profiles, gc.task, { index, margin: opts.margin })
    const prof = profiles.find((p) => p.id === d.profileId)!
    const visible = new Set<string>([...t0, ...prof.tools, ...d.pinned])
    // only judge tools the registry knows — history may contain tools that no longer exist
    const used = gc.tools.filter((t) => known.has(t))
    if (!used.length) continue
    const covered = used.filter((t) => visible.has(t))
    covSum += covered.length / used.length
    visSum += visible.size
    if (covered.length === used.length) full += 1
    else misses.push({ sessionId: gc.sessionId, profileId: d.profileId, missed: used.filter((t) => !visible.has(t)) })
  }
  const n = full + misses.length
  return {
    cases: n,
    fullCoverage: n ? full / n : 1,
    meanCoverage: n ? covSum / n : 1,
    meanVisible: n ? visSum / n : 0,
    misses,
  }
}
