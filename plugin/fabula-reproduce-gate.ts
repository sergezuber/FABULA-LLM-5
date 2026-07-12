// FABULA-LLM-5 — reproduce-first done-gate (one plugin per file). Wires the PURE controller in
// lib/reprogate.ts to the engine hooks. It STRENGTHENS the existing verify_done done-gate with the
// lesson proven on SWE-bench Pro 479aa075: a green EXISTING suite does not prove a fix, because it
// often never runs the new code path. When the agent changed source but added no test, and
// verify_done comes back green, this downgrades "done" and steers the agent to write a reproduction
// test that exercises the new behavior, then re-verify.
//
// Hooks used (capabilities per fabula-reliability.ts):
//   chat.message         fires per user turn                 → reset the per-task change set
//   tool.execute.after   CAN append to the result the model sees → record edits + downgrade verify_done
//
// Advisory by design (mirrors the existing soft done-gate): it appends a steer, it does not throw.
// Kill-switch: FABULA_REPRODUCE_GATE=0. User-toggleable via the plugin manager (id "reproduce-gate").

import type { Plugin } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import { newReproState, recordEdit, gateVerdict, taskForbidsTests, type ReproState } from "./lib/reprogate"

// File-writing tools feed the change set. editUnits() covers the edit tools AND tree-mutating bash
// (sed -i / git apply / redirect / tee) so a shell patch is no longer invisible to the gate.
import { EDIT_TOOLS, BASH_TOOLS, editUnits } from "./lib/edittools"

const states = new Map<string, ReproState>()
function stateFor(sid: string): ReproState {
  let s = states.get(sid)
  if (!s) { s = newReproState(); states.set(sid, s) }
  return s
}
export const FabulaReproduceGate: Plugin = async () =>
  process.env.FABULA_REPRODUCE_GATE === "0" ? {} : gate("reproduce-gate", ({
    // New user turn = a fresh task → reset change tracking (bound the map so it can't grow forever).
    // REAL engine shape: chat.message fires with (hookInput, { message, parts }) — the parts carry the
    // user's task text, from which we detect a test-edit prohibition (then the gate stands down: steering
    // toward a test would induce a task-contract violation — the proven TEST_APPLY_FAIL mechanism).
    "chat.message": async (input: any, body: any) => {
      try {
        const sid = input?.sessionID
        if (!sid) return
        if (states.size > 500) states.clear()
        const s = newReproState()
        const parts = Array.isArray(body?.parts) ? body.parts : []
        const taskText = parts.filter((p: any) => p?.type === "text").map((p: any) => p?.text || "").join("\n")
        s.testsForbidden = taskForbidsTests(taskText)
        states.set(sid, s)
      } catch {}
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (!output) return
      try {
        const sid = input?.sessionID || "?"
        const toolName = input?.tool

        // 1) Build the change set from file edits (edit tools + tree-mutating bash).
        if (EDIT_TOOLS.has(toolName) || BASH_TOOLS.has(toolName)) {
          for (const fp of editUnits(toolName, input?.args)) recordEdit(stateFor(sid), fp)
          return
        }

        // 2) On a GREEN verify_done with no reproduction test written, downgrade + steer.
        if (toolName === "verify_done" && output?.metadata?.passed === true) {
          const st = stateFor(sid)
          const v = gateVerdict(true, st)
          if (!v.done && v.note && typeof output.output === "string") {
            st.nudged = true
            output.output =
              output.output.replace("✅ VERIFIED DONE", "⏳ NOT YET DONE (reproduce-first gate)") + v.note
            if (output.metadata && typeof output.metadata === "object") output.metadata.reproduceGate = "steered"
          }
        }
      } catch {}
    },
  }))
