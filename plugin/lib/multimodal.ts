// Pure helpers for multimodal tools. Binary detection + vision endpoint resolution
// are pure/testable; the actual whisper/piper/VLM calls live in the plugin and degrade gracefully
// (return install guidance) when a dependency isn't present.

import { execFile } from "node:child_process"

/** Resolve the first available binary from candidates via `which`. A per-spawn timeout keeps a
 *  wedged lookup (loaded machine, network-mounted PATH) from hanging the promise forever — a
 *  candidate that can't be resolved in time is treated as absent. */
export function whichAny(cands: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let i = 0
    const next = () => {
      if (i >= cands.length) return resolve(null)
      const c = cands[i++]
      execFile("which", [c], { timeout: 3000 }, (err, out) => (!err && out.trim() ? resolve(out.trim()) : next()))
    }
    next()
  })
}

export interface VisionEndpoint { url: string; model: string; headers: Record<string, string> }

/** Resolve an OpenAI-compatible vision endpoint from env (FABULA_VISION_* or LM Studio default). */
export function resolveVision(env: Record<string, string | undefined>): VisionEndpoint | null {
  if (env.FABULA_VISION_URL && env.FABULA_VISION_MODEL) return {
    url: env.FABULA_VISION_URL, model: env.FABULA_VISION_MODEL,
    headers: env.FABULA_VISION_KEY ? { Authorization: `Bearer ${env.FABULA_VISION_KEY}` } : {},
  }
  // LM Studio with a VLM loaded (model id supplied via env to avoid guessing)
  if (env.LMSTUDIO_VLM_MODEL) return {
    url: `${env.LMSTUDIO_URL || "http://localhost:1234/v1"}/chat/completions`,
    model: env.LMSTUDIO_VLM_MODEL, headers: {},
  }
  return null
}

/** OpenAI-compatible vision chat body (image as data URL). Default is generous because local VL models
 *  are often REASONING models that spend tokens in reasoning_content before emitting the answer. */
export function visionBody(model: string, prompt: string, dataUrl: string, maxTokens = 2000): any {
  return {
    model, max_tokens: maxTokens, temperature: 0.2, stream: false,
    messages: [{ role: "user", content: [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: dataUrl } },
    ] }],
  }
}

/** Extract the answer from a vision response. Falls back to reasoning_content if the model (a reasoning
 *  model) ran out of tokens before emitting final content — so we never return an empty answer. */
export function extractVision(json: any): string {
  const msg = json?.choices?.[0]?.message || {}
  const content = (msg.content || "").trim()
  if (content) return content
  const reasoning = (msg.reasoning_content || msg.reasoning || "").trim()
  if (reasoning) return `[from model reasoning — increase max_tokens for a clean answer]\n${reasoning}`
  return ""
}

/** Candidate python interpreters that may have faster-whisper (env override → system python). */
export function whisperPythonCandidates(env: Record<string, string | undefined>): string[] {
  const c: string[] = []
  if (env.FABULA_WHISPER_PYTHON) c.push(env.FABULA_WHISPER_PYTHON)
  c.push("python3")
  return c.filter(Boolean)
}

/** Inline faster-whisper transcription script: argv = [audioPath, modelSize]. Prints transcript. */
export const FASTER_WHISPER_SCRIPT =
  "import sys\n" +
  "from faster_whisper import WhisperModel\n" +
  "m = WhisperModel(sys.argv[2], device='cpu', compute_type='int8')\n" +
  "segs, info = m.transcribe(sys.argv[1])\n" +
  "print(' '.join(s.text.strip() for s in segs))\n"

export function mimeFromPath(p: string): string {
  const e = (p.split(".").pop() || "").toLowerCase()
  return e === "png" ? "image/png" : e === "gif" ? "image/gif" : e === "webp" ? "image/webp" : "image/jpeg"
}
