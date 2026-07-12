// Aux-model chokepoint. Cheap subtasks (summarize/title/classify/compress) go to a small
// LOCAL model first (LM Studio Qwen), falling back to a cheap CLOUD model. Cost lever.
// Pure chain resolver (testable) + async callAux with fallback.

import { chatBody, extractText } from "./moa"

export interface AuxEndpoint { name: string; url: string; model: string; headers: Record<string, string> }

/** Ordered fallback chain: custom → local Qwen → cheap cloud. (Pure.) */
export function auxChain(env: Record<string, string | undefined>): AuxEndpoint[] {
  const chain: AuxEndpoint[] = []
  if (env.FABULA_AUX_URL) chain.push({
    name: "aux-custom", url: env.FABULA_AUX_URL, model: env.FABULA_AUX_MODEL || "",
    headers: env.FABULA_AUX_KEY ? { Authorization: `Bearer ${env.FABULA_AUX_KEY}` } : {},
  })
  const lm = env.LMSTUDIO_URL || "http://localhost:1234/v1"
  chain.push({ name: "local-qwen", url: `${lm}/chat/completions`, model: "", headers: {} })
  if (env.NVIDIA_API_KEY) chain.push({
    name: "nvidia-flash", url: "https://integrate.api.nvidia.com/v1/chat/completions",
    model: "deepseek-ai/deepseek-v4-flash", headers: { Authorization: `Bearer ${env.NVIDIA_API_KEY}` },
  })
  return chain
}

export interface AuxResult { text: string; provider: string }
type FetchLike = typeof fetch

/** Run a cheap LLM subtask, trying each endpoint in order until one answers. Throws if none reachable. */
export async function callAux(prompt: string, opts: { maxTokens?: number; fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<AuxResult> {
  const fetchImpl = opts.fetchImpl || fetch
  const maxTokens = opts.maxTokens ?? 512
  const timeoutMs = opts.timeoutMs ?? 60000
  for (const p of auxChain(process.env)) {
    try {
      let model = p.model
      if (!model) {
        // resolve a loaded model id (LM Studio / custom without explicit model)
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000)
        try {
          const m = await fetchImpl(p.url.replace(/\/chat\/completions$/, "/models"), { signal: ctl.signal } as any)
          const j: any = await m.json(); model = j?.data?.[0]?.id || ""
        } finally { clearTimeout(t) }
        if (!model) continue
      }
      // up to 2 attempts per endpoint — tolerate transient busy/timeout under load before failing over
      for (let attempt = 0; attempt < 2; attempt++) {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs)
        try {
          const r = await fetchImpl(p.url, {
            method: "POST", headers: { "Content-Type": "application/json", ...p.headers },
            body: JSON.stringify(chatBody(model, prompt, maxTokens)), signal: ctl.signal,
          } as any)
          if (r.ok) { const text = extractText(await r.json()); if (text) return { text, provider: p.name } }
        } catch { /* transient — retry once, then fail over */ } finally { clearTimeout(t) }
      }
    } catch { /* try next endpoint */ }
  }
  throw new Error("callAux: no aux model reachable")
}
