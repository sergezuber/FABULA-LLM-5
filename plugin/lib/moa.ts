// mixture_of_agents. Pure helpers (provider resolution, payloads, synthesis prompt,
// aggregation) — unit-testable; the HTTP fan-out lives in the tool. Leverages the user's multi-provider
// setup: local Qwen (LM Studio) + NVIDIA (+ any OpenAI-compatible endpoint via FABULA_MOA_ENDPOINTS).

export interface MoaProvider {
  name: string
  url: string                       // OpenAI-compatible /chat/completions
  model: string                     // "" → resolve at runtime (e.g. LM Studio first loaded)
  headers: Record<string, string>
  cloud: boolean                    // cloud = candidate aggregator
}

/** Build the provider fan from env. FABULA_MOA_ENDPOINTS (JSON array) overrides the defaults. */
export function resolveProviders(env: Record<string, string | undefined>): MoaProvider[] {
  if (env.FABULA_MOA_ENDPOINTS) {
    try {
      const arr = JSON.parse(env.FABULA_MOA_ENDPOINTS)
      if (Array.isArray(arr) && arr.length) return arr.map((p: any) => ({
        name: String(p.name || "custom"), url: String(p.url), model: String(p.model || ""),
        headers: p.key ? { Authorization: `Bearer ${p.key}` } : (p.headers || {}), cloud: !!p.cloud,
      }))
    } catch { /* fall through to defaults */ }
  }
  const out: MoaProvider[] = []
  const lmUrl = env.LMSTUDIO_URL || "http://localhost:1234/v1"
  out.push({ name: "local-qwen", url: `${lmUrl}/chat/completions`, model: "", headers: {}, cloud: false })
  if (env.NVIDIA_API_KEY) {
    const h = { Authorization: `Bearer ${env.NVIDIA_API_KEY}` }
    out.push({ name: "nvidia-glm", url: "https://integrate.api.nvidia.com/v1/chat/completions", model: "z-ai/glm-5.1", headers: h, cloud: true })
    out.push({ name: "nvidia-deepseek", url: "https://integrate.api.nvidia.com/v1/chat/completions", model: "deepseek-ai/deepseek-v4-flash", headers: h, cloud: true })
  }
  if (env.ZHIPU_API_KEY) out.push({
    name: "zai-glm", url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
    model: env.ZAI_MOA_MODEL || "glm-4.7", headers: { Authorization: `Bearer ${env.ZHIPU_API_KEY}` }, cloud: true,
  })
  return out
}

export function chatBody(model: string, prompt: string, maxTokens = 1024): any {
  return { model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.4, stream: false }
}

/** Extract assistant text from an OpenAI-compatible response object. Falls back to `reasoning_content` —
 *  local reasoning models (Qwen3.x) leave `content` empty and put the answer there on a plain chat call
 *  (the :1235 adapter only moves reasoning→content for structured/generateObject calls, not plain chat). */
export function extractText(json: any): string {
  const m = json?.choices?.[0]?.message
  return String(m?.content || m?.reasoning_content || json?.choices?.[0]?.text || "").trim()
}

export interface Candidate { name: string; text: string }

/** Build the synthesis prompt for the aggregator model. */
export function synthesisPrompt(question: string, candidates: Candidate[]): string {
  const blocks = candidates.map((c, i) => `### Candidate ${i + 1} (${c.name})\n${c.text}`).join("\n\n")
  return [
    "You are aggregating answers from several AI models into the single best response for the user.",
    "Judge the candidates on correctness and completeness; resolve disagreements by reasoning, not voting.",
    "Do NOT mention the candidates, models, or that any aggregation happened — just give the final answer.",
    "",
    `## User question\n${question}`,
    "",
    `## Candidate answers\n${blocks}`,
    "",
    "## Your synthesized answer",
  ].join("\n")
}

/** Pick the aggregator from the providers that actually answered (prefer a cloud model). */
export function pickAggregator(providers: MoaProvider[], answered: Set<string>): MoaProvider | null {
  const live = providers.filter((p) => answered.has(p.name))
  return live.find((p) => p.cloud) || live[0] || null
}
