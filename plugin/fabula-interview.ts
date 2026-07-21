// FABULA-LLM-5 — interview-me: surface the ONE architecture-changing question only the human can
// answer (Thariq Shihipar), built ACTIVE per RULE #9. A tool `interview_me` triages a task's unknowns
// into code-answerable (resolve by reading) vs human-only (a real decision) grounded in the real code,
// and an auto-nudge that FIRES ITSELF: when a new user task reads as underspecified for its area, the
// harness appends a nudge to that turn so the agent runs the triage before guessing — instead of
// hoping it notices. Pure logic in lib/interview.ts; kill-switch FABULA_INTERVIEW_NUDGE=0.

import type { Plugin } from "@mimo-ai/plugin"
import { tool } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import { callAux } from "./lib/auxLLM"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { refHuntTerms } from "./lib/unknowns"
import { triagePrompt, parseTriage, looksUnderspecified, INTERVIEW_NUDGE } from "./lib/interview"

const z = tool.schema

function grepRepo(dir: string, terms: string[], maxBytes = 6000): Promise<string> {
  return new Promise((resolve) => {
    if (!terms.length) return resolve("")
    const pat = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    const q = JSON.stringify(pat)
    const cmd = `(rg -n --no-heading -S -m 3 -g '!node_modules' -e ${q} . 2>/dev/null || grep -rnI -m 3 --exclude-dir=node_modules --exclude-dir=.git -E ${q} . 2>/dev/null) | head -60`
    const c = spawn("bash", ["-lc", cmd], { cwd: dir, env: process.env })
    let out = ""
    const t = setTimeout(() => { try { c.kill() } catch {} }, 8000)
    c.stdout.on("data", (d) => { if (out.length < maxBytes) out += d.toString() })
    c.on("close", () => { clearTimeout(t); resolve(out.slice(0, maxBytes)) })
    c.on("error", () => { clearTimeout(t); resolve("") })
  })
}
async function readPaths(dir: string, paths: string[], maxBytes = 6000): Promise<string> {
  const parts: string[] = []
  for (const rel of paths.slice(0, 6)) {
    try {
      const abs = path.isAbsolute(rel) ? rel : path.join(dir, rel)
      parts.push(`--- ${rel} ---\n${(await fs.readFile(abs, "utf8")).slice(0, 2500)}`)
    } catch {}
    if (parts.join("\n").length > maxBytes) break
  }
  return parts.join("\n\n").slice(0, maxBytes)
}
/** Extract plain text from a message content that may be a string or an array of parts. */
function messageText(content: any): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join(" ")
  return ""
}

const nudged = new Map<string, string>() // sessionID → last-nudged task text (avoid re-nudging same task)

export const FabulaInterview: Plugin = async () =>
  gate("interview", {
    tool: {
      interview_me: tool({
        description:
          "When a task is underspecified or you're new to the area, triage before implementing: this " +
          "separates what the CODEBASE can answer (resolve those by reading — e.g. reference_hunt) from " +
          "the ONE architecture-changing decision only the human can make, plus a safe default to proceed " +
          "on. Pass the `task`; optionally `paths` to focus on. Ask the human only the top question; never " +
          "ask what the code already answers.",
        args: {
          task: z.string().describe("The task/ask you are about to implement"),
          paths: z.array(z.string()).optional().describe("Optional specific files to ground the triage in"),
        },
        async execute(args: any, ctx: any) {
          const dir = ctx?.directory || process.cwd()
          const task = String(args?.task || "")
          const paths = Array.isArray(args?.paths) ? args.paths.map(String) : []
          const codeContext = paths.length ? await readPaths(dir, paths) : await grepRepo(dir, refHuntTerms(task))
          try {
            const r = await callAux(triagePrompt(task, codeContext), { maxTokens: 3000, timeoutMs: 150000 })
            const t = parseTriage(r.text)
            const body = t.topQuestion
              ? `CODE-ANSWERABLE (resolve by reading, don't ask):\n${t.codeAnswerable || "- (none)"}\n\n` +
                `HUMAN-ONLY:\n${t.humanOnly || "- (none)"}\n\n` +
                `❓ ASK THE HUMAN (one question): ${t.topQuestion}\n` +
                `DEFAULT IF NO ANSWER: ${t.defaultAssumption || "(state your assumption explicitly)"}`
              : r.text.trim()
            return { output: body, metadata: { grounded: paths.length ? "paths" : "grep", provider: r.provider } }
          } catch (e: any) {
            return `interview_me: aux model unreachable (${e?.message || e}). List what the CODE can answer (resolve by reading) vs the ONE decision only the human can make, and state your assumption.`
          }
        },
      }),
    },

    // auto-nudge: fires itself when a new user task looks underspecified — appends the interview nudge
    // to that turn's user message so the agent triages before guessing (once per distinct task).
    "experimental.chat.messages.transform": async (input: any, output: any) => {
      try {
        // never steer the summarizer: a nudge planted into the COMPACTION build turns it into a task
        // executor (measured live on the ctxguard steer — same class)
        if (input?.compaction === true) return
        if (process.env.FABULA_INTERVIEW_NUDGE === "0") return
        const msgs = output?.messages
        if (!Array.isArray(msgs)) return
        let last: any = null
        for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "user") { last = msgs[i]; break }
        if (!last) return
        const text = messageText(last.content)
        if (!looksUnderspecified(text)) return
        const sid = input?.sessionID || "?"
        if (nudged.get(sid) === text) return // already nudged this exact task
        if (nudged.size > 500) nudged.clear()
        nudged.set(sid, text)
        if (typeof last.content === "string") last.content = last.content + INTERVIEW_NUDGE
        else if (Array.isArray(last.content)) last.content.push({ type: "text", text: INTERVIEW_NUDGE })
      } catch {}
    },
  })
