// FABULA relay (§ guaranteed completion, spec 13) — the escalation rung where the CLOUD DOES THE WORK.
//
// escalate_to_cloud gives advice; relay_to_cloud goes one rung further: a stronger cloud model returns a
// COMPLETE unified diff for the stuck task. The harness writes it to .fabula/relay/patch.diff and steers
// the local model to apply it and RE-VERIFY. The cloud's patch is NOT trusted — it must pass the same
// verify/reproduce/change-quiz gates. That is what makes "the work will be done, and proven" honest:
// the ladder climbs until VERIFIED (or the budget is spent, or a single need-input question), and even
// cloud-authored work only counts once the gates are green.
//
// Every relay attempt is appended to .fabula/relay/attempts.json (a companion to the receipt — the
// receipt file itself is never modified, so this composes with fabula-receipt). Decision logic (ladder,
// budget, diff extraction) is the pure lib/relay.ts; this file is the cloud call + fs glue.

import { tool } from "@mimo-ai/plugin"
import type { Plugin } from "@mimo-ai/plugin"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { gate } from "./lib/manage"
import { pickCloudProvider, resolveApiKey, type CloudTarget } from "./lib/escalate"
import { budgetFromEnv, withinBudget, relayMessages, parseDiff, attemptEntry, ESCALATION_LADDER, type AttemptEntry } from "./lib/relay"

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

function resolveTarget(): { target: CloudTarget; apiKey: string | null } | { error: string } {
  // Explicit endpoint override wins: FABULA_RELAY_URL + FABULA_RELAY_MODEL point relay at any
  // OpenAI-compatible endpoint directly, bypassing the config's cloud heuristic.
  const url = process.env.FABULA_RELAY_URL
  const model = process.env.FABULA_RELAY_MODEL
  if (url && model) {
    const target: CloudTarget = { providerId: process.env.FABULA_RELAY_PROVIDER || "relay", baseURL: url, model, apiKeyRef: "" }
    return { target, apiKey: process.env.FABULA_RELAY_API_KEY || null }
  }
  const config = readConfig()
  if (!config) return { error: "no engine config (MIMOCODE_CONFIG / fabula.config.json), and no FABULA_RELAY_URL+MODEL" }
  const target = pickCloudProvider(config, process.env.FABULA_RELAY_PROVIDER || process.env.FABULA_ESCALATE_MODEL)
  if (!target) return { error: "no cloud provider configured to relay to (all providers are local) — add one, or set FABULA_RELAY_URL + FABULA_RELAY_MODEL" }
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
      body: JSON.stringify({ model: target.model, messages, max_tokens: 4096, temperature: 0.1, stream: false }),
      signal: ctl.signal,
    } as any)
    if (!r.ok) throw new Error(`relay provider ${target.providerId} returned HTTP ${r.status}`)
    const j: any = await r.json()
    const msg = j?.choices?.[0]?.message
    const text = (msg?.content || msg?.reasoning_content || "").toString().trim()
    if (!text) throw new Error(`relay provider ${target.providerId} returned an empty response`)
    return text
  } finally {
    clearTimeout(t)
  }
}

const RELAY_DIR = ".fabula/relay"
function readAttempts(dir: string): AttemptEntry[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, RELAY_DIR, "attempts.json"), "utf8"))
    return Array.isArray(j?.attempts) ? j.attempts : []
  } catch { return [] }
}
function appendAttempt(dir: string, entry: AttemptEntry): void {
  const abs = path.join(dir, RELAY_DIR)
  try {
    fs.mkdirSync(abs, { recursive: true })
    const attempts = [...readAttempts(dir), entry]
    fs.writeFileSync(path.join(abs, "attempts.json"), JSON.stringify({ updatedAt: entry.at, attempts }, null, 2), "utf8")
  } catch {}
}

const DIRECT_WORK = ESCALATION_LADDER.find((r) => r.strategy === "direct-work")!

