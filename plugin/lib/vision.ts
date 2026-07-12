// FABULA-LLM-5 — universal vision-capability detection + image-input gating (PURE core, unit-testable).
//
// Problem (measured live): the engine only forwards an attached image to a model when the model's computed
// `capabilities.input.image` is true. The engine derives that from the model's `modalities.input` (config) or
// the models.dev catalog. For unknown/local models that is FALSE by default, so:
//   • a genuinely vision-capable LOCAL model silently can't see pasted images (false negative), and
//   • a text-only model that receives an image returns an EMPTY/garbage reply instead of saying it can't.
//
// This module is the provider-agnostic DECISION core. All IO (LM Studio /api/v0 fetch, config read,
// per-model caches) lives in the `fabula-vision` plugin. Hard rule: emit the "model can't see images"
// notice ONLY on POSITIVE evidence of incapability — never a false positive that blocks a capable model.

export const IMAGE_MIME = /^image\//i

export function isImageMime(m?: unknown): boolean {
  return typeof m === "string" && IMAGE_MIME.test(m)
}

/** Parts of a message that carry an image (engine FilePart: {type:"file", mime, filename, url}). */
export function imageFileParts(parts: unknown): any[] {
  if (!Array.isArray(parts)) return []
  return parts.filter((p) => p && (p as any).type === "file" && isImageMime((p as any).mime))
}

/** Model identity of a transformed message ({info:{model:{providerID,modelID}}}) or a raw message. */
export function messageModel(msg: any): { providerID?: string; modelID?: string } {
  const m = msg?.info?.model ?? msg?.model ?? {}
  if (m?.modelID) return { providerID: m?.providerID, modelID: m?.modelID }
  // engine assistant messages carry providerID/modelID as direct info fields
  const i = msg?.info ?? {}
  if (i?.modelID) return { providerID: i?.providerID, modelID: i?.modelID }
  return { providerID: m?.providerID, modelID: m?.modelID }
}

export function messageRole(msg: any): string | undefined {
  return msg?.info?.role ?? msg?.role
}

export function messageParts(msg: any): any[] {
  return Array.isArray(msg?.parts) ? msg.parts : []
}

/** Parse LM Studio `GET /api/v0/models` → Map(modelId → type) where type ∈ {"vlm","llm","embeddings",…}. */
export function parseLMStudioTypes(json: any): Map<string, string> {
  const out = new Map<string, string>()
  const data = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : []
  for (const m of data) {
    if (m && typeof m.id === "string" && typeof m.type === "string") out.set(m.id, m.type)
  }
  return out
}

/** A localhost base URL is treated as an LM Studio-style local server we can introspect via /api/v0. */
export function isLocalBaseURL(url?: unknown): boolean {
  return typeof url === "string" && /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url)
}

/** Strip a trailing /v1 (or /v1/) so we can reach the LM Studio REST API at /api/v0/models. */
export function lmStudioApiBase(baseURL: string): string {
  return baseURL.replace(/\/+$/, "").replace(/\/v1$/i, "")
}

// Tri-state capability: true = can receive images, false = cannot, null = unknown (do NOT gate).
export type Capability = true | false | null

/**
 * Resolve whether the model WILL ACTUALLY RECEIVE images (what the engine will do), strictest no-false-positive
 * precedence — "will the engine send it", not "is the hardware capable":
 *   1. engineCap     — capabilities.input.image as the engine computed it (authoritative; cached from chat.params).
 *   2. modalities  — the model's config `modalities.input` (exactly what the engine reads to compute #1).
 *   3. lmStudioType is a NON-vlm chat type ("llm"/"embeddings"/…) → definitely text-only → false.
 *   else null      — unknown, INCLUDING a bare "vlm" with no config/engine confirmation: a VLM only actually
 *                    receives images once config enables it, and on a cold cache we can't be sure the engine will
 *                    send it — so we return null (caller must NOT gate) to guarantee zero false positives.
 *                    The sync_model_vision tool is what makes such a VLM resolve to true (via #2).
 */
export function resolveCapability(opts: {
  engineCap?: boolean | null
  modalitiesInput?: unknown
  lmStudioType?: string | null
}): Capability {
  if (typeof opts.engineCap === "boolean") return opts.engineCap
  if (Array.isArray(opts.modalitiesInput)) return opts.modalitiesInput.includes("image")
  // modalities.input is PRESENT but not an array (malformed config, e.g. a bare string "image").
  // the engine computes capability with `modalities?.input?.includes("image")` on the RAW config value —
  // and JS strings have .includes, so a string "image" makes the engine compute TRUE and it forwards the image.
  // Treat this as UNKNOWN → never gate, so we can't block a model that actually receives the image.
  if (opts.modalitiesInput != null) return null
  const t = typeof opts.lmStudioType === "string" ? opts.lmStudioType.trim().toLowerCase() : ""
  if (t && t !== "vlm") return false // llm / embeddings / any non-vlm chat type → cannot see images
  return null
}

/** Gate fires only when an image is present AND the model is KNOWN incapable (never on null/unknown). */
export function shouldGate(capability: Capability, hasImage: boolean): boolean {
  return hasImage && capability === false
}

/** Deterministic, model-agnostic notice injected in place of the stripped image part(s). */
export function visionNotice(
  modelID: string | undefined,
  filenames: string[],
  hardwareCapable: boolean,
): string {
  const m = modelID || "the selected model"
  const names = filenames.filter(Boolean).join(", ")
  const what = names ? `the image(s) you attached (${names})` : "the image you attached"
  const head = hardwareCapable
    ? `⚠️ The model «${m}» is vision-capable, but image input is not enabled for it in this FABULA config, so I did NOT receive ${what}.`
    : `⚠️ The model «${m}» is text-only and cannot process images, so I did NOT receive ${what}.`
  const opts = [
    "Switch to a vision-capable model",
    "give me the image as a file path and I'll read it with the vision_analyze tool",
  ]
  if (hardwareCapable) opts.push("enable vision for this model by running the sync_model_vision tool, then restart the server")
  return (
    `${head}\n\n` +
    `State this plainly to the user — do NOT pretend to see the picture. To work with the image, they can:\n` +
    opts.map((o, i) => `  ${i + 1}. ${o}${i === opts.length - 1 ? "." : ","}`).join("\n")
  )
}

/** Build the corrected modalities/attachment a model SHOULD have, given its LM Studio type. */
export function desiredVisionConfig(lmStudioType: string | undefined): {
  modalities: { input: string[]; output: string[] }
  attachment: boolean
} | null {
  const t = (lmStudioType || "").toLowerCase()
  if (t === "embeddings") return null // not a chat model — leave alone
  if (t === "vlm") return { modalities: { input: ["text", "image"], output: ["text"] }, attachment: true }
  // llm or unknown chat model → text-only (safe default; never claims image support it lacks)
  return { modalities: { input: ["text"], output: ["text"] }, attachment: false }
}
