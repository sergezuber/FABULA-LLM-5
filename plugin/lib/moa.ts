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

/** RULE #18: tests run against the LOCAL model only. A KEY-triggered CLOUD endpoint must never be emitted
 *  from a test runner unless a run explicitly opts in (FABULA_TEST_ALLOW_CLOUD) — otherwise `bun test`
 *  auto-loading .env silently points a cheap-aux/aggregator call at a paid cloud provider (real outbound
 *  call + the key in test output). Local endpoints (:1235) stay the test target; an explicitly NAMED
 *  endpoint (LMSTUDIO_URL / FABULA_AUX_URL) is a deliberate decision and is honored by its own call site —
 *  a bare key is not an endpoint decision. Single definition, imported by auxLLM.ts so the rule can't drift. */
export function cloudEndpointsAllowed(env: Record<string, string | undefined>): boolean {
  const underTest = env.NODE_ENV === "test" || !!env.BUN_TEST || !!env.FABULA_TEST
  return !underTest || !!env.FABULA_TEST_ALLOW_CLOUD
}

/** The ONE definition of where a local INFERENCE call goes. :1235 is the adapter; :1234 is the serving
 *  process itself.
 *
 *  MEASURED 2026-08-01: this default was `:1234` here and in multimodal.ts, and LMSTUDIO_URL is set
 *  NOWHERE (absent from .env, from app/FabulaApp.swift and from the running engine's environment), so in
 *  the owner's real install `mixture_of_agents` dialled the raw serving port. That silently skips every
 *  mechanism the adapter exists for — admission control, the idle and degeneration watchdogs, the
 *  max-token clamp, the reasoning→content move — and it does NOT fail loudly, because :1234 answers 200
 *  on a plain chat call. It only 400s on the structured form, which is why the same defect was found and
 *  fixed in auxLLM.ts alone in July while these two call sites kept their own copy of the rule.
 *
 *  Note the deliberate asymmetry: LM Studio's NATIVE metadata API (`/api/v0/models`, used by the window
 *  planner and the receipt) is not proxied by the adapter and is correctly read from :1234. Inference is
 *  the thing that must go through the adapter; a metadata GET is not inference. */
export function localInferenceBase(env: Record<string, string | undefined>): string {
  return (env.LMSTUDIO_URL || "").trim() || "http://localhost:1235/v1"
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
  const lmUrl = localInferenceBase(env)
  out.push({ name: "local-qwen", url: `${lmUrl}/chat/completions`, model: "", headers: {}, cloud: false })
  if (cloudEndpointsAllowed(env)) {
    if (env.NVIDIA_API_KEY) {
      const h = { Authorization: `Bearer ${env.NVIDIA_API_KEY}` }
      out.push({ name: "nvidia-glm", url: "https://integrate.api.nvidia.com/v1/chat/completions", model: "z-ai/glm-5.1", headers: h, cloud: true })
      out.push({ name: "nvidia-deepseek", url: "https://integrate.api.nvidia.com/v1/chat/completions", model: "deepseek-ai/deepseek-v4-flash", headers: h, cloud: true })
    }
    if (env.ZHIPU_API_KEY) out.push({
      name: "zai-glm", url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
      model: env.ZAI_MOA_MODEL || "glm-4.7", headers: { Authorization: `Bearer ${env.ZHIPU_API_KEY}` }, cloud: true,
    })
  }
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
