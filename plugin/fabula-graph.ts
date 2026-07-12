// FABULA-LLM-5 — workflow-graph orchestrator (separate plugin per rule #4). Evolves mixture_of_agents
// into "PLAN → run ≤5 ISOLATED steps (each seeded ONLY by its deps' outputs + a SOUL role + STOP) → synthesize".
// Steps run in dependency LEVELS (parallel fan-out). An OPT-IN local→cloud router (FABULA_ROUTER=1) sends
// heavy steps to cloud. Local-first by default. `/no_think` keeps reasoning-model output clean. Pure in lib/.

import { tool } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import type { Plugin } from "@mimo-ai/plugin"
import { chatBody, extractText, resolveProviders } from "./lib/moa"
import { plannerPrompt, parseGraph, execLevels, stepPrompt, synthesizePrompt, verifyStep, cleanAnswer } from "./lib/graph"
import { routeStep, routerEnabled } from "./lib/router"
import { wrapUntrusted } from "./lib/untrusted"
import { scanThreats } from "./lib/threatscan"

const z = tool.schema
const BASE = (process.env.FABULA_GRAPH_URL || "http://localhost:1235/v1").replace(/\/+$/, "")
// Per-call timeout — generous by default: a local REASONING model (some uncensored builds ignore /no_think) can
// take >120s on a 700-token planner call. Env-tunable.
const TIMEOUT_MS = Number(process.env.FABULA_GRAPH_TIMEOUT_MS || 240000)

let cachedModel: string | null = null
async function localModel(): Promise<string> {
  if (process.env.FABULA_GRAPH_MODEL) return process.env.FABULA_GRAPH_MODEL
  if (cachedModel) return cachedModel
  try { cachedModel = String((await (await fetch(`${BASE}/models`)).json())?.data?.[0]?.id || "") } catch { cachedModel = "" }
  return cachedModel || ""
}

interface Prov { url: string; model: string; headers: Record<string, string>; name: string }
async function callProv(prov: Prov, prompt: string, maxTokens: number): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    // `/no_think` keeps a local reasoning model's answer in `content` (no chain-of-thought leak); cloud models ignore it.
    const r = await fetch(prov.url, { method: "POST", headers: { "Content-Type": "application/json", ...prov.headers }, body: JSON.stringify(chatBody(prov.model, prompt + "\n\n/no_think", maxTokens)), signal: ctrl.signal })
    if (!r.ok) throw new Error(`${prov.name} HTTP ${r.status}`)
    return extractText(await r.json())
  } finally { clearTimeout(timer) }
}

export const FabulaGraph: Plugin = async () => gate("graph", ({
  tool: {
    workflow_graph: tool({
      description: "Plan + run a small ISOLATED-STEP workflow for a complex task: a planner emits ≤5 subtasks; " +
        "each runs as a SEPARATE isolated agent seeded only by its dependencies' outputs (with a role + STOP); " +
        "independent steps run in parallel; then results are synthesized. Local-first (set FABULA_ROUTER=1 to let " +
        "heavy steps escalate to the cloud model). Use for multi-part tasks one pass handles poorly.",
      args: { task: z.string().describe("The complex task to decompose and run as an isolated-step workflow") },
      async execute(args: any) {
        const task = String(args.task || "").trim()
        if (!task) return "workflow_graph: empty task."
        const model = await localModel()
        if (!model) return "workflow_graph: no local model available (is LM Studio / :1235 up?)."
        const local: Prov = { url: `${BASE}/chat/completions`, model, headers: {}, name: "local" }
        const cloudP = resolveProviders(process.env).find((p) => p.cloud) || null
        const cloud: Prov | null = cloudP ? { url: cloudP.url, model: cloudP.model, headers: cloudP.headers, name: cloudP.name } : null
        const routerOn = routerEnabled()

        let raw: string
        try { raw = await callProv(local, plannerPrompt(task), 700) } catch (e: any) { return `workflow_graph: planner call failed — ${e.message}` }
        let { graph } = parseGraph(raw)
        if (!graph) graph = { steps: [{ id: "s1", role: "build", description: task, needs: [] }] } // graceful single-step fallback

        const outputs: Record<string, string> = {}
        const trace: string[] = []
        for (const level of execLevels(graph)) {
          await Promise.all(level.map(async (step) => {
            const deps: Record<string, string> = {}
            for (const n of step.needs) deps[n] = outputs[n] || ""
            const route = routeStep(step, { routerOn, cloudAvailable: !!cloud })
            const prov = route === "cloud" && cloud ? cloud : local
            let out: string
            try { out = await callProv(prov, stepPrompt(step, deps), 800) } catch (e: any) { out = `(step failed: ${e.message})` }
            const scan = scanThreats(out)
            if (scan.injection) out = wrapUntrusted(scan.cleaned, "workflow-step", undefined)
            outputs[step.id] = out
            const v = verifyStep(step, out)
            trace.push(`${step.id}(${step.role}, ${route}, needs:[${step.needs.join(",")}]): ${v.ok ? "✓" : "⚠ " + v.note} [${out.length}c]`)
          }))
        }

        let final: string
        try { final = cleanAnswer(await callProv(local, synthesizePrompt(task, graph.steps.map((s) => ({ id: s.id, role: s.role, text: outputs[s.id] || "" }))), 1200)) }
        catch (e: any) { final = `(synthesis failed: ${e.message})\n\n` + Object.values(outputs).join("\n\n") }
        return { output: `${final}\n\n---\nworkflow: ${graph.steps.length} step(s)${routerOn ? " · router ON" : ""}\n${trace.join("\n")}`, metadata: { steps: graph.steps.length, router: routerOn } }
      },
    }),
  },
}))
