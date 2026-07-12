// FABULA-LLM-5 — brainstorm-prototypes (Thariq Shihipar): when you know the taste but can't verbalize
// it, react to 3-5 wildly different throwaway variations instead of answering more questions. A tool
// (deliberate ideation — the agent/user invokes it; no auto-steer, since it's a pre-decision aid, not a
// gate). Pure logic in lib/brainstorm.ts; backed by lib/auxLLM.ts.

import type { Plugin } from "@mimo-ai/plugin"
import { tool } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import { callAux } from "./lib/auxLLM"
import { spawn } from "node:child_process"
import { refHuntTerms } from "./lib/unknowns"
import { brainstormPrompt, looksLikeBrainstorm } from "./lib/brainstorm"

const z = tool.schema

function grepRepo(dir: string, terms: string[], maxBytes = 4000): Promise<string> {
  return new Promise((resolve) => {
    if (!terms.length) return resolve("")
    const pat = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    const q = JSON.stringify(pat)
    const cmd = `(rg -n --no-heading -S -m 2 -g '!node_modules' -e ${q} . 2>/dev/null || grep -rnI -m 2 --exclude-dir=node_modules --exclude-dir=.git -E ${q} . 2>/dev/null) | head -40`
    const c = spawn("bash", ["-lc", cmd], { cwd: dir, env: process.env })
    let out = ""
    const t = setTimeout(() => { try { c.kill() } catch {} }, 6000)
    c.stdout.on("data", (d) => { if (out.length < maxBytes) out += d.toString() })
    c.on("close", () => { clearTimeout(t); resolve(out.slice(0, maxBytes)) })
    c.on("error", () => { clearTimeout(t); resolve("") })
  })
}

export const FabulaBrainstorm: Plugin = async () =>
  gate("brainstorm", {
    tool: {
      brainstorm_prototypes: tool({
        description:
          "When you know the desired taste/feel but can't state the requirement, generate 3-5 WILDLY " +
          "different throwaway design variations to react to — each labeled with the BELIEF it bets on " +
          "and its tradeoff. Reacting to concrete options surfaces the implicit preference faster than " +
          "more questions. Pass the `task`; the surrounding code is used as constraints. Use for " +
          "design/UX/API-shape choices before committing to one.",
        args: { task: z.string().describe("The design/feature you want variations for") },
        async execute(args: any, ctx: any) {
          const dir = ctx?.directory || process.cwd()
          const task = String(args?.task || "")
          const codeContext = await grepRepo(dir, refHuntTerms(task))
          try {
            const r = await callAux(brainstormPrompt(task, codeContext), { maxTokens: 3500, timeoutMs: 150000 })
            const ok = looksLikeBrainstorm(r.text)
            return { output: (ok ? "3-5 throwaway variations to react to (pick the bet that fits, then we build ONE):\n\n" : "") + r.text.trim(), metadata: { provider: r.provider, usable: ok } }
          } catch (e: any) {
            return `brainstorm_prototypes: aux model unreachable (${e?.message || e}). Sketch 3 divergent approaches yourself, each with the belief it bets on, and pick one.`
          }
        },
      }),
    },
  })
