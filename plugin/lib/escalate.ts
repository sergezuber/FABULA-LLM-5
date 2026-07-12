// Mid-session local->cloud escalation — pure core (§5). When the local model is stuck, the harness
// gets a SECOND OPINION from a stronger cloud model on the SAME problem, then hands the answer back so
// the local model keeps driving. This module is the deterministic, testable part: pick a cloud target
// from the engine config, resolve its api key ({env:X}/{file:Y}/literal), and build the replay messages.
// The actual HTTP call + the cross-provider message normalization (lib/xprovider.ts) live in the plugin.

export interface CloudTarget {
  providerId: string
  baseURL: string
  apiKeyRef: string
  model: string
}

function isCloud(baseURL: string): boolean {
  if (!baseURL) return false
  return !/localhost|127\.0\.0\.1|0\.0\.0\.0|::1/.test(baseURL)
}

/**
 * Pick a cloud (non-local) provider from the engine config to escalate to.
 * Preference order: an explicit "provider/model" in `pref` → the provider named in `pref` →
 * the config default model's provider if it's cloud → the first cloud provider found.
 * Returns null if the config has no cloud provider (escalation simply doesn't fire).
 */
export function pickCloudProvider(config: any, pref?: string): CloudTarget | null {
  const providers = (config && config.provider) || {}
  const entries = Object.entries(providers) as [string, any][]

  const build = (pid: string, modelId?: string): CloudTarget | null => {
    const p = providers[pid]
    if (!p) return null
    const baseURL = (p.options && p.options.baseURL) || ""
    if (!isCloud(baseURL)) return null
    const models = Object.keys(p.models || {})
    const model = modelId && (p.models?.[modelId] || models.includes(modelId)) ? modelId : models[0]
    if (!model) return null
    return { providerId: pid, baseURL, apiKeyRef: String((p.options && p.options.apiKey) || ""), model }
  }

  // 1) explicit "provider/model"
  if (pref && pref.includes("/")) {
    const i = pref.indexOf("/")
    const t = build(pref.slice(0, i), pref.slice(i + 1))
    if (t) return t
  }
  // 2) provider id only
  if (pref && providers[pref]) {
    const t = build(pref)
    if (t) return t
  }
  // 3) config default model's provider, if cloud ("provider/model")
  if (typeof config?.model === "string" && config.model.includes("/")) {
    const i = config.model.indexOf("/")
    const t = build(config.model.slice(0, i), config.model.slice(i + 1))
    if (t) return t
  }
  // 4) first cloud provider
  for (const [pid] of entries) {
    const t = build(pid)
    if (t) return t
  }
  return null
}

/** Resolve an apiKey reference: {env:NAME} | {file:/path} | a literal string. */
export function resolveApiKey(ref: string, opts: { env: Record<string, string | undefined>; readFile: (p: string) => string }): string | null {
  if (!ref) return null
  const envM = ref.match(/^\{env:([^}]+)\}$/)
  if (envM) { const v = opts.env[envM[1]]; return v ? v.trim() : null }
  const fileM = ref.match(/^\{file:([^}]+)\}$/)
  if (fileM) { try { const v = opts.readFile(fileM[1]); return v ? v.trim() : null } catch { return null } }
  return ref.trim() || null
}

export interface EscalationInput {
  task: string          // the problem statement / what to solve
  tried?: string        // what the local model already tried and why it failed
  context?: string      // relevant code / errors / constraints
  system?: string       // optional system preamble override
}

/** Build the chat messages for the second-opinion request. */
export function buildEscalationMessages(input: EscalationInput): { role: string; content: string }[] {
  const system = input.system ||
    "You are a senior engineer giving a SECOND OPINION to another AI agent that is stuck on a coding task. " +
    "Be concrete and specific: identify the likely root cause and give a concrete, minimal fix or a different " +
    "approach it can act on immediately. Do not restate the problem; go straight to the actionable answer."
  const parts: string[] = [`TASK:\n${input.task.trim()}`]
  if (input.tried && input.tried.trim()) parts.push(`ALREADY TRIED (and it failed):\n${input.tried.trim()}`)
  if (input.context && input.context.trim()) parts.push(`RELEVANT CONTEXT (code / errors / constraints):\n${input.context.trim()}`)
  parts.push("Give the most likely root cause and a concrete next step or fix.")
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ]
}
