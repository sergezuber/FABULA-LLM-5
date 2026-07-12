// Cost ledger. Aggregate token/cost usage from the engine's message rows (pure; the tool reads
// message.data JSON which carries {cost, tokens:{total,input,output,...}, modelID, providerID}).

export interface UsageRow { cost?: number; tokens?: any; modelID?: string; providerID?: string }
export interface CostSummary {
  totalCost: number; totalTokens: number; calls: number
  byModel: Record<string, { cost: number; tokens: number; calls: number }>
}

function tokTotal(t: any): number {
  if (typeof t === "number") return t
  if (t && typeof t === "object") return Number(t.total) || ((Number(t.input) || 0) + (Number(t.output) || 0) + (Number(t.reasoning) || 0))
  return 0
}

export function aggregateCost(rows: UsageRow[]): CostSummary {
  const s: CostSummary = { totalCost: 0, totalTokens: 0, calls: 0, byModel: {} }
  for (const r of rows) {
    const tok = tokTotal(r.tokens)
    const cost = Number(r.cost) || 0
    if (!tok && !cost) continue
    const key = `${r.providerID || "?"}/${r.modelID || "?"}`
    const m = s.byModel[key] || (s.byModel[key] = { cost: 0, tokens: 0, calls: 0 })
    m.cost += cost; m.tokens += tok; m.calls += 1
    s.totalCost += cost; s.totalTokens += tok; s.calls += 1
  }
  return s
}

export function formatCostReport(s: CostSummary, scope: string): string {
  if (!s.calls) return `cost_report: no usage found for ${scope}.`
  const rows = Object.entries(s.byModel).sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([m, v]) => `  ${m}: ${v.tokens.toLocaleString()} tok, $${v.cost.toFixed(4)} (${v.calls} calls)`)
  return `Cost report (${scope}) — ${s.calls} model calls, ${s.totalTokens.toLocaleString()} tokens, $${s.totalCost.toFixed(4)} total:\n${rows.join("\n")}`
}
