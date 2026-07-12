// FABULA cross-model witness — pure core (no IO). An INDEPENDENT model of a DIFFERENT architecture
// audits the diff a local model just wrote: it is an adversarial second reader, not the author quizzing
// itself (that is change-quiz). A "confirmed" witness is recorded as a companion attestation next to the
// receipt — the receipt file itself is never modified. The plugin (fabula-witness.ts) does the git/net/fs.

export type WitnessTarget = { providerId: string; model: string; baseURL: string; apiKeyRef?: string }

// The review prompt. The witness is told the code was written by a DIFFERENT model and must try to
// break it. The first line is a machine-parseable verdict so the harness never guesses the outcome.
export function witnessPrompt(diff: string, task?: string): { role: string; content: string }[] {
  const system =
    "You are an INDEPENDENT code reviewer. The unified diff below was written by a DIFFERENT AI model. " +
    "Your job is to catch its mistakes, not to be agreeable. Decide whether the change correctly and " +
    "safely accomplishes its goal WITHOUT introducing a bug or breaking existing behavior. Be adversarial: " +
    "actively look for the flaw, the missed edge case, the broken invariant. " +
    "Answer with EXACTLY this shape:\n" +
    "First line: `VERDICT: CONFIRMED` (the change is correct and safe) or `VERDICT: DISPUTED` (there is a real problem).\n" +
    "Then 2-4 lines: the specific reason — name the concrete risk if DISPUTED, or why it holds if CONFIRMED."
  const user = (task ? `Task the change claims to accomplish:\n${task}\n\n` : "") + "Unified diff to review:\n\n```diff\n" + diff + "\n```"
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

export function parseWitness(text: string): { verdict: "confirmed" | "disputed" | "unclear"; detail: string } {
  const t = (text || "").trim()
  const head = t.split("\n").slice(0, 3).join(" ").toLowerCase()
  const detail = t.replace(/^\s*verdict:\s*(confirmed|disputed)\s*/i, "").trim().slice(0, 800)
  if (/verdict:\s*disputed|\bdisputed\b/.test(head)) return { verdict: "disputed", detail }
  if (/verdict:\s*confirmed|\bconfirmed\b/.test(head)) return { verdict: "confirmed", detail }
  return { verdict: "unclear", detail: t.slice(0, 800) }
}

// Explicit witness target from env (FABULA_WITNESS_MODEL + FABULA_WITNESS_URL). Returns null when not
// fully configured, so the plugin can fall back to a cloud provider already in the engine config.
export function witnessTargetFromEnv(env: Record<string, string | undefined>): WitnessTarget | null {
  const model = env.FABULA_WITNESS_MODEL
  const baseURL = env.FABULA_WITNESS_URL
  if (!model || !baseURL) return null
  return { providerId: env.FABULA_WITNESS_PROVIDER || "witness", model, baseURL, apiKeyRef: env.FABULA_WITNESS_API_KEY }
}

// Guard against a fake "second opinion": a witness whose model id matches the author is not independent.
export function isIndependent(target: WitnessTarget, authorModelId: string | undefined): boolean {
  if (!authorModelId) return true
  return target.model.toLowerCase() !== authorModelId.toLowerCase()
}

export type WitnessEntry = {
  model: string
  provider: string
  verdict: "confirmed" | "disputed" | "unclear"
  method: "diff-review"
  at: number
}

export function witnessEntry(target: WitnessTarget, verdict: WitnessEntry["verdict"], at: number): WitnessEntry {
  return { model: target.model, provider: target.providerId, verdict, method: "diff-review", at }
}

// Companion attestation record kept next to the receipt (never inside it).
export type WitnessRecord = { diffSha: string; task?: string; witnesses: WitnessEntry[] }

// Upsert by (model, method): a re-run by the same witness replaces its prior verdict, doesn't stack.
// Defensive: a malformed witnesses.json (or any non-array input) normalizes to [] instead of throwing.
export function upsertWitness(entries: WitnessEntry[], next: WitnessEntry): WitnessEntry[] {
  const list = Array.isArray(entries) ? entries : []
  const rest = list.filter((e) => !(e.model === next.model && e.method === next.method))
  return [...rest, next]
}

// A change is independently attested when at least one DISTINCT model returned "confirmed" and none disputed.
// Defensive: a non-array input (malformed state, or a misuse) is treated as "no attestation", never a crash.
export function attested(entries: WitnessEntry[]): boolean {
  const list = Array.isArray(entries) ? entries : []
  if (list.some((e) => e.verdict === "disputed")) return false
  return new Set(list.filter((e) => e.verdict === "confirmed").map((e) => e.model)).size >= 1
}
