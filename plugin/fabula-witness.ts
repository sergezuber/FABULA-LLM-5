// FABULA cross-model witness (§ disrupt #3). After a local model writes a change, an INDEPENDENT model
// of a DIFFERENT architecture audits the diff adversarially and returns CONFIRMED / DISPUTED. A confirmed
// witness is recorded as a companion attestation next to the receipt (.fabula/receipts/witnesses.json) —
// the receipt file itself is never modified, so this composes with fabula-receipt without touching it.
//
// This is not the author quizzing itself (that is change-quiz). It is a second, orthogonal reviewer:
// no agent in the field uses a different-architecture model to cross-check its own work. Decision logic
// (prompt, verdict parse, independence, ledger) is the pure lib/witness.ts; this file is git/net/fs glue.

import { tool } from "@mimo-ai/plugin"
import type { Plugin } from "@mimo-ai/plugin"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { gate } from "./lib/manage"
import { pickCloudProvider, resolveApiKey, type CloudTarget } from "./lib/escalate"
import {
  witnessPrompt,
  parseWitness,
  witnessTargetFromEnv,
  isIndependent,
  witnessEntry,
  upsertWitness,
  type WitnessTarget,
} from "./lib/witness"

const z = tool.schema

function configPath(): string {
  if (process.env.MIMOCODE_CONFIG) return process.env.MIMOCODE_CONFIG
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  const cand = [path.join(xdg, "fabula", "fabula.config.json"), path.join(xdg, "mimocode", "fabula.config.json")]
  return cand.find((p) => fs.existsSync(p)) || cand[0]
}
function readConfig(): any {
  try { return JSON.parse(fs.readFileSync(configPath(), "utf8")) } catch { return null }
}

function gitDiff(dir: string): Promise<string> {
  return new Promise((resolve) => {
    const c = spawn("bash", ["-lc", "git diff HEAD -- . 2>/dev/null || git diff 2>/dev/null"], { cwd: dir, env: process.env })
    let out = ""
    c.stdout.on("data", (d) => (out += d))
    c.on("close", () => resolve(out))
    c.on("error", () => resolve(""))
  })
}

// Resolve a witness target: explicit FABULA_WITNESS_* env wins; otherwise a cloud provider from the
// engine config (must differ from the author/session model to count as an independent second opinion).
function resolveWitness(): { target: WitnessTarget; apiKey: string | null; author?: string } | { error: string } {
  const config = readConfig()
  const author = config?.model as string | undefined
  const envTarget = witnessTargetFromEnv(process.env as Record<string, string | undefined>)
  if (envTarget) {
    const apiKey = envTarget.apiKeyRef
      ? resolveApiKey(envTarget.apiKeyRef, { env: process.env as any, readFile: (p) => fs.readFileSync(p, "utf8") })
      : null
    return { target: envTarget, apiKey, author }
  }
  if (!config) return { error: "no engine config and no FABULA_WITNESS_MODEL/URL — cannot pick a witness model" }
  const cloud: CloudTarget | null = pickCloudProvider(config, process.env.FABULA_WITNESS_PROVIDER)
  if (!cloud) return { error: "no witness model configured — set FABULA_WITNESS_MODEL + FABULA_WITNESS_URL, or add a cloud provider to the config" }
  const target: WitnessTarget = { providerId: cloud.providerId, model: cloud.model, baseURL: cloud.baseURL, apiKeyRef: cloud.apiKeyRef }
  if (!isIndependent(target, author))
    return { error: `the only available witness (${target.model}) is the same model that wrote the code — set FABULA_WITNESS_MODEL to a DIFFERENT-architecture model for a real second opinion` }
  const apiKey = target.apiKeyRef ? resolveApiKey(target.apiKeyRef, { env: process.env as any, readFile: (p) => fs.readFileSync(p, "utf8") }) : null
  return { target, apiKey, author }
}

async function callWitness(target: WitnessTarget, apiKey: string | null, messages: any[], timeoutMs: number): Promise<string> {
  const url = target.baseURL.replace(/\/$/, "") + "/chat/completions"
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: target.model, messages, max_tokens: 800, temperature: 0.2, stream: false }),
      signal: ctl.signal,
    } as any)
    if (!r.ok) throw new Error(`witness provider ${target.providerId} returned HTTP ${r.status}`)
    const j: any = await r.json()
    const msg = j?.choices?.[0]?.message
    const text = (msg?.content || msg?.reasoning_content || "").toString().trim()
    if (!text) throw new Error(`witness provider ${target.providerId} returned an empty review`)
    return text
  } finally {
    clearTimeout(t)
  }
}

