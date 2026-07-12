// FABULA-LLM-5 — fabula-learn: closes the "skills compound" loop as an ACTIVE self-nudge, not a
// passive skill (RULE #9). After the agent completes AND verifies a real multi-step change, a
// tool.execute.after steer FIRES ITSELF on the green verify_done result, pointing at /distill so the
// just-finished trajectory gets packaged into a reusable skill while it is fresh. This is the LIGHT,
// manual-trigger alternative to the guarded auto-distill pass (see fabula-distill-guard): it never
// runs distill for you. Pure logic in lib/learn.ts. Kill-switch: FABULA_LEARN_NUDGE=0.

import type { Plugin } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import { newLearnState, shouldNudgeLearn, LEARN_NUDGE, type LearnState } from "./lib/learn"
import { isSourceFile } from "./lib/unknowns"

const states = new Map<string, LearnState>()
function stateFor(sid: string): LearnState {
  let s = states.get(sid)
  if (!s) {
    s = newLearnState()
    states.set(sid, s)
  }
  return s
}
function editPath(args: any): string | null {
  const p = args?.file_path ?? args?.path ?? args?.filePath ?? args?.file
  return typeof p === "string" && p ? p : null
}

export const FabulaLearn: Plugin = async () =>
  process.env.FABULA_LEARN_NUDGE === "0"
    ? {}
    : gate("learn", {
        // Reset per turn: the nudge is about the change JUST completed, not the whole session.
        "chat.message": async (input: any) => {
          try {
            const sid = input?.sessionID
            if (!sid) return
            if (states.size > 500) states.clear()
            states.set(sid, newLearnState())
          } catch {}
        },

        "tool.execute.after": async (input: any, output: any) => {
          if (!output) return
          try {
            const sid = input?.sessionID || "?"
            const t = input?.tool
            const st = stateFor(sid)
            st.tools++
            // Count real source edits — the signal that a repeatable workflow (not a doc tweak) happened.
            if (t === "create_file" || t === "str_replace" || t === "write" || t === "edit") {
              const fp = editPath(input?.args)
              if (fp && isSourceFile(fp)) st.edits++
              return
            }
            // On a GREEN verify of a real multi-step change, nudge to package it. Tool-result steer =
            // the strong self-firing pattern (RULE #9); fires at most once per turn.
            if (t === "verify_done" && output?.metadata?.passed === true) {
              st.verified = true
              if (shouldNudgeLearn(st) && typeof output.output === "string") {
                st.nudged = true
                output.output = output.output + LEARN_NUDGE
                if (output.metadata && typeof output.metadata === "object") output.metadata.learn = "nudged"
              }
            }
          } catch {}
        },
      })
