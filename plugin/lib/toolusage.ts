// Context OS Phase 0.4 (section 7 tiering): pure logic for
// deriving the T0/T1/T2 tool tiers from REAL usage history (fabula.db part rows). The head of
// the distribution must be pinned resident (T0) so the router never gets to mis-route a tool
// that practically every task needs; the long tail (T2) stays deferred (catalog + pull).
// Data-derived per RULE #4/#13 — thresholds are explicit knobs, not hardcoded magic.

export type UsageRow = { sessionId: string; tool: string }

export type ToolStat = {
  tool: string
  calls: number
  sessions: number
  /** share of all calls (0..1) */
  callShare: number
  /** share of distinct sessions the tool appears in (0..1) */
  sessionShare: number
}

/** Structurally mandatory tools: the self-firing gates/steers demand these BY NAME — masking
 *  any of them would deadlock a gate against the router (§13). Phase 1 unions them into T0. */
export const GATE_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  "verify_done",
  "skill",
  "change_quiz",
  "reference_hunt",
  "expand_tools",
])

/** Per-tool usage stats, sorted by calls desc (ties: tool name asc for determinism). */
export function usageHistogram(rows: readonly UsageRow[]): ToolStat[] {
  const calls = new Map<string, number>()
  const sessions = new Map<string, Set<string>>()
  const allSessions = new Set<string>()
  for (const r of rows) {
    if (!r.tool) continue
    calls.set(r.tool, (calls.get(r.tool) ?? 0) + 1)
    let s = sessions.get(r.tool)
    if (!s) sessions.set(r.tool, (s = new Set()))
    s.add(r.sessionId)
    allSessions.add(r.sessionId)
  }
  const totalCalls = rows.length
  const totalSessions = allSessions.size
  const out: ToolStat[] = []
  for (const [tool, c] of calls) {
    const s = sessions.get(tool)!.size
    out.push({
      tool,
      calls: c,
      sessions: s,
      callShare: totalCalls ? c / totalCalls : 0,
      sessionShare: totalSessions ? s / totalSessions : 0,
    })
  }
  out.sort((a, b) => b.calls - a.calls || (a.tool < b.tool ? -1 : 1))
  return out
}

export type TierOptions = {
  /** T0 rule (a): tool appears in at least this share of sessions. Default 0.5. */
  t0SessionShare?: number
  /** T0 rule (b): tools covering this cumulative share of all calls. Default 0.8. */
  t0CumulativeCalls?: number
  /** T2 rule: below BOTH shares → deferred long tail. Defaults 0.05 / 0.01. */
  t2SessionShare?: number
  t2CallShare?: number
  /** Extra never-maskable ids (unioned with GATE_REQUIRED_TOOLS). */
  extraT0?: readonly string[]
}

export type Tiers = {
  t0: string[]
  t1: string[]
  t2: string[]
  stats: ToolStat[]
}

/**
 * Derive tiers from usage rows.
 * T0 = data head (session-share ≥ a  OR  inside the cumulative-calls ≥ b prefix) ∪ gate-required.
 * T2 = long tail (below both t2 thresholds), never overlapping T0.
 * T1 = everything else (the router's actual decision space).
 * Gate-required tools land in T0 even with zero usage rows.
 */
export function computeTiers(rows: readonly UsageRow[], opts: TierOptions = {}): Tiers {
  const a = opts.t0SessionShare ?? 0.5
  const b = opts.t0CumulativeCalls ?? 0.8
  const t2s = opts.t2SessionShare ?? 0.05
  const t2c = opts.t2CallShare ?? 0.01
  const stats = usageHistogram(rows)

  const t0 = new Set<string>([...GATE_REQUIRED_TOOLS, ...(opts.extraT0 ?? [])])
  // rule (b): walk the call-sorted histogram until the cumulative share reaches the threshold;
  // every tool inside that prefix is head. The tool that CROSSES the threshold is included.
  let cum = 0
  for (const s of stats) {
    const inCumHead = cum < b
    cum += s.callShare
    if (s.sessionShare >= a || inCumHead) t0.add(s.tool)
    // once cum ≥ b, later tools only qualify via rule (a)
  }

  const t1: string[] = []
  const t2: string[] = []
  for (const s of stats) {
    if (t0.has(s.tool)) continue
    if (s.sessionShare < t2s && s.callShare < t2c) t2.push(s.tool)
    else t1.push(s.tool)
  }
  return { t0: [...t0].sort(), t1: t1.sort(), t2: t2.sort(), stats }
}

/** Imported (external-import format) tool names → native ids. Unknown names return null (report,
 *  never guess) — imported history is a SECONDARY signal, reported separately (§7). */
const IMPORT_NAME_MAP: Record<string, string> = {
  Bash: "bash",
  Edit: "edit",
  MultiEdit: "multiedit",
  Write: "write",
  Read: "read",
  Grep: "grep",
  Glob: "glob",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  NotebookEdit: "notebook-edit",
  TodoWrite: "todowrite",
  Task: "actor",
  Agent: "actor",
}

export function mapImportedName(name: string): string | null {
  return IMPORT_NAME_MAP[name] ?? null
}

/** Human-readable report block for the audit script. */
export function renderTiers(t: Tiers, topN = 15): string {
  const head = t.stats
    .slice(0, topN)
    .map(
      (s) =>
        `  ${s.tool.padEnd(28)} calls=${String(s.calls).padStart(6)} (${(s.callShare * 100).toFixed(1)}%)  sessions=${String(s.sessions).padStart(4)} (${(s.sessionShare * 100).toFixed(1)}%)`,
    )
    .join("\n")
  return [
    `TOP-${Math.min(topN, t.stats.length)} by calls:`,
    head,
    ``,
    `T0 (resident, ${t.t0.length}): ${t.t0.join(", ")}`,
    `T1 (routed, ${t.t1.length}): ${t.t1.join(", ")}`,
    `T2 (deferred, ${t.t2.length}): ${t.t2.join(", ")}`,
  ].join("\n")
}
