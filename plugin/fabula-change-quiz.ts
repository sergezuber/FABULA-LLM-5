// FABULA-LLM-5 — change-quiz: a COMPREHENSION gate (Thariq Shihipar's "quiz before merge") built as
// an ACTIVE mechanism, not a passive skill (RULE #9). After a green verify with source changes, a
// tool.execute.after steer FIRES ITSELF requiring the agent to pass `change_quiz` before "done" — it
// asks 3 questions about the agent's OWN diff and grades the answers against that diff (aux model as a
// strict grader, grounded in the real change; no self-assessment theater). Pure logic in
// lib/changequiz.ts; this file wires `git diff` + callAux + hooks. Kill-switch FABULA_CHANGE_QUIZ=0.

import type { Plugin } from "@mimo-ai/plugin"
import { tool } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import { EDIT_TOOLS, BASH_TOOLS, BASH_EDIT_MARKER, editUnits } from "./lib/edittools"
import { callAux } from "./lib/auxLLM"
import { spawn } from "node:child_process"
import { quizPrompt, gradePrompt, parseGrade, newQuizState, shouldSteerQuiz, shouldInjectQuizReminder, CHANGE_QUIZ_STEER, CHANGE_QUIZ_REMINDER, type QuizState } from "./lib/changequiz"
import { isSourceFile } from "./lib/unknowns"

const z = tool.schema

const states = new Map<string, QuizState>()
function stateFor(sid: string): QuizState {
  let s = states.get(sid)
  if (!s) { s = newQuizState(); states.set(sid, s) }
  return s
}
/** The uncommitted change (working tree vs HEAD), capped. Empty if not a git repo / no changes. */
function gitDiff(dir: string, maxBytes = 14000): Promise<string> {
  return new Promise((resolve) => {
    const c = spawn("bash", ["-lc", "git diff HEAD -- . 2>/dev/null || git diff 2>/dev/null"], { cwd: dir, env: process.env })
    let out = ""
    const t = setTimeout(() => { try { c.kill() } catch {} }, 6000)
    c.stdout.on("data", (d) => { if (out.length < maxBytes) out += d.toString() })
    c.on("close", () => { clearTimeout(t); resolve(out.slice(0, maxBytes)) })
    c.on("error", () => { clearTimeout(t); resolve("") })
  })
}

export const FabulaChangeQuiz: Plugin = async () =>
  process.env.FABULA_CHANGE_QUIZ === "0" ? {} : gate("change-quiz", {
    tool: {
      change_quiz: tool({
        description:
          "Prove you understand your OWN change before claiming a coding task done. Call with NO args to " +
          "get 3 comprehension questions about your current diff; answer them, then call again with " +
          "`answers` to be graded against the diff. Returns PASS/FAIL. Only a PASS lets you claim done.",
        args: {
          answers: z.string().optional().describe("Your answers to the 3 questions (omit on the first call to receive the questions)"),
        },
        async execute(args: any, ctx: any) {
          const dir = ctx?.directory || process.cwd()
          const sid = ctx?.sessionID || "?"
          const diff = await gitDiff(dir)
          if (!diff.trim()) return "change_quiz: no uncommitted change detected (git diff HEAD is empty) — nothing to quiz."
          const answers = typeof args?.answers === "string" ? args.answers.trim() : ""
          try {
            if (!answers) {
              const r = await callAux(quizPrompt(diff), { maxTokens: 1500, timeoutMs: 120000 })
              return { output: `CHANGE-QUIZ — answer these about YOUR diff, then call change_quiz again with \`answers\`:\n\n${r.text.trim()}`, metadata: { phase: "questions", provider: r.provider } }
            }
            const g = await callAux(gradePrompt(diff, answers), { maxTokens: 1200, timeoutMs: 120000 })
            const { passed, detail } = parseGrade(g.text)
            if (passed) stateFor(sid).passed = true
            return { output: (passed ? "✅ change_quiz PASS — you understand your change; you may claim done.\n\n" : "❌ change_quiz FAIL — you don't yet understand your change; re-read the diff and try again.\n\n") + detail, metadata: { passed } }
          } catch (e: any) {
            return `change_quiz: aux model unreachable (${e?.message || e}). Explain your diff yourself: what it does, what you preserved, the riskiest edge case.`
          }
        },
      }),
    },

    "chat.message": async (input: any) => {
      try { const sid = input?.sessionID; if (!sid) return; if (states.size > 500) states.clear(); states.set(sid, newQuizState()) } catch {}
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (!output) return
      try {
        const sid = input?.sessionID || "?"
        const t = input?.tool
        if (t === "change_quiz") return // handled in execute
        // track source edits AND plant the change-quiz requirement RIGHT ON THE EDIT RESULT the model
        // just saw (RULE #9: this tool-result steer is the strong pattern that actually gets acted on —
        // proven live with reference-first — unlike a nudge buried in the prompt, and it does NOT depend
        // on the model choosing to call verify_done). Fires once per task.
        if (EDIT_TOOLS.has(t) || BASH_TOOLS.has(t)) {
          const fp = editUnits(t, input?.args).find((u) => u === BASH_EDIT_MARKER || isSourceFile(u))
          const st = stateFor(sid)
          if (fp) {
            st.sourceChanged = true
            if (shouldInjectQuizReminder(st) && typeof output.output === "string") {
              st.injected = true
              output.output = output.output + CHANGE_QUIZ_REMINDER
              if (output.metadata && typeof output.metadata === "object") output.metadata.changeQuiz = "reminded"
            }
          }
          return
        }
        // gate: a GREEN verify with an unexplained source change → require change_quiz PASS first
        if (t === "verify_done" && output?.metadata?.passed === true) {
          const st = stateFor(sid)
          if (shouldSteerQuiz(st) && typeof output.output === "string") {
            st.steered = true
            output.output = output.output.replace("✅ VERIFIED DONE", "⏳ NOT YET DONE (change-quiz gate)") + CHANGE_QUIZ_STEER
            if (output.metadata && typeof output.metadata === "object") output.metadata.changeQuiz = "steered"
          }
        }
      } catch {}
    },
  })
