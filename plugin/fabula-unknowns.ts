// FABULA-LLM-5 — "finding your unknowns" as ACTIVE harness pieces (not passive skills). Per RULE #9,
// a local-first agent must not be trusted to self-invoke a skill; the harness fires the technique
// itself. Productizes Thariq Shihipar's pre-implementation techniques:
//   tool  reference_hunt   — read working source as the spec: grep the repo for analogous code, then
//                            digest its semantics (via the aux model) into a contract to implement to.
//   tool  surface_unknowns — blindspot pass: surface the unknown-unknowns for a task, grounded in the
//                            real surrounding code, and emit a refined, unambiguous task.
//   hook  reference-first gate — a tool.execute.after steer that FIRES ITSELF on the first SOURCE edit
//                            made without a prior reference/unknowns pass (mirrors the reproduce gate).
//
// Pure logic in lib/unknowns.ts; this file wires grep/read/callAux + hooks. Aux model = lib/auxLLM.ts.
// Toggle via the plugin manager (id "unknowns"); auto-steer kill-switch env FABULA_REFERENCE_FIRST=0.

import type { Plugin } from "@mimo-ai/plugin"
import { tool } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import { callAux } from "./lib/auxLLM"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import {
  refHuntTerms, refDigestPrompt, blindspotPrompt, parseBlindspot,
  newUnknownsState, shouldSteerReferenceFirst, REFERENCE_FIRST_STEER, type UnknownsState,
} from "./lib/unknowns"

const z = tool.schema

const states = new Map<string, UnknownsState>()
function stateFor(sid: string): UnknownsState {
  let s = states.get(sid)
  if (!s) { s = newUnknownsState(); states.set(sid, s) }
  return s
}
function editPath(args: any): string | null {
  const p = args?.file_path ?? args?.path ?? args?.filePath ?? args?.file
  return typeof p === "string" && p ? p : null
}

/** Grep the repo for terms → capped, code-focused snippets. ripgrep if present, else portable grep. */
function grepRepo(dir: string, terms: string[], maxBytes = 6000): Promise<string> {
  return new Promise((resolve) => {
    if (!terms.length) return resolve("")
    const pat = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    const q = JSON.stringify(pat)
    const cmd =
      `(rg -n --no-heading -S -m 3 -g '!node_modules' -g '!*.min.*' -g '!*.lock' -e ${q} . 2>/dev/null ` +
      `|| grep -rnI -m 3 --exclude-dir=node_modules --exclude-dir=.git -E ${q} . 2>/dev/null) | head -60`
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
      const text = await fs.readFile(abs, "utf8")
      parts.push(`--- ${rel} ---\n${text.slice(0, 2500)}`)
    } catch { /* skip unreadable */ }
    if (parts.join("\n").length > maxBytes) break
  }
  return parts.join("\n\n").slice(0, maxBytes)
}

