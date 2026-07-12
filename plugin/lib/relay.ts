// FABULA relay — pure core of the escalation ladder (no IO). This is the piece that turns "cloud gives
// advice" into "cloud does the work": at the direct-work rung a stronger cloud model returns a COMPLETE
// unified diff, which the harness then runs through the SAME gates (verify → reproduce → change-quiz).
// The guarantee is honest precisely because the cloud's patch is NOT trusted — it must pass, like any change.
//
// The plugin (fabula-relay.ts) does the cloud call + fs + the attempts ledger. Everything decision-shaped
// — the ladder, the budget, the diff extraction — is here and unit-tested.

export type Budget = { maxAttempts: number; maxCostUsd?: number; maxTimeMs?: number }
export const DEFAULT_BUDGET: Budget = { maxAttempts: 8 }

// Read a budget from env (the user's ceiling; within it, the ladder keeps climbing toward VERIFIED).
export function budgetFromEnv(env: Record<string, string | undefined>): Budget {
  const n = (v: string | undefined, d: number) => { const x = parseInt(String(v ?? ""), 10); return Number.isFinite(x) && x > 0 ? x : d }
  const f = (v: string | undefined) => { const x = parseFloat(String(v ?? "")); return Number.isFinite(x) && x > 0 ? x : undefined }
  return {
    maxAttempts: n(env.FABULA_RELAY_MAX_ATTEMPTS, DEFAULT_BUDGET.maxAttempts),
    maxCostUsd: f(env.FABULA_RELAY_MAX_COST_USD),
    maxTimeMs: env.FABULA_RELAY_MAX_TIME_MIN ? n(env.FABULA_RELAY_MAX_TIME_MIN, 0) * 60_000 : undefined,
  }
}

export type LadderRung = { level: number; actor: "local" | "cloud" | "human"; strategy: string; label: string }
// NOT DONE is a transient state on this ladder, not a terminal — the run climbs until VERIFIED or the
// budget is spent or genuine ambiguity forces a single question (need-input), then resumes after the answer.
export const ESCALATION_LADDER: LadderRung[] = [
  { level: 0, actor: "local", strategy: "direct", label: "local model, direct approach" },
  { level: 1, actor: "local", strategy: "rewind-retry", label: "local, a different approach after rewind" },
  { level: 2, actor: "cloud", strategy: "advice", label: "cloud second opinion (advisory)" },
  { level: 3, actor: "local", strategy: "with-hint", label: "local applies the cloud hint" },
  { level: 4, actor: "cloud", strategy: "direct-work", label: "cloud writes the patch; the gates verify it" },
  { level: 5, actor: "human", strategy: "need-input", label: "pause: ask the user one clear question, then resume" },
]
export function nextRung(level: number): LadderRung | null {
  return ESCALATION_LADDER[level + 1] ?? null
}

export type Spend = { attempts: number; costUsd: number; elapsedMs: number }
export function withinBudget(spend: Spend, b: Budget): { ok: boolean; reason?: string } {
  if (spend.attempts >= b.maxAttempts) return { ok: false, reason: `attempt budget spent (${spend.attempts}/${b.maxAttempts})` }
  if (b.maxCostUsd != null && spend.costUsd >= b.maxCostUsd) return { ok: false, reason: `cost budget spent ($${spend.costUsd.toFixed(2)}/$${b.maxCostUsd.toFixed(2)})` }
  if (b.maxTimeMs != null && spend.elapsedMs >= b.maxTimeMs) return { ok: false, reason: `time budget spent (${Math.round(spend.elapsedMs / 1000)}s)` }
  return { ok: true }
}

// The prompt for the direct-work rung: a stronger model must return ONLY a git-apply-able unified diff.
export function relayMessages(task: string, tried?: string, context?: string): { role: string; content: string }[] {
  const system =
    "The model working in the agent's socket is stuck on the task below. You are a stronger model taking over. Produce a COMPLETE " +
    "fix as a UNIFIED DIFF and NOTHING else — the exact `git apply`-able patch (diff --git / --- / +++ / @@ hunks). " +
    "No prose, no explanation, no surrounding markdown fences. If you genuinely cannot produce a patch, output " +
    "exactly one line: `NO PATCH: <one-line reason>`. Your patch is NOT trusted — it will be run through the same " +
    "verify/reproduce/change-quiz gates, so make it correct and minimal."
  const parts = [`Task:\n${task}`]
  if (tried) parts.push(`Already tried (do not repeat):\n${tried}`)
  if (context) parts.push(`Relevant code / errors:\n${context}`)
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ]
}

// Extract a unified diff from a cloud response — tolerate ```diff fences and leading/trailing prose.
export function parseDiff(text: string): { diff: string } | { error: string } {
  const raw = (text || "").trim()
  if (/^NO PATCH:/i.test(raw)) return { error: raw.replace(/^NO PATCH:\s*/i, "").trim() || "cloud reported it could not produce a patch" }
  // prefer a fenced block that actually contains a diff
  const fence = raw.match(/```(?:diff|patch)?\s*\n([\s\S]*?)```/)
  const body = fence && /(^|\n)(diff --git |--- |@@ )/.test(fence[1]) ? fence[1] : raw
  const start = body.search(/(^|\n)(diff --git |--- )/)
  if (start === -1) return { error: "no unified diff found in the cloud response" }
  const diff = body.slice(start).replace(/^\n/, "").trimEnd() + "\n"
  if (!/@@ /.test(diff) && !(/(^|\n)--- /.test(diff) && /(^|\n)\+\+\+ /.test(diff)))
    return { error: "the extracted text is not a valid unified diff (no hunk header)" }
  return { diff }
}

export type AttemptEntry = {
  attempt: number
  actor: LadderRung["actor"]
  strategy: string
  model?: string
  result: "retrying" | "verified" | "need-input" | "budget-exhausted"
  reason?: string
  at: number
}
export function attemptEntry(n: number, rung: LadderRung, result: AttemptEntry["result"], at: number, extra?: { model?: string; reason?: string }): AttemptEntry {
  return { attempt: n, actor: rung.actor, strategy: rung.strategy, model: extra?.model, result, reason: extra?.reason, at }
}