export const FabulaRelay: Plugin = async (input: any) => {
  const dir: string = input?.directory || process.cwd()
  return gate("relay", {
    tool: {
      relay_to_cloud: tool({
        description:
          "Last escalation rung: when advice hasn't unstuck you, have a STRONGER CLOUD model write the fix itself. " +
          "It returns a complete unified diff, saved to .fabula/relay/patch.diff. The patch is NOT done — you must " +
          "apply it (`git apply .fabula/relay/patch.diff`) and re-run verify_done; only green gates make it count. " +
          "Budget-limited (FABULA_RELAY_MAX_ATTEMPTS/COST/TIME). Requires a cloud provider in the config.",
        args: {
          task: z.string().describe("The stuck task the cloud must solve as a patch."),
          tried: z.string().nullish().describe("Approaches already tried (so the cloud doesn't repeat them)."),
          context: z.string().nullish().describe("Relevant code, the failing test output, constraints."),
        },
        async execute(args: any) {
          const budget = budgetFromEnv(process.env as Record<string, string | undefined>)
          const priorAttempts = readAttempts(dir)
          const budgetCheck = withinBudget({ attempts: priorAttempts.length, costUsd: 0, elapsedMs: 0 }, budget)
          const n = priorAttempts.length + 1
          const at = Date.now()
          if (!budgetCheck.ok) {
            appendAttempt(dir, attemptEntry(n, DIRECT_WORK, "budget-exhausted", at, { reason: budgetCheck.reason }))
            return `relay_to_cloud: ${budgetCheck.reason}. Stopping the escalation ladder — this is an UNVERIFIED completion. Full attempt history: .fabula/relay/attempts.json. Raise FABULA_RELAY_MAX_ATTEMPTS to keep climbing.`
          }
          const res = resolveTarget()
          if ("error" in res) return `relay_to_cloud: ${res.error}`
          const { target, apiKey } = res
          const timeoutMs = Math.max(15000, parseInt(process.env.FABULA_RELAY_TIMEOUT_MS || "150000", 10) || 150000)
          let text: string
          try {
            text = await callCloud(target, apiKey, relayMessages(String(args?.task || ""), args?.tried ? String(args.tried) : undefined, args?.context ? String(args.context) : undefined), timeoutMs)
          } catch (e: any) {
            appendAttempt(dir, attemptEntry(n, DIRECT_WORK, "retrying", at, { model: target.model, reason: `unreachable: ${e?.message || e}` }))
            return `relay_to_cloud: could not reach ${target.providerId}/${target.model} — ${e?.message || e}. Keep solving locally; retry relay later.`
          }
          const parsed = parseDiff(text)
          if ("error" in parsed) {
            appendAttempt(dir, attemptEntry(n, DIRECT_WORK, "need-input", at, { model: target.model, reason: parsed.error }))
            return `relay_to_cloud: the cloud (${target.model}) did not return a patch — ${parsed.error}. This may need your input; consider rephrasing the task or asking the user one question.`
          }
          let patchPath = path.join(RELAY_DIR, "patch.diff")
          try {
            fs.mkdirSync(path.join(dir, RELAY_DIR), { recursive: true })
            fs.writeFileSync(path.join(dir, patchPath), parsed.diff, "utf8")
          } catch (e) {
            return `relay_to_cloud: got a patch from ${target.model} but could not write ${patchPath} — ${e instanceof Error ? e.message : String(e)}`
          }
          appendAttempt(dir, attemptEntry(n, DIRECT_WORK, "retrying", at, { model: target.model, reason: "cloud produced a patch; pending gate verification" }))
          return (
            `📥 CLOUD PATCH from ${target.providerId}/${target.model} written to ${patchPath} (attempt ${n}).\n` +
            `It is NOT done. Apply and prove it:\n` +
            `  git apply "${patchPath}"   # then re-run verify_done / your test suite\n` +
            `Only a green gate makes this count — the cloud's patch is verified like any change, not trusted.\n\n` +
            "```diff\n" + parsed.diff.slice(0, 4000) + (parsed.diff.length > 4000 ? "\n… (truncated; full patch on disk)" : "") + "\n```"
          )
        },
      }),
    },
  })
}
