// FABULA-LLM-5 — universal deliverable verification (design docs/research/UNIVERSAL-VERIFY-DESIGN §17).
// Every gate we ship verifies CODE (tests exist → fail-to-pass). On a non-verifiable task (a literary
// analysis, a plan, a research summary) that whole apparatus is inert and quality is unsupervised. This
// plugin closes that: it decomposes a written deliverable into TYPED atomic claims and independently
// re-derives each one — a quote must grep-match its cited source (scoped, so mis-attribution is caught),
// a number must appear in the source, a "read all N files" claim is checked against the run ledger — and
// only the SIGNAL residue reaches the (quarantined) entailment oracle that separates a faithful paraphrase
// from a fabrication. Refuted load-bearing claims come back with a TYPED repair, over a BOUNDED number of
// rounds (FABULA_ATTEST_MAX), with a Goodhart-by-deletion guard between rounds. The gate is SILENT unless
// the task requested a checkable deliverable (never punishes a chat turn) and lives entirely in a plugin
// hook (never the engine stop-path). Pure cores in lib/attest/*; kill-switch FABULA_ATTEST=0.

import type { Plugin } from "@mimo-ai/plugin"
import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { gate } from "./lib/manage"
import { callAux } from "./lib/auxLLM"
import { taskIsVerifiable } from "./lib/attest/arming"
import { shouldArm, buildContract } from "./lib/attest/contract"
import { runAttestGate } from "./lib/attest/gate"
import { detectStripped } from "./lib/attest/remediation"
import type { Claim, Contract, SourceDoc, LedgerView } from "./lib/attest/types"

const READ_TOOLS = new Set(["read", "view"])
const WRITE_TOOLS = new Set(["create_file", "str_replace"]) // the deliverable is a file the model wrote/edited

const CALL_BUDGET = Math.max(0, parseInt(process.env.FABULA_ATTEST_CALL_BUDGET || "6", 10) || 6)
const MAX_ROUNDS = Math.max(1, parseInt(process.env.FABULA_ATTEST_MAX || "2", 10) || 2)
const WALLCLOCK_MS = Math.max(0, parseInt(process.env.FABULA_ATTEST_WALLCLOCK_MS || "90000", 10) || 90000)
const SELF_CONSISTENCY = process.env.FABULA_ATTEST_SELF_CONSISTENCY === "1"

interface SessState {
  armed: boolean
  contract: Contract
  taskText: string
  sources: Map<string, string> // label → text (files read this turn = trusted local sources)
  reads: string[] // ledger view (partial)
  rounds: number // gate fires this many times, capped at MAX_ROUNDS (bounded re-entry)
  lastClaims: Claim[] // previous round's claims — for the Goodhart-by-deletion guard between rounds
}
const states = new Map<string, SessState>()
function stateFor(sid: string): SessState {
  let s = states.get(sid)
  if (!s) {
    s = { armed: false, contract: buildContract(false), taskText: "", sources: new Map(), reads: [], rounds: 0, lastClaims: [] }
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
/** Read the current content of a file the model just edited via str_replace (the deliverable is the
 *  RESULT, not the small diff in args). Best-effort; empty on any failure. */
function readDeliverable(dir: string, path: string): string {
  try {
    const abs = isAbsolute(path) ? path : join(dir || process.cwd(), path)
    return readFileSync(abs, "utf8")
  } catch {
    return ""
  }
}

export const FabulaAttest: Plugin = async () =>
  process.env.FABULA_ATTEST === "0" ? {} : gate("attest", {
    // Ход 1 — arm ONLY when the task requests a checkable deliverable (model-free pre-screen → Contract →
    // shouldArm). This is the invariant that keeps the gate silent on chat / opinion turns.
    "chat.message": async (input: any) => {
      try {
        const sid = input?.sessionID
        if (!sid) return
        if (states.size > 500) states.clear()
        const text = typeof input?.message?.text === "string" ? input.message.text
          : Array.isArray(input?.parts) ? input.parts.map((p: any) => p?.text || "").join(" ")
          : typeof input?.text === "string" ? input.text : ""
        const s = stateFor(sid)
        s.contract = buildContract(taskIsVerifiable(text))
        s.armed = shouldArm(s.contract)
        s.taskText = text
        s.sources = new Map()
        s.reads = []
        s.rounds = 0
        s.lastClaims = []
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
        // a written/edited deliverable → run the gate (armed only), BOUNDED to MAX_ROUNDS re-checks.
        if (WRITE_TOOLS.has(t) && s.armed && s.rounds < MAX_ROUNDS) {
          const path = argStr(input?.args, ["path", "file_path", "filename"])
          const deliverable = t === "create_file"
            ? argStr(input?.args, ["content", "file_text", "text"])
            : readDeliverable(input?.directory || process.cwd(), path) // str_replace → read the resulting file
          if (!deliverable || deliverable.length < 40) return
          s.rounds++
          const out = await runAttestGate({
            deliverable, sources: [...s.sources.entries()].map(([label, text]) => ({ label, text })) as SourceDoc[],
            ledger: { readLabels: s.reads.slice(), partial: true } as LedgerView,
            contract: s.contract, callAux, budget: CALL_BUDGET, taskText: s.taskText,
            selfConsistency: SELF_CONSISTENCY, wallclockMs: WALLCLOCK_MS,
          })
          // Goodhart-by-deletion: a load-bearing claim present last round that vanished this round.
          const stripped = detectStripped(s.lastClaims, out.claims)
          s.lastClaims = out.claims
          let steer = out.steer
          if (stripped.length && steer) {
            steer += `\n⚠️ ${stripped.length} load-bearing claim(s) were REMOVED since the last round — ground a claim or mark it as unverified judgment; do not delete it to pass.`
          }
          if (steer && typeof output.output === "string") {
            output.output = output.output + steer
            if (output.metadata && typeof output.metadata === "object") output.metadata.attest = "not-done"
          }
        }
      } catch {}
    },
  })