export const FabulaUnknowns: Plugin = async () =>
  gate("unknowns", {
    tool: {
      // reference-hunt: find working code that already does something like the goal, digest its contract.
      reference_hunt: tool({
        description:
          "BEFORE reimplementing something, use existing working code as the spec. Give a `goal` (what " +
          "you're about to build); this greps the repo for analogous implementations and returns a " +
          "SEMANTICS SUMMARY (the contract to match) — inputs/outputs, control flow, edge cases, exact " +
          "error strings, invariants. Optionally pass a `pattern` to grep for directly. Call this when " +
          "you're in an unfamiliar area or porting behavior across files/languages.",
        args: {
          goal: z.string().describe("What you are about to implement / the behavior to find a reference for"),
          pattern: z.string().optional().describe("Optional explicit grep pattern (identifier/string); else derived from goal"),
        },
        async execute(args: any, ctx: any) {
          const dir = ctx?.directory || process.cwd()
          const terms = args?.pattern ? [String(args.pattern)] : refHuntTerms(String(args?.goal || ""))
          stateFor(ctx?.sessionID || "?").didReferencePass = true
          if (!terms.length) return "reference_hunt: no searchable terms in the goal — state your assumptions explicitly and proceed, or pass an explicit `pattern`."
          const snippets = await grepRepo(dir, terms)
          if (!snippets.trim())
            return `reference_hunt: no analogous code found in the repo for [${terms.join(", ")}]. There is no local reference to copy — decide the contract from the spec and STATE your assumptions before implementing.`
          try {
            const r = await callAux(refDigestPrompt(String(args?.goal || ""), snippets), { maxTokens: 4000, timeoutMs: 180000 })
            return { output: `Reference semantics for [${terms.join(", ")}] — implement to THIS contract:\n\n${r.text.trim()}`, metadata: { terms, provider: r.provider } }
          } catch (e: any) {
            return `reference_hunt: found references but the aux model was unreachable (${e?.message || e}). Raw matches:\n\n${snippets}`
          }
        },
      }),

      // surface-unknowns: blindspot pass grounded in the real code.
      surface_unknowns: tool({
        description:
          "BLINDSPOT PASS before implementing: surface the unknown-unknowns for a `task` in an unfamiliar " +
          "area — hidden conventions, existing helpers to reuse, invariants, edge/error contracts the task " +
          "doesn't state — grounded in the real code, then return a REFINED, unambiguous task. Pass `paths` " +
          "to focus on specific files, else it greps for the task's terms. Call this when the ask is " +
          "underspecified or you're new to the area.",
        args: {
          task: z.string().describe("The task/ask you are about to implement"),
          paths: z.array(z.string()).optional().describe("Optional specific files to ground the pass in"),
        },
        async execute(args: any, ctx: any) {
          const dir = ctx?.directory || process.cwd()
          const task = String(args?.task || "")
          stateFor(ctx?.sessionID || "?").didReferencePass = true
          const paths = Array.isArray(args?.paths) ? args.paths.map(String) : []
          const codeContext = paths.length ? await readPaths(dir, paths) : await grepRepo(dir, refHuntTerms(task))
          try {
            const r = await callAux(blindspotPrompt(task, codeContext), { maxTokens: 4000, timeoutMs: 180000 })
            const { unknowns, refined } = parseBlindspot(r.text)
            const body = refined
              ? `UNKNOWNS (close these before coding):\n${unknowns}\n\nREFINED TASK — implement THIS:\n${refined}`
              : r.text.trim()
            return { output: body, metadata: { grounded: paths.length ? "paths" : "grep", provider: r.provider } }
          } catch (e: any) {
            return `surface_unknowns: aux model unreachable (${e?.message || e}). Read the surrounding code yourself and list what the task doesn't state before implementing.`
          }
        },
      }),
    },

    // reset the reference-pass tracking on a new user turn (a fresh task)
    "chat.message": async (input: any) => {
      try {
        const sid = input?.sessionID
        if (!sid) return
        if (states.size > 500) states.clear()
        states.set(sid, newUnknownsState())
      } catch {}
    },

    // reference-first gate: fires ITSELF on the first source edit made with no prior reference/unknowns pass.
    "tool.execute.after": async (input: any, output: any) => {
      if (!output) return
      try {
        const sid = input?.sessionID || "?"
        const t = input?.tool
        if (t === "reference_hunt" || t === "surface_unknowns") { stateFor(sid).didReferencePass = true; return }
        if (process.env.FABULA_REFERENCE_FIRST === "0") return
        if (t === "create_file" || t === "str_replace" || t === "write" || t === "edit") {
          const fp = editPath(input?.args)
          const st = stateFor(sid)
          if (fp && shouldSteerReferenceFirst(st, fp) && typeof output.output === "string") {
            st.steered = true
            output.output = output.output + REFERENCE_FIRST_STEER
            if (output.metadata && typeof output.metadata === "object") output.metadata.referenceFirst = "steered"
          }
        }
      } catch {}
    },
  })
