// FABULA cross-model witness — pure core (no IO). An INDEPENDENT model of a DIFFERENT family
// audits the diff the socketed model just wrote: it is an adversarial second reader, not the author
// quizzing itself (that is change-quiz). Independence is enforced at the model-FAMILY level (see
// modelFamily below), not by comparing id strings. A "confirmed" witness is recorded as a companion
// attestation next to the receipt — the receipt file itself is never modified. The plugin
// (fabula-witness.ts) does the git/net/fs.

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
  // An EXPLICIT `VERDICT: X` line wins wherever it appears — a reasoning model in the socket puts
  // its thinking FIRST and the verdict at the END despite the "first line" instruction (measured
  // live 2026-07-16: head-only parsing read a clean trailing "VERDICT: CONFIRMED" as unclear).
  // The LAST explicit verdict is the model's final answer; text after it is the stated reason.
  const explicit = [...t.matchAll(/verdict:\s*(confirmed|disputed)\b/gi)]
  if (explicit.length > 0) {
    const last = explicit[explicit.length - 1]
    const verdict = last[1].toLowerCase() as "confirmed" | "disputed"
    const after = t.slice(last.index! + last[0].length).trim()
    return { verdict, detail: (after || t).slice(0, 800) }
  }
  // No explicit line: fall back to a bare-word scan of the head only (a bare word deep inside
  // reasoning is not a verdict).
  const head = t.split("\n").slice(0, 3).join(" ").toLowerCase()
  const detail = t.trim().slice(0, 800)
  if (/\bdisputed\b/.test(head)) return { verdict: "disputed", detail }
  if (/\bconfirmed\b/.test(head)) return { verdict: "confirmed", detail }
  return { verdict: "unclear", detail }
}

// Explicit witness target from env (FABULA_WITNESS_MODEL + FABULA_WITNESS_URL). Returns null when not
// fully configured, so the plugin can fall back to a cloud provider already in the engine config.
export function witnessTargetFromEnv(env: Record<string, string | undefined>): WitnessTarget | null {
  const model = env.FABULA_WITNESS_MODEL
  const baseURL = env.FABULA_WITNESS_URL
  if (!model || !baseURL) return null
  return { providerId: env.FABULA_WITNESS_PROVIDER || "witness", model, baseURL, apiKeyRef: env.FABULA_WITNESS_API_KEY }
}

// Model FAMILY detection — the independence unit. A witness from the same family (same vendor /
// training lineage: gpt-4o vs gpt-4o-mini, qwen3-35b vs qwen2-7b) shares blind spots with the
// author, so it is NOT an independent second reader even though the id string differs. Cross-family
// review catching correlated blind spots that same-family review misses is published prior art
// (arXiv:2604.19049); this makes the check deterministic instead of trusting an id mismatch.
// Token-level matching (ids split on /:@._- separators) so provider/region prefixes and quant
// suffixes never fool the check.
const MODEL_FAMILIES: [family: string, tokenPatterns: RegExp[]][] = [
  ["openai", [/^gpt\d*[a-z]*$/, /^o\d+$/, /^chatgpt$/, /^davinci$/, /^codex$/]],
  ["qwen", [/^qwen\d*$/, /^qwq$/, /^qvq$/]],
  ["deepseek", [/^deepseek$/]],
  ["glm", [/^glm\d*$/, /^chatglm\d*$/]],
  ["llama", [/^llama\d*$/, /^codellama$/]],
  ["google", [/^gemini$/, /^gemma\d*$/, /^palm\d*$/]],
  ["mistral", [/^mistral$/, /^mixtral$/, /^magistral$/, /^codestral$/, /^devstral$/, /^ministral$/]],
  ["moonshot", [/^kimi$/, /^moonshot$/]],
  ["xai", [/^grok\d*$/]],
  ["phi", [/^phi\d*$/]],
  ["cohere", [/^command$/, /^aya$/]],
  ["minimax", [/^minimax$/]],
  ["yi", [/^yi$/]],
  ["granite", [/^granite\d*$/]],
  ["nemotron", [/^nemotron$/]],
  ["rwkv", [/^rwkv\d*$/]],
  ["mamba", [/^mamba\d*$/]],
  ["jamba", [/^jamba\d*$/]],
]

// Generic descriptors that appear in ids across UNRELATED lines — never evidence of shared lineage.
const STEM_STOPWORDS = new Set([
  "chat", "coder", "code", "instruct", "base", "mini", "pro", "max", "flash", "turbo", "preview",
  "think", "thinking", "reasoner", "reasoning", "latest", "exp", "beta", "free", "fast", "lite",
  "nano", "small", "medium", "large", "plus", "ultra", "air", "vision", "distill", "moe", "dense",
  "mlx", "gguf", "awq", "gptq", "nvfp", "uncensored", "heretic", "nvidia", "meta", "models", "model",
])

/** Lineage stems of an id: alphabetic cores (≥3 chars, digits stripped: "qwen3"→"qwen") of its
 *  tokens, minus generic descriptors. "org/foo-coder-7b-instruct" → {"org","foo"}. */
function stemSet(modelId: string): Set<string> {
  const out = new Set<string>()
  for (const t of modelId.toLowerCase().split(/[\/:@._\-\s]+/)) {
    const core = (t.match(/^[a-z]+/) ?? [""])[0]
    if (core.length >= 3 && !STEM_STOPWORDS.has(core)) out.add(core)
  }
  return out
}

function tableFamily(modelId: string): string | undefined {
  const tokens = modelId.toLowerCase().split(/[\/:@._\-\s]+/).filter(Boolean)
  for (const [family, patterns] of MODEL_FAMILIES) {
    if (tokens.some((t) => patterns.some((p) => p.test(t)))) return family
  }
  return undefined
}

/** The model's family (vendor / training lineage): the table hit, else the first lineage stem,
 *  else the id itself. Pure; exported for tests and for the experiment harness. */
export function modelFamily(modelId: string): string {
  const known = tableFamily(modelId)
  if (known) return known
  const first = stemSet(modelId).values().next()
  return first.done ? modelId.toLowerCase() : first.value
}

// Guard against a fake "second opinion": a witness from the SAME FAMILY as the author is not
// independent — an id-string mismatch (gpt-4o vs gpt-4o-mini) is not independence. Deterministic and
// model-agnostic: any socket pairing is judged by lineage, never by which model it is. When BOTH ids
// are table-known the table decides; otherwise two ids sharing ANY lineage stem ("acme-7b" vs
// "acme-70b", or a vendor prefix naming the same line) are treated as one family (conservative).
export function isIndependent(target: WitnessTarget, authorModelId: string | undefined): boolean {
  if (!authorModelId) return true
  if (target.model.toLowerCase() === authorModelId.toLowerCase()) return false
  const a = tableFamily(target.model)
  const b = tableFamily(authorModelId)
  if (a && b) return a !== b
  const stems = stemSet(target.model)
  for (const s of stemSet(authorModelId)) if (stems.has(s)) return false
  return true
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