// Companion attestation next to the receipt. Tied to the exact diff by sha — a new change resets the list.
function recordWitness(dir: string, diffSha: string, task: string | undefined, entry: ReturnType<typeof witnessEntry>): number {
  const file = path.join(dir, ".fabula", "receipts", "witnesses.json")
  let rec: { diffSha?: string; task?: string; witnesses?: any[] } = {}
  try { rec = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}
  const prior = rec.diffSha === diffSha && Array.isArray(rec.witnesses) ? rec.witnesses : []
  const witnesses = upsertWitness(prior, entry)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ diffSha, task, updatedAt: entry.at, witnesses }, null, 2), "utf8")
  } catch {}
  return witnesses.filter((w: any) => w.verdict === "confirmed").length
}

export const FabulaWitness: Plugin = async (input: any) => {
  const dir: string = input?.directory || process.cwd()
  return gate("witness", {
    tool: {
      witness_diff: tool({
        description:
          "Get an INDEPENDENT second-architecture model to adversarially review your current diff before you " +
          "claim done. It returns CONFIRMED (the change is correct + safe) or DISPUTED (a real problem — with the " +
          "reason). A confirmed witness is recorded next to the receipt (.fabula/receipts/witnesses.json) as a " +
          "second, independent attestation. Needs FABULA_WITNESS_MODEL+URL or a cloud provider in the config.",
        args: {
          task: z.string().nullish().describe("What the change is supposed to accomplish (helps the reviewer judge correctness)."),
        },
        async execute(args: any) {
          const diff = await gitDiff(dir)
          if (!diff.trim()) return "witness_diff: no uncommitted change to review (git diff HEAD is empty)."
          const res = resolveWitness()
          if ("error" in res) return `witness_diff: ${res.error}`
          const { target, apiKey } = res
          const timeoutMs = Math.max(10000, parseInt(process.env.FABULA_WITNESS_TIMEOUT_MS || "120000", 10) || 120000)
          let review: string
          try {
            review = await callWitness(target, apiKey, witnessPrompt(diff, args?.task ? String(args.task) : undefined), timeoutMs)
          } catch (e: any) {
            return `witness_diff: could not reach witness ${target.providerId}/${target.model} — ${e?.message || e}. Proceed, but this change has no independent witness.`
          }
          const { verdict, detail } = parseWitness(review)
          const at = Date.now()
          const diffSha = createHash("sha256").update(diff, "utf8").digest("hex")
          const confirmedCount = recordWitness(dir, diffSha, args?.task ? String(args.task) : undefined, witnessEntry(target, verdict, at))
          const who = `${target.providerId}/${target.model}`
          if (verdict === "confirmed")
            return `✅ WITNESS CONFIRMED by ${who} (independent, different architecture) — recorded next to the receipt (${confirmedCount} confirming witness${confirmedCount === 1 ? "" : "es"}).\n\n${detail}`
          if (verdict === "disputed")
            return `❌ WITNESS DISPUTED by ${who}: the change has a problem. Do NOT claim done — fix it or use escalate_to_cloud.\n\n${detail}`
          return `⚠ WITNESS INCONCLUSIVE from ${who} — no clear verdict. Treat as unconfirmed; re-review the diff yourself.\n\n${detail}`
        },
      }),
    },
    // On mint, a note in the receipt-adjacent flow is out of scope (we never touch fabula-receipt);
    // the companion witnesses.json is the durable attestation, tied to the exact diff sha.
  })
}

// NOTE: this file must export EXACTLY ONE `Fabula*` factory and nothing else. The engine plugin loader
// invokes EVERY export of a plugin file as a plugin (getLegacyPlugins → Object.values(mod) → applyPlugin
// calls each with the plugin input). A stray helper re-export (previously `export { attested }`) was
// therefore called as `attested(pluginInput)` → `entries.some is not a function` → the whole plugin
// failed to load. Import shared helpers from ./lib/witness directly where you need them — never re-export.
