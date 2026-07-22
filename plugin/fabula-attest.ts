// FABULA-LLM-5 — universal deliverable verification (design docs/research/UNIVERSAL-VERIFY-DESIGN §17).
// Every gate we ship verifies CODE (tests exist → fail-to-pass). On a non-verifiable task (a literary
// analysis, a plan, a research summary) that whole apparatus is inert and quality is unsupervised. This
// plugin closes that: it decomposes a written deliverable into TYPED atomic claims and independently
// re-derives each one — a quote must grep-match its cited source (scoped, so mis-attribution is caught),
// a number must appear in the source, a "read all N files" claim is checked against the run ledger — and
// only the SIGNAL residue reaches the (quarantined) entailment oracle that separates a faithful paraphrase
// from a fabrication. Refuted load-bearing claims come back with a TYPED repair, bounded. The gate is
// SILENT unless the task requested a checkable deliverable (never punishes a chat turn) and lives entirely
// in a plugin hook (never the engine stop-path). Pure cores in lib/attest/*; kill-switch FABULA_ATTEST=0.

import type { Plugin } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import { callAux } from "./lib/auxLLM"
import { taskIsVerifiable } from "./lib/attest/arming"
import { runAttestGate } from "./lib/attest/gate"
import type { Contract, SourceDoc, LedgerView } from "./lib/attest/types"

const READ_TOOLS = new Set(["read", "view"])
const WRITE_TOOLS = new Set(["create_file"]) // MVP: the deliverable is a file the model wrote (the book case)

const CALL_BUDGET = Math.max(0, parseInt(process.env.FABULA_ATTEST_CALL_BUDGET || "6", 10) || 6)

interface SessState {
  armed: boolean
  contract: Contract
  sources: Map<string, string> // label → text (files read this turn = trusted local sources)
  reads: string[] // ledger view (partial)
  fired: boolean // once per task
}
const states = new Map<string, SessState>()
function stateFor(sid: string): SessState {
  let s = states.get(sid)
  if (!s) {
    s = { armed: false, contract: { verifiable: false, conclusions: [], criteria: [], terminals: ["verified"] }, sources: new Map(), reads: [], fired: false }
    states.set(sid, s)
  }
  return s
}

function argStr(o: any, keys: string[]): string {
  for (const k of keys) if (typeof o?.[k] === "string" && o[k]) return o[k]
  return ""
}
function baseLabel(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/** Run the gate over a written deliverable via the shared orchestrator (same code path the bench runs).
 *  Best-effort, never throws, bounded aux calls. Returns a re-entry steer ("" when all load-bearing
 *  claims are grounded). */
async function runGate(state: SessState, deliverable: string): Promise<string> {
  const sources: SourceDoc[] = [...state.sources.entries()].map(([label, text]) => ({ label, text }))
  const ledger: LedgerView = { readLabels: state.reads.slice(), partial: true } // our tracking is best-effort
  const out = await runAttestGate({ deliverable, sources, ledger, contract: state.contract, callAux, budget: CALL_BUDGET })
  return out.steer
}

export const FabulaAttest: Plugin = async () =>
  process.env.FABULA_ATTEST === "0" ? {} : gate("attest", {
    // Ход 1 — arm ONLY when the task requests a checkable deliverable (model-free, fail-silent). This is
    // the invariant that keeps the gate silent on chat / opinion turns.
    "chat.message": async (input: any) => {
      try {
        const sid = input?.sessionID
        if (!sid) return
        if (states.size > 500) states.clear()
        const text = typeof input?.message?.text === "string" ? input.message.text
          : Array.isArray(input?.parts) ? input.parts.map((p: any) => p?.text || "").join(" ")
          : typeof input?.text === "string" ? input.text : ""
        const s = stateFor(sid)
        s.armed = taskIsVerifiable(text)
        s.contract = { verifiable: s.armed, conclusions: [], criteria: [], terminals: ["verified"] }
        s.sources = new Map()
        s.reads = []
        s.fired = false
      } catch {}
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (!output) return
      try {
        const sid = input?.sessionID || "?"
        const t = input?.tool
        const s = stateFor(sid)
        // track local reads as trusted sources + a partial ledger view
        if (READ_TOOLS.has(t)) {
          const label = baseLabel(argStr(input?.args, ["path", "file_path", "filename"]) || "source")
          const text = typeof output?.output === "string" ? output.output : ""
          if (text) { s.sources.set(label, text); s.reads.push(label) }
          return
        }
        // a written deliverable → run the gate once (armed only), plant a typed re-entry steer on the result
        if (WRITE_TOOLS.has(t) && s.armed && !s.fired) {
          const deliverable = argStr(input?.args, ["content", "file_text", "text"])
          if (!deliverable) return
          s.fired = true
          const steer = await runGate(s, deliverable)
          if (steer && typeof output.output === "string") {
            output.output = output.output + steer
            if (output.metadata && typeof output.metadata === "object") output.metadata.attest = "not-done"
          }
        }
      } catch {}
    },
  })
