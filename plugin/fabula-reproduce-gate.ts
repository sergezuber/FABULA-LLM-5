// FABULA-LLM-5 — reproduce-first done-gate (one plugin per file). Wires the PURE controllers in
// lib/reprogate.ts (verdict) + lib/ftprobe.ts (real fail-to-pass / pass-to-pass probe) to the engine hooks.
// It STRENGTHENS the verify_done done-gate with the lesson proven on SWE-bench Pro 479aa075 and formalized
// in the literature (arXiv:2508.06365 fail-to-pass, 2511.16858 test-overfitting, 2605.07769 no-change):
// a green EXISTING suite — and even a green NEW test — do not prove a fix. On a green verify_done the gate
// runs the model's new test against the PRE-patch tree (must FAIL) and the current tree (must PASS), re-runs
// the project's pre-existing suite (pass-to-pass), and freezes the validated test so it cannot be loosened.
// When it cannot validate (no base captured / container-only verify env / unsupported runner) it DEGRADES to
// the permissive test-exists gate and marks the verdict `not-validated (<reason>)` — a check it cannot run
// never traps a correct fix (fail-open, model-agnostic per RULE #14).
//
// Hooks (capabilities per fabula-reliability.ts):
//   chat.message         per user turn                                 → reset the per-task change set
//   tool.execute.after   CAN append to the result the model sees       → record edits + gate verify_done
//
// Advisory by design (mirrors the existing soft done-gate): it appends a steer, it does not throw.
// Kill-switch: FABULA_REPRODUCE_GATE=0. User-toggleable via the plugin manager (id "reproduce-gate").

import type { Plugin } from "@mimo-ai/plugin"
import { join } from "node:path"
import { gate } from "./lib/manage"
import {
  newReproState, recordEdit, strictGateVerdict, taskForbidsTests,
  type ReproState, type StrictInputs,
} from "./lib/reprogate"
import { EDIT_TOOLS, BASH_TOOLS, BASH_EDIT_MARKER, editUnits } from "./lib/edittools"
import { failToPassProbe, siblingSuitePasses, newTestsPassOnCurrent, sha256File } from "./lib/ftprobe"

const states = new Map<string, ReproState>()
function stateFor(sid: string): ReproState {
  let s = states.get(sid)
  if (!s) { s = newReproState(); states.set(sid, s) }
  return s
}

export const FabulaReproduceGate: Plugin = async (pluginInput: any) =>
  process.env.FABULA_REPRODUCE_GATE === "0" ? {} : gate("reproduce-gate", ({
    // New user turn = a fresh task → reset change tracking (bound the map so it can't grow forever). The
    // parts carry the user's task text, from which we detect a test-edit prohibition (then the gate stands
    // down: steering toward a test would induce a task-contract violation — the proven TEST_APPLY_FAIL).
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

        // 2) On a GREEN verify_done, run the STRICT reproduce-first gate.
        if (toolName === "verify_done" && output?.metadata?.passed === true) {
          const st = stateFor(sid)
          const hasSourceChange = st.sourceChanged.size > 0
          const hasNewTest = st.testChanged.size > 0
          if (!hasSourceChange && !hasNewTest) return // nothing this turn to gate

          // The project workspace: a per-call worktree/directory if the engine gives one, else the one the
          // plugin was constructed with. Undefined → the probes degrade honestly ("no base"), never crash.
          const ws: string | undefined =
            input?.worktree?.path || input?.directory || pluginInput?.directory || undefined
          const newTests = [...st.testChanged].filter((t) => t !== BASH_EDIT_MARKER)

          // FREEZE check: has a validated test's content changed since it went green? (anti-cheat)
          let freezeReArmed = false
          for (const [rel, h] of Object.entries(st.frozenTestHashes)) {
            if ((ws ? sha256File(join(ws, rel)) : null) !== h) { freezeReArmed = true; break }
          }

          // Run the real probes ONLY on the branch that needs them (avoid needless subprocesses).
          let noChangePasses = false
          let ftpRan = false, ftpReason: string | undefined = "no base"
          let preExit: number | null = null, postExit: number | null = null
          let siblingPassed: boolean | null = null
          if (!st.testsForbidden && !freezeReArmed) {
            if (!hasSourceChange && hasNewTest) {
              noChangePasses = newTestsPassOnCurrent(ws, newTests) // no-change terminal probe
            } else if (hasSourceChange && hasNewTest) {
              const ftp = failToPassProbe(ws, newTests)
              ftpRan = ftp.ran; ftpReason = ftp.reason; preExit = ftp.preExit; postExit = ftp.postExit
              // pass-to-pass only after a validated real repro (fails-pre, passes-post).
              if (ftp.ran && ftp.postExit === 0 && ftp.preExit !== 0) siblingPassed = siblingSuitePasses(ws!)
            }
          }

          const x: StrictInputs = {
            freezeReArmed, hasSourceChange, hasNewTest, noChangePasses,
            ftpRan, ftpReason, preExit, postExit, siblingPassed,
          }
          const v = strictGateVerdict(true, st, x)

          // FREEZE the validated repro's content so a later edit re-arms the gate.
          if (v.marks.failToPass === "validated" && ws) {
            for (const t of newTests) { const h = sha256File(join(ws, t)); if (h) st.frozenTestHashes[t] = h }
          }
          // After a re-arm, re-freeze at the new content so the NEXT verify RE-VALIDATES (never a perpetual trap).
          if (freezeReArmed && ws) {
            for (const rel of Object.keys(st.frozenTestHashes)) { const h = sha256File(join(ws, rel)); if (h) st.frozenTestHashes[rel] = h }
          }

          // Apply honest markers, and (only on a downgrade) rewrite the header + append the steer.
          if (output.metadata && typeof output.metadata === "object") {
            for (const [k, val] of Object.entries(v.marks)) output.metadata[k] = val
          }
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
