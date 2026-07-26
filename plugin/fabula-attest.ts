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
import { buildAttestation, upsertAttestation, ATTESTATION_FILE } from "./lib/attest/attestation"
import { writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { join as joinPath } from "node:path"
import { detectStripped } from "./lib/attest/remediation"
import { isTextDeliverable, shouldRemark, SUBAGENT_ROLES } from "./lib/attest/textdeliverable"
import type { Claim, Contract, SourceDoc, LedgerView } from "./lib/attest/types"

const READ_TOOLS = new Set(["read", "view"])
const WRITE_TOOLS = new Set(["create_file", "str_replace"]) // the deliverable is a file the model wrote/edited
// Remark (nudge back into the chat when a text-only deliverable fails) caps how many times the gate
// will re-engage on the same task — a bounded loop, never unbounded re-entry.
const REMARK_MAX = Math.max(0, parseInt(process.env.FABULA_ATTEST_REMARK_MAX || "1", 10) || 1)

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
  hadWriteTool: boolean // a write/edit tool ran this turn → the deliverable is a FILE, not the chat text
  textChecked: boolean // recursion guard: the text deliverable path already ran for this turn
  remarks: number // how many text-deliverable remarks already sent this task (bounded by REMARK_MAX)
}
const states = new Map<string, SessState>()
function stateFor(sid: string): SessState {
  let s = states.get(sid)
  if (!s) {
    s = { armed: false, contract: buildContract(false), taskText: "", sources: new Map(), reads: [], rounds: 0, lastClaims: [], hadWriteTool: false, textChecked: false, remarks: 0 }
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


/**
 * Record what was checked, beside the receipt and never inside it.
 *
 * The gate acts in the turn where it runs; this is what survives afterwards for someone who was not
 * there. Only the deterministic outcomes are written as facts — the model-decided ones become
 * `unverifiable-here`, because a verdict at temperature 0.4 from whichever model happened to be loaded
 * is not something a reader can re-run. Writing it as a finding would weaken the guarantee for the code
 * receipts too, which is the whole reason this is a companion file rather than a receipt field.
 *
 * Never throws: a record that fails to write must not take down the gate that produced it.
 */
function writeAttestation(dir: string, deliverable: string, sources: any[], out: any): string | null {
  try {
    const deterministic: Record<string, any> = {}
    const modelVerdicts: Record<string, any> = {}
    for (const r of out?.results ?? []) {
      if (!r?.claim?.id) continue
      // pass1 is the cheap deterministic sweep; NA means it had nothing to say about this claim.
      if (r.pass1 && r.pass1 !== "NA") deterministic[r.claim.id] = r.pass1
      if (r.verdict) modelVerdicts[r.claim.id] = r.verdict
    }
    const rec = buildAttestation({ deliverable, sources, claims: out?.claims ?? [], deterministic, modelVerdicts })
    const recDir = joinPath(dir, ".fabula", "receipts")
    mkdirSync(recDir, { recursive: true })
    const file = joinPath(recDir, ATTESTATION_FILE)
    let prev: unknown = []
    try { prev = JSON.parse(readFileSync(file, "utf8")) } catch { prev = [] }
    writeFileSync(file, JSON.stringify(upsertAttestation(prev, rec), null, 2))
    return file
  } catch {
    return null
  }
}

export const FabulaAttest: Plugin = async (pluginInput) =>
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
        s.hadWriteTool = false
        s.textChecked = false
        s.remarks = 0
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
          s.hadWriteTool = true // a file was the deliverable → the text path must NOT also fire
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
          writeAttestation(
            input?.directory || process.cwd(), deliverable,
            [...s.sources.entries()].map(([label, text]) => ({ label, text })), out,
          )
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

    // Text-only deliverable (design §4, §17.I) — the motivating case: a literary analysis delivered AS
    // TEXT IN THE CHAT, not a file. Fires once at turn end (session.post), ONLY when the task armed as a
    // deliverable, completed normally, did NOT write a file (the file path covers that), and the final text
    // is a structured analytical answer (not a long chat reply). BOUNDED to REMARK_MAX re-engagements per
    // task. When a load-bearing claim is refuted, a remark is nudged back into the chat so the model can
    // ground it in the next turn. Fail-silent throughout: any doubt → no remark.
    "session.post": async (input: any) => {
      try {
        const sid = input?.sessionID
        if (!sid) return
        const s = stateFor(sid)
        // recursion guard for THIS turn; plus the bounded re-engagement across the whole task
        if (s.textChecked || s.remarks >= REMARK_MAX) return
        const deliverable = isTextDeliverable({
          armed: s.armed,
          outcome: input?.outcome,
          agentID: input?.agentID,
          finalText: input?.finalText,
          hadWriteTool: s.hadWriteTool,
          subagents: SUBAGENT_ROLES,
          alreadyChecked: s.textChecked,
        })
        if (!deliverable) return
        s.textChecked = true // mark immediately — even if the gate errors, never re-fire this turn
        const out = await runAttestGate({
          deliverable: input?.finalText || "",
          sources: [...s.sources.entries()].map(([label, text]) => ({ label, text })) as SourceDoc[],
          ledger: { readLabels: s.reads.slice(), partial: true } as LedgerView,
          contract: s.contract, callAux, budget: CALL_BUDGET, taskText: s.taskText,
          selfConsistency: SELF_CONSISTENCY, wallclockMs: WALLCLOCK_MS,
        })
        s.lastClaims = out.claims
        const refuted = out.results.filter((r) => r.failure === "refuted").length
        if (!shouldRemark(out.verdict.done, refuted)) return
        // Send the remark back into the chat: the main agent reads it on its NEXT turn and can ground the
        // refuted claim. noReply=false so the agent engages; bounded by REMARK_MAX so it can't loop.
        const client = (pluginInput as any)?.client
        if (!client?.session?.prompt) return // no SDK client available → degrade to silent (never throw)
        const remark =
          `🔎 ВЕРИФИКАЦИЯ ДЕЛИВЕРАБЛА: ${refuted} ключевое утверждение не подтверждается источниками.\n` +
          `${out.steer || ""}\n\n` +
          `ОБЯЗАНО: либо подкрепить утверждение ссылкой на источник (цитата/число должны буквально встречаться в материале), либо явно пометить как непроверяемое суждение. Не удаляй утверждение, чтобы пройти проверку.`
        s.remarks++
        await client.session.prompt({
          path: { id: sid },
          body: {
            parts: [{ type: "text", text: remark }],
            // keep the main agent in the loop, not a subagent
          },
        })
      } catch {}
    },
  })
