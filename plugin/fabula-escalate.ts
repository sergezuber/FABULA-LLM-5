// FABULA-LLM-5 — mid-session local->cloud escalation (§5). When the local model is stuck, the harness
// gets a SECOND OPINION from a stronger CLOUD model on the SAME problem, using the SAME conversation
// context, then hands the answer back so the local model keeps driving. This is the supervision thesis
// (RULE #9) as an ACTIVE tool: the model is a swappable worker — when the small local one loops, a
// stronger one is consulted deterministically, not hoped for.
//
// The provider-disagreement normalization (tool-call-id shape, orphaned/aborted turns) is the pure
// lib/xprovider.ts core; the cloud target selection + key resolution + message build is lib/escalate.ts.
// This plugin is the glue: read the engine config, pick the cloud target, POST the transformed messages.

import { tool } from "@mimo-ai/plugin"
import type { Plugin } from "@mimo-ai/plugin"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { gate } from "./lib/manage"
import { pickCloudProvider, resolveApiKey, buildEscalationMessages, CloudTarget } from "./lib/escalate"
import { transformForProvider } from "./lib/xprovider"

const z = tool.schema

function configPath(): string {
  if (process.env.MIMOCODE_CONFIG) return process.env.MIMOCODE_CONFIG
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  // FABULA's renamed config lives in the engine config dir (fabula.config.json).
  const cand = [path.join(xdg, "fabula", "fabula.config.json"), path.join(xdg, "mimocode", "fabula.config.json")]
  return cand.find((p) => fs.existsSync(p)) || cand[0]
}

function readConfig(): any {
  try { return JSON.parse(fs.readFileSync(configPath(), "utf8")) } catch { return null }
}

function resolveTarget(): { target: CloudTarget; apiKey: string | null } | { error: string } {
  const config = readConfig()
  if (!config) return { error: "no engine config found (MIMOCODE_CONFIG / fabula.config.json)" }
  const target = pickCloudProvider(config, process.env.FABULA_ESCALATE_MODEL || process.env.FABULA_ESCALATE_PROVIDER)
  if (!target) return { error: "no cloud provider configured to escalate to (all providers are local)" }
  const apiKey = resolveApiKey(target.apiKeyRef, { env: process.env as any, readFile: (p) => fs.readFileSync(p, "utf8") })
  return { target, apiKey }
}

async function callCloud(target: CloudTarget, apiKey: string | null, messages: any[], timeoutMs: number): Promise<string> {
  const url = target.baseURL.replace(/\/$/, "") + "/chat/completions"
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: target.model, messages, max_tokens: 1024, temperature: 0.3, stream: false }),
      signal: ctl.signal,
    } as any)
    if (!r.ok) {
      const body = await r.text().catch(() => "")
      throw new Error(`cloud provider ${target.providerId} returned HTTP ${r.status}${body ? ": " + body.slice(0, 200) : ""}`)
    }
    const j: any = await r.json()
    const msg = j?.choices?.[0]?.message
    const text = (msg?.content || msg?.reasoning_content || "").toString().trim()
    if (!text) throw new Error(`cloud provider ${target.providerId} returned an empty answer`)
    return text
  } finally { clearTimeout(t) }
}

export const FabulaEscalate: Plugin = async (input: any) => gate("escalate", ({
  tool: {
    escalate_to_cloud: tool({
      description:
        "Get a SECOND OPINION from a stronger CLOUD model when you are stuck on this task (e.g. the same fix " +
        "keeps failing verification, or you can't find the root cause). Pass the problem, what you already " +
        "tried, and the relevant code/errors — a stronger model reviews it and returns a concrete root cause " +
        "and next step. Use this instead of looping on the same failing approach. Requires a cloud provider " +
        "in the config (otherwise it reports that none is set).",
      args: {
        task: z.string().describe("The problem to solve / what you're stuck on."),
        tried: z.string().nullish().describe("What you already tried and why it failed (so the cloud model doesn't repeat it)."),
        context: z.string().nullish().describe("Relevant code, error output, or constraints."),
      },
      async execute(args: any) {
        const res = resolveTarget()
        if ("error" in res) return `escalate_to_cloud: ${res.error}`
        const { target, apiKey } = res
        const messages = transformForProvider(
          buildEscalationMessages({ task: String(args.task || ""), tried: args.tried ? String(args.tried) : undefined, context: args.context ? String(args.context) : undefined }),
          { style: "strict" },
        )
        const timeoutMs = Math.max(10000, parseInt(process.env.FABULA_ESCALATE_TIMEOUT_MS || "90000", 10) || 90000)
        try {
          const answer = await callCloud(target, apiKey, messages, timeoutMs)
          return `💡 SECOND OPINION from ${target.providerId}/${target.model}:\n\n${answer}\n\n` +
            `— Consider this and adapt; you (the local model) remain in control of the change.`
        } catch (e: any) {
          return `escalate_to_cloud: could not reach ${target.providerId}/${target.model} — ${e?.message || e}. ` +
            `Continue solving locally; you can retry escalation later.`
        }
      },
    }),
  },
}))
