// FABULA-LLM-5 — implementation-notes + pitch-packager (Thariq Shihipar), built active per RULE #9.
// DURING: a tool.execute.after hook AUTO-CAPTURES the edit trail (fires itself — nothing is lost even
// if the model never logs), plus `implementation_note` for the agent to record a deviation/decision.
// AFTER: `pitch_packager` bundles the diff + the notes trail into a DEMO-FIRST reviewer buy-in doc.
// Pure logic in lib/shipnotes.ts; backed by lib/auxLLM.ts. Toggle via plugin manager (id "shipnotes").

import type { Plugin } from "@mimo-ai/plugin"
import { tool } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import { callAux } from "./lib/auxLLM"
import { spawn } from "node:child_process"
import { newNotesLog, describeEdit, addNote, renderNotes, pitchPrompt, type NotesLog } from "./lib/shipnotes"
import { isSourceFile } from "./lib/unknowns"

const z = tool.schema

const logs = new Map<string, NotesLog>()
function logFor(sid: string): NotesLog {
  let l = logs.get(sid)
  if (!l) { l = newNotesLog(); logs.set(sid, l) }
  return l
}
function gitDiff(dir: string, maxBytes = 12000): Promise<string> {
  return new Promise((resolve) => {
    const c = spawn("bash", ["-lc", "git diff HEAD -- . 2>/dev/null || git diff 2>/dev/null"], { cwd: dir, env: process.env })
    let out = ""
    const t = setTimeout(() => { try { c.kill() } catch {} }, 6000)
    c.stdout.on("data", (d) => { if (out.length < maxBytes) out += d.toString() })
    c.on("close", () => { clearTimeout(t); resolve(out.slice(0, maxBytes)) })
    c.on("error", () => { clearTimeout(t); resolve("") })
  })
}

export const FabulaShipnotes: Plugin = async () =>
  gate("shipnotes", {
    tool: {
      implementation_note: tool({
        description:
          "Log a deviation or decision as you build — the thing a reviewer would ask 'why did you do X?' " +
          "(e.g. 'kept the old regex to not break 5.15', 'took the reversible option: feature-flagged'). " +
          "These get bundled by pitch_packager. Take the reversible option and keep going; just record why.",
        args: { note: z.string().describe("The deviation/decision, one line") },
        async execute(args: any, ctx: any) {
          const log = logFor(ctx?.sessionID || "?")
          addNote(log, "note", String(args?.note || ""))
          return `noted (${log.notes.filter((n) => n.kind === "note").length} decision(s), ${log.notes.length} entries logged this task).`
        },
      }),

      pitch_packager: tool({
        description:
          "When a change is ready for review, bundle it into a DEMO-FIRST buy-in doc: what it does + the " +
          "one step to see it, why, the notable decisions (from your logged notes + auto-captured edits), " +
          "and the risks. Reads your current `git diff HEAD`. Call after finishing a change you want a " +
          "human to approve.",
        args: { task: z.string().optional().describe("What the change was for (optional; improves the pitch)") },
        async execute(args: any, ctx: any) {
          const dir = ctx?.directory || process.cwd()
          const sid = ctx?.sessionID || "?"
          const diff = await gitDiff(dir)
          if (!diff.trim()) return "pitch_packager: no uncommitted change (git diff HEAD is empty) — nothing to package yet."
          const notes = renderNotes(logFor(sid))
          try {
            const r = await callAux(pitchPrompt(String(args?.task || ""), diff, notes), { maxTokens: 2500, timeoutMs: 150000 })
            return { output: r.text.trim(), metadata: { provider: r.provider } }
          } catch (e: any) {
            return `pitch_packager: aux model unreachable (${e?.message || e}). Notes trail:\n${notes}`
          }
        },
      }),
    },

    // reset the trail on a new user task
    "chat.message": async (input: any) => {
      try { const sid = input?.sessionID; if (!sid) return; if (logs.size > 500) logs.clear(); logs.set(sid, newNotesLog()) } catch {}
    },

    // auto-capture the edit trail (fires itself) — nothing is lost even if the model never logs a note
    "tool.execute.after": async (input: any, output: any) => {
      if (!output) return
      try {
        const t = input?.tool
        if (t === "create_file" || t === "str_replace" || t === "write" || t === "edit") {
          const fp = input?.args?.file_path ?? input?.args?.path ?? input?.args?.filePath ?? input?.args?.file
          if (typeof fp === "string" && isSourceFile(fp)) {
            const line = describeEdit(t, input?.args)
            if (line) addNote(logFor(input?.sessionID || "?"), "edit", line)
          }
        }
      } catch {}
    },
  })
