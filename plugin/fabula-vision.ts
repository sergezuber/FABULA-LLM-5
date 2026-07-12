// FABULA-LLM-5 — universal vision capability layer (separate plugin per rule #4).
//
// Two jobs, both provider-agnostic (no hardcoded model names):
//   1. GATE  — when a fresh user turn attaches an image to a model that cannot receive images, strip the
//      image and inject a deterministic "this model can't see images — here's what to do" notice, so the
//      user never gets a silent/garbage reply. Fires ONLY on positive evidence of incapability (zero
//      false positives): the engine's own computed capability (cached from chat.params), the model's config
//      `modalities`, or a non-vlm LM Studio type.
//   2. sync_model_vision TOOL — detect each locally-served model's real type via LM Studio /api/v0/models
//      and rewrite its `modalities`/`attachment` in fabula.config.json (the engine config) so images flow to VLMs and never to
//      text-only models. Works for ANY local model the user loads, not a fixed list.
//
// See lib/vision.ts for the pure decision core; all the mechanism here was measured live on the engine.

import { tool } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import type { Plugin } from "@mimo-ai/plugin"
import { promises as fs, existsSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  imageFileParts, isImageMime, messageModel, messageParts, messageRole,
  parseLMStudioTypes, resolveCapability, shouldGate, visionNotice,
  isLocalBaseURL, lmStudioApiBase, desiredVisionConfig,
} from "./lib/vision"

const z = tool.schema
const TTL = 60_000

// ── caches (a plugin instance lives for the server's lifetime) ──
const capCache = new Map<string, boolean>()            // "providerID/modelID" → engine capabilities.input.image
const baseURLByProvider = new Map<string, string>()    // providerID → baseURL (from chat.params)
let lmTypeCache: { at: number; base: string; map: Map<string, string> } | null = null
let cfgCache: { at: number; data: any } | null = null

function configPath(): string {
  // The app passes the config path via MIMOCODE_CONFIG (engine env contract); fall back to the
  // engine's config dir with FABULA's renamed config file.
  if (process.env.MIMOCODE_CONFIG) return process.env.MIMOCODE_CONFIG
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  // Engine config dir is ~/.config/fabula (global.ts APP="fabula"); keep the legacy mimocode path only
  // as a fallback for older installs.
  const cand = [path.join(xdg, "fabula", "fabula.config.json"), path.join(xdg, "mimocode", "fabula.config.json")]
  return cand.find((p) => existsSync(p)) || cand[0]
}

async function readConfig(fresh = false): Promise<any> {
  if (!fresh && cfgCache && Date.now() - cfgCache.at < TTL) return cfgCache.data
  try {
    const data = JSON.parse(await fs.readFile(configPath(), "utf8"))
    cfgCache = { at: Date.now(), data }
    return data
  } catch { return null }
}

function configModalitiesInput(cfg: any, providerID?: string, modelID?: string): unknown {
  if (!cfg || !providerID || !modelID) return undefined
  return cfg?.provider?.[providerID]?.models?.[modelID]?.modalities?.input
}
function configBaseURL(cfg: any, providerID?: string): string | undefined {
  if (!cfg || !providerID) return undefined
  return cfg?.provider?.[providerID]?.options?.baseURL
}

async function lmStudioTypes(baseURL?: string, fresh = false): Promise<Map<string, string>> {
  if (!baseURL) return new Map()
  const base = lmStudioApiBase(baseURL)
  if (!fresh && lmTypeCache && lmTypeCache.base === base && Date.now() - lmTypeCache.at < TTL) return lmTypeCache.map
  try {
    const r = await fetch(base + "/api/v0/models", { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return lmTypeCache?.map ?? new Map()
    const map = parseLMStudioTypes(await r.json())
    lmTypeCache = { at: Date.now(), base, map }
    return map
  } catch { return lmTypeCache?.map ?? new Map() }
}

export const FabulaVision: Plugin = async () => gate("vision", ({
  // 1) Mirror the engine's own computed capability + provider base URL on every request (authoritative cache).
  "chat.params": async (a: any) => {
    try {
      const id = a?.model?.id
      const prov = a?.model?.providerID
      const img = a?.model?.capabilities?.input?.image
      if (prov && id && typeof img === "boolean") capCache.set(`${prov}/${id}`, img)
      const base = a?.provider?.options?.baseURL || a?.model?.api?.url
      if (prov && typeof base === "string") baseURLByProvider.set(prov, base)
    } catch {}
  },

  // 2) Gate: image attached on a fresh user turn to a model that can't see it → strip + deterministic notice.
  "experimental.chat.messages.transform": async (_a: any, b: any) => {
    try {
      const messages = b?.messages
      if (!Array.isArray(messages) || messages.length === 0) return
      const user = messages[messages.length - 1] // only act on a fresh user turn
      if (messageRole(user) !== "user") return
      const imgs = imageFileParts(messageParts(user))
      if (imgs.length === 0) return

      const { providerID, modelID } = messageModel(user)
      const cfg = await readConfig()
      const base = baseURLByProvider.get(providerID || "") || configBaseURL(cfg, providerID)
      const types = isLocalBaseURL(base) ? await lmStudioTypes(base) : new Map<string, string>()
      const lmType = modelID ? types.get(modelID) : undefined
      const cap = resolveCapability({
        engineCap: providerID && modelID ? capCache.get(`${providerID}/${modelID}`) : undefined,
        modalitiesInput: configModalitiesInput(cfg, providerID, modelID),
        lmStudioType: lmType,
      })
      if (!shouldGate(cap, true)) return // capable OR unknown → never block (zero false positives)

      const filenames = imgs.map((p: any) => p?.filename).filter(Boolean)
      const hardwareCapable = (lmType || "").toLowerCase() === "vlm"
      user.parts = messageParts(user).filter((p: any) => !(p?.type === "file" && isImageMime(p?.mime)))
      user.parts.push({ type: "text", text: visionNotice(modelID, filenames, hardwareCapable) })
    } catch {}
  },

  // 3) Universal sync tool — set modalities/attachment from each local model's REAL /api/v0 type.
  tool: {
    sync_model_vision: tool({
      description:
        "Detect which locally-served models (LM Studio) are vision-capable and update fabula.config.json so " +
        "images are sent only to models that can actually process them. Fixes false negatives (a VLM that " +
        "couldn't see images) AND false positives (a text model wrongly marked image-capable). Works for " +
        "ANY local model, not a hardcoded list. Restart the server (⌘⇧R) after applying.",
      args: {
        apply: z.boolean().nullish().describe("true = write changes to fabula.config.json; omitted/false = dry-run preview"),
      },
      async execute(args: any) {
        const cfg = await readConfig(true)
        if (!cfg?.provider) return "sync_model_vision: could not read fabula.config.json provider config."
        const lines: string[] = []
        let changed = 0
        let sawLocal = false
        for (const [, prov] of Object.entries<any>(cfg.provider)) {
          const base = prov?.options?.baseURL
          if (!isLocalBaseURL(base)) continue
          sawLocal = true
          const types = await lmStudioTypes(base, true) // explicit sync must never trust the TTL cache
          if (types.size === 0) { lines.push(`• ${base}: LM Studio not reachable — left unchanged.`); continue }
          prov.models = prov.models || {}
          const ids = new Set<string>([...Object.keys(prov.models), ...types.keys()])
          for (const id of ids) {
            const t = types.get(id)
            if (t === undefined) continue // configured but not currently served by LM Studio → leave as-is
            const desired = desiredVisionConfig(t)
            if (!desired) { lines.push(`• ${id} → embeddings (skipped)`); continue }
            const existing = prov.models[id] || {}
            const before = JSON.stringify({ m: existing.modalities, a: existing.attachment })
            const after = JSON.stringify({ m: desired.modalities, a: desired.attachment })
            const label = t === "vlm" ? "👁 image-capable" : "text-only"
            if (before !== after) {
              changed++
              lines.push(`• ${id} → ${label} ${prov.models[id] ? "(updated)" : "(added)"}`)
            } else {
              lines.push(`• ${id} → ${label} (already correct)`)
            }
            // preserve any unknown user fields; override only what we own
            prov.models[id] = {
              ...existing,
              name: existing.name || id,
              tools: existing.tools ?? true,
              attachment: desired.attachment,
              modalities: desired.modalities,
              // the engine refuses to start unless limit has BOTH context+output (project rule #5). `||`
              // would preserve a malformed/partial existing.limit (e.g. {context:200000}), so build a
              // guaranteed-complete limit, keeping any valid existing values.
              limit: {
                context: typeof existing.limit?.context === "number" && existing.limit.context > 0 ? existing.limit.context : 131072,
                output: typeof existing.limit?.output === "number" && existing.limit.output > 0 ? existing.limit.output : 8192,
              },
            }
          }
        }
        if (!sawLocal) return "sync_model_vision: no local (LM Studio) provider found in fabula.config.json."
        if (args?.apply) {
          await fs.writeFile(configPath(), JSON.stringify(cfg, null, 2) + "\n", "utf8")
          cfgCache = null
          return `Applied vision sync — ${changed} change(s). Restart the server (⌘⇧R) to take effect.\n\n${lines.join("\n")}`
        }
        return `Dry-run — ${changed} change(s) would be written. Re-run with apply:true to save.\n\n${lines.join("\n")}`
      },
    }),
  },
}))
