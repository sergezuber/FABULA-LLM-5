// FABULA-LLM-5 — Proof-of-Done receipt (LOCK: done leaves evidence, not a claim). This plugin is a
// READ-ONLY consumer of the run: it watches passively (model, task, edits, which gates fired), and when
// a verify_done comes back GREEN and no other gate has downgraded it, it mints a machine-readable
// receipt — model in the socket, gates that fired, the diff, the verification that passed, and a
// deterministic replay command (the Greenpaper contract). It NEVER blocks, downgrades, or mutates the
// verdict — the other gates (reproduce, change-quiz, rewind) own that; this only records what they left.
//
// Why a hook and not a skill (RULE #9): a local model won't reliably emit an honest, replayable proof of
// its own work. The harness mints it deterministically on the green event. Pure logic + tests in
// lib/receipt.ts. Manual mint: `mint_receipt`. Toggle via plugin manager (id "receipt"). Off: FABULA_RECEIPT=0.

import type { Plugin } from "@mimo-ai/plugin"
import { tool } from "@mimo-ai/plugin"
import { spawn } from "node:child_process"
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { gate, isEnabled } from "./lib/manage"
import {
  newReceiptState, recordModel, recordTask, recordEdit, recordGate, buildReceipt,
  renderReceiptMarkdown, renderReceiptJSON, receiptSummary, reproPending,
  type ReceiptState, type ReceiptVerification,
} from "./lib/receipt"
import { contextProvenanceFor, engineModelIDFor } from "./lib/provenance"
import { pickDescriptor, descriptorHash, weightsDigestForDir, resolveModelDir, loadWeightsCache, saveWeightsCache } from "./lib/modeldigest"
import { homedir } from "node:os"
import { gitDiffAllInfo } from "./lib/gitdiff"
import { EDIT_TOOLS, BASH_TOOLS, editUnits } from "./lib/edittools"

const z = tool.schema
const DISABLED = process.env.FABULA_RECEIPT === "0"
// The change-quiz gate downgrades a green verify with unexplained source changes. Its hook order vs
// ours is UNSPECIFIED (glob scan), so we must not rely on seeing its downgrade text — mirror the
// requirement deterministically: while the quiz plugin is active and source changed, no mint until a
// change_quiz PASS was observed in this session.
function quizActive(): boolean {
  if (process.env.FABULA_CHANGE_QUIZ === "0") return false
  try { return isEnabled("change-quiz") } catch { return true }
}
// Same reasoning for the reproduce requirement: only enforce it while that gate is actually active,
// otherwise a disabled gate silently blocks every mint (and records a gate that never fired).
function reproGateActive(): boolean {
  if (process.env.FABULA_REPRODUCE_GATE === "0") return false
  try { return isEnabled("reproduce-gate") } catch { return true }
}

const states = new Map<string, ReceiptState>()
function stateFor(sid: string): ReceiptState {
  let s = states.get(sid)
  if (!s) { s = newReceiptState(); states.set(sid, s) }
  return s
}
function safeNow(): number { try { return Date.now() } catch { return 0 } }

/** Working-tree diff INCLUDING untracked files (a new repro test must land in the patch). */
function gitDiff(dir: string, maxBytes = 200_000): Promise<{ diff: string; truncated: boolean }> {
  return gitDiffAllInfo(dir, maxBytes)
}

/** repo-root-relative path of `dir` ("" when dir IS the root; undefined outside a git repo).
 *  Stamped into verification.cwd so replay re-runs the check from the SAME subdirectory — a bare
 *  `bun test` recorded in a subproject must never sweep the whole worktree on replay. */
function gitRootRel(dir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const c = spawn("bash", ["-lc", "git rev-parse --show-prefix 2>/dev/null"], { cwd: dir, env: process.env })
    let out = ""
    const t = setTimeout(() => { try { c.kill() } catch {} ; resolve(undefined) }, 4000)
    c.stdout.on("data", (d) => { out += d.toString() })
    c.on("close", (code) => { clearTimeout(t); resolve(code === 0 ? out.trim().replace(/\/$/, "") : undefined) })
    c.on("error", () => { clearTimeout(t); resolve(undefined) })
  })
}

/** git HEAD at mint time — the deterministic replay base (empty outside a git repo). */
function gitHead(dir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const c = spawn("bash", ["-lc", "git rev-parse HEAD 2>/dev/null"], { cwd: dir, env: process.env })
    let out = ""
    const t = setTimeout(() => { try { c.kill() } catch {} }, 4000)
    c.stdout.on("data", (d) => { out += d.toString() })
    c.on("close", () => { clearTimeout(t); const s = out.trim(); resolve(/^[0-9a-f]{40}$/.test(s) ? s : undefined) })
    c.on("error", () => { clearTimeout(t); resolve(undefined) })
  })
}

/** A green verify_done that no earlier gate has downgraded. Order-independent: also checks the text. */
function isTrueGreen(output: any): boolean {
  if (output?.metadata?.passed !== true) return false
  // reproduce-gate downgrades by rewriting the text + setting metadata.reproduceGate.
  if (output?.metadata?.reproduceGate === "steered") return false
  const txt = typeof output?.output === "string" ? output.output : ""
  if (/NOT YET DONE|NOT DONE|⏳/.test(txt)) return false
  return true
}

/** Persist both machine + human forms; return the relative patch path used in replay.
 *  A truncated diff is cut mid-hunk — persisting it would mint corrupt, unapplyable evidence, so the
 *  receipt is written WITHOUT a patch file (the diff stats still describe the artifact honestly). */
function writeReceipt(dir: string, mdBody: (patch?: string) => string, jsonBody: (patch?: string) => string, diff: string, truncated: boolean): { rel: string; patchRel?: string } | null {
  try {
    const outDir = join(dir, ".fabula", "receipts")
    mkdirSync(outDir, { recursive: true })
    const stamp = safeNow() || 0
    const base = `receipt-${stamp || "latest"}`
    let patchRel: string | undefined
    if (!truncated) {
      patchRel = join(".fabula", "receipts", `${base}.patch`)
      writeFileSync(join(dir, patchRel), diff, "utf8")
    }
    writeFileSync(join(outDir, `${base}.json`), jsonBody(patchRel), "utf8")
    writeFileSync(join(outDir, `${base}.md`), mdBody(patchRel), "utf8")
    // stable "latest" pointers
    writeFileSync(join(outDir, "latest.json"), jsonBody(patchRel), "utf8")
    writeFileSync(join(outDir, "latest.md"), mdBody(patchRel), "utf8")
    return { rel: join(".fabula", "receipts", `${base}.md`), patchRel }
  } catch { return null }
}

function verificationFrom(output: any): ReceiptVerification {
  const m = output?.metadata || {}
  const txt = typeof output?.output === "string" ? output.output : ""
  // Keep the real captured tail (evidence) — strip only the leading verdict banner FABULA added.
  const tail = txt.replace(/^[^\n]*\n\n?/, "").slice(-4000)
  return {
    cmd: typeof m.cmd === "string" ? m.cmd : "(verify command)",
    exitCode: typeof m.exitCode === "number" ? m.exitCode : null,
    passed: m.passed === true,
    outputTail: tail,
  }
}

// Model identity enrichment (context-provenance v0.2 fields). Descriptor from the serving
// registry API (FABULA_MODEL_API, default LM Studio's /api/v0/models) — pins build/quant, honest
// name, NOT a weights hash. A REAL weights digest over the model files only when
// FABULA_WEIGHTS_DIGEST=1 (first hash of a big model takes minutes; cached by size+mtime after).
// Fail-open: any error just omits the fields — a receipt never blocks on identity telemetry.
async function enrichedProvenance(sessionID: string | undefined, state: ReceiptState) {
  const prov = contextProvenanceFor(sessionID)
  if (!prov) return undefined
  const modelId = state.model?.id || engineModelIDFor(sessionID)
  if (!modelId) return prov
  let out = prov
  try {
    const api = process.env.FABULA_MODEL_API || "http://localhost:1234/api/v0/models"
    const res = await fetch(api, { signal: AbortSignal.timeout(1500) })
    if (res.ok) {
      const d = pickDescriptor(await res.json(), modelId)
      if (d) out = { ...out, modelDescriptorHash: descriptorHash(d), modelDescriptor: d }
    }
  } catch {
    /* descriptor is best-effort */
  }
  if (process.env.FABULA_WEIGHTS_DIGEST === "1") {
    try {
      const dir = resolveModelDir(modelId, join(homedir(), ".lmstudio", "models"), process.env.FABULA_MODEL_DIR)
      if (dir) {
        const cacheFile = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "fabula", "weights-cache.json")
        const cache = loadWeightsCache(cacheFile)
        const wd = weightsDigestForDir(dir, cache)
        if (wd) {
          saveWeightsCache(cacheFile, cache)
          out = { ...out, weightsDigest: wd }
        }
      }
    } catch {
      /* weights digest is opt-in best-effort */
    }
  }
  return out
}

async function mint(dir: string, state: ReceiptState, output: any, sessionID?: string): Promise<{ rel: string; summary: string; replayable: boolean } | null> {
  const { diff, truncated } = await gitDiff(dir)
  const verify = verificationFrom(output)  // outputTail stays VERBATIM — truncation is noted in the receipt prose, not the captured tool output
  const cwdRel = await gitRootRel(dir)
  if (cwdRel) verify.cwd = cwdRel
  const mintedAt = safeNow()
  const base = await gitHead(dir)
  const provenance = await enrichedProvenance(sessionID, state)
  const written = writeReceipt(
    dir,
    (patch) => renderReceiptMarkdown(buildReceipt({ state, verify, diff, workdir: dir, mintedAt, patchPath: patch, base, truncated, provenance })),
    (patch) => renderReceiptJSON(buildReceipt({ state, verify, diff, workdir: dir, mintedAt, patchPath: patch, base, truncated, provenance })),
    diff,
    truncated,
  )
  // A failed write is not a minted receipt — callers must not announce one.
  if (!written) return null
  const r = buildReceipt({ state, verify, diff, workdir: dir, mintedAt, patchPath: written.patchRel, base, truncated, provenance })
  return { rel: written.rel, summary: receiptSummary(r), replayable: !!written.patchRel && !!base }
}

export const FabulaReceipt: Plugin = async (input: any) =>
  DISABLED ? {} : gate("receipt", ({
    // Authoritative model identity: the engine hands the resolved Model to chat.params on every
    // request — no message-shape guessing (a headless run's user message carries no model info).
    "chat.params": async (a: any) => {
      try {
        const sid = a?.sessionID || "?"
        const id = a?.model?.id
        if (id) recordModel(stateFor(sid), { providerID: a?.model?.providerID, modelID: id })
      } catch {}
    },

    // Capture the task + reset per NEW user message. REAL engine shape: chat.message fires once per
    // user prompt with { message: info, parts } (NOT a messages array) and the hook input carries
    // { sessionID, model, messageID } — see engine session/prompt.ts plugin.trigger("chat.message").
    "chat.message": async (hookInput: any, body: any) => {
      try {
        const sid = hookInput?.sessionID || body?.message?.sessionID || "?"
        if (states.size > 500) states.clear()
        const info = body?.message
        const parts = Array.isArray(body?.parts) ? body.parts : []
        const taskText = parts.filter((p: any) => p?.type === "text").map((p: any) => p?.text || "").join("\n")
        const userKey = String(info?.id || hookInput?.messageID || taskText || "?")
        const existing = states.get(sid) as (ReceiptState & { _userKey?: string }) | undefined
        if (existing && existing._userKey === userKey) return
        const s = newReceiptState() as ReceiptState & { _userKey?: string }
        s._userKey = userKey
        recordTask(s, taskText)
        const m = hookInput?.model
        if (m) recordModel(s, typeof m === "string" ? { modelID: m } : { providerID: m?.providerID, modelID: m?.modelID ?? m?.id })
        states.set(sid, s)
      } catch {}
    },

    // Passive recording of edits + gate markers; mint on a true-green verify_done.
    "tool.execute.after": async (hookInput: any, output: any) => {
      if (!output) return
      try {
        const sid = hookInput?.sessionID || "?"
        const toolName = hookInput?.tool
        const s = stateFor(sid)

        // Edit tools AND tree-mutating bash (sed -i / git apply / redirect) count as source edits — a
        // shell patch between a green verify and a quiz PASS must invalidate the stored green, else the
        // receipt could render VERIFIED over an unverified diff.
        if (EDIT_TOOLS.has(toolName) || BASH_TOOLS.has(toolName)) {
          const units = editUnits(toolName, hookInput?.args)
          if (units.length) {
            for (const p of units) recordEdit(s, p)
            ;(s as any)._pendingGreen = undefined // files changed — a stored green verification is stale
            ;(s as any)._minted = false           // …and a fresh green may mint a fresh receipt
          }
          return
        }

        // Gate markers left by other plugins on their results.
        const meta = output?.metadata || {}
        if (toolName === "change_quiz" && meta.passed === true) {
          ;(s as any)._quizPassed = true
          recordGate(s, "comprehension")
          // The last verify was green but gated on this very quiz — all gates are satisfied NOW.
          // Mint here, deterministically: a local model reliably stops after "you may claim done"
          // without re-running verify, and the receipt must not depend on that initiative.
          const pending = (s as any)._pendingGreen
          if (pending && !(reproGateActive() && reproPending(s)) && !(s as any)._minted) {
            ;(s as any)._pendingGreen = undefined
            const dir = input?.directory || hookInput?.directory || process.cwd()
            const res = await mint(dir, s, pending, sid)
            if (typeof output.output === "string") {
              if (res) {
                ;(s as any)._minted = true
                output.output += `\n\n📄 Proof-of-Done receipt minted → ${res.rel}\n   ${res.summary}\n   ${res.replayable ? "Replay it (or hand it to anyone) to re-verify — done is a proof, not a feeling." : "(the diff was too large to record a patch — this receipt is not independently replayable.)"}`
                if (output.metadata && typeof output.metadata === "object") output.metadata.receipt = res.rel
              } else {
                output.output += `\n\n⚠️ Proof-of-Done receipt could NOT be written (.fabula/receipts/ unwritable?) — the verification stands, but no receipt exists for it.`
              }
            }
            return
          }
        }
        if (meta.reproduceGate === "steered") recordGate(s, "reproduce")
        if (meta.autoRewind) recordGate(s, "auto-rewind", meta)
        if (toolName === "escalate_to_cloud") recordGate(s, "second-opinion")

        // A red verify invalidates any stored pending green: minting from it later (e.g. on a quiz
        // PASS) would attach a stale verification to a state that just failed its check.
        if (toolName === "verify_done" && output?.metadata?.passed === false) {
          ;(s as any)._pendingGreen = undefined
        }

        // Gate on the RAW verify signal (metadata.passed), NOT on isTrueGreen(output) — the latter
        // reads output.output, which the change-quiz / reproduce hooks may already have rewritten to
        // "NOT YET DONE" if they ran before us (glob load order). Deciding capture from the mutated text
        // silently dropped the pending green on comprehension-gated tasks and the receipt never minted.
        if (toolName === "verify_done" && output?.metadata?.passed === true && !(s as any)._minted) {
          // Reproduce gating (receipt's OWN model, order-independent): source changed with no test →
          // unproven. Record that the reproduce requirement was forced, and do NOT mint. Only while the
          // gate is actually enabled — a disabled gate must not silently block every mint.
          if (reproGateActive() && reproPending(s)) {
            recordGate(s, "reproduce")
            return
          }
          // Comprehension gating (order-independent): a green with source changes is not done until the
          // change-quiz PASSes. Decide from raw metadata (our sourceEdits/_quizPassed, or the quiz gate's
          // own metadata.changeQuiz==="steered" if it ran first) — NOT from the possibly-rewritten text.
          // Remember this verification: if the quiz passes with no further edits, it mints then.
          const quizHeld =
            ((s.sourceEdits?.size ?? 0) > 0 && quizActive() && !(s as any)._quizPassed) ||
            output?.metadata?.changeQuiz === "steered"
          if (quizHeld) {
            ;(s as any)._pendingGreen = { output: output.output, metadata: { ...(output.metadata || {}) } }
            return
          }
          // No gate we model holds this back. If the text still carries an UNMODELED downgrade from some
          // other gate, respect it (don't mint VERIFIED over a "NOT DONE" verdict) rather than override.
          if (!isTrueGreen(output)) return
          const dir = input?.directory || hookInput?.directory || process.cwd()
          const res = await mint(dir, s, output, sid)
          if (typeof output.output === "string") {
            if (res) {
              ;(s as any)._minted = true
              output.output += `\n\n📄 Proof-of-Done receipt minted → ${res.rel}\n   ${res.summary}\n   Replay it (or hand it to anyone) to re-verify — done is a proof, not a feeling.`
              if (output.metadata && typeof output.metadata === "object") output.metadata.receipt = res.rel
            } else {
              output.output += `\n\n⚠️ Proof-of-Done receipt could NOT be written (.fabula/receipts/ unwritable?) — the verification stands, but no receipt exists for it.`
            }
          }
        }
      } catch {}
    },

    tool: {
      mint_receipt: tool({
        description:
          "Mint a Proof-of-Done receipt for the current verified state: model, gates that fired, the diff, " +
          "the verification, and a deterministic replay command. Call after a green verify_done to hand a " +
          "reviewer (or anyone) something they can re-verify without trusting you. Writes to .fabula/receipts/.",
        args: { note: z.string().nullish().describe("Optional one-line context for the receipt") },
        async execute(_args: any, ctx: any) {
          const dir = ctx?.directory || input?.directory || process.cwd()
          const sid = ctx?.sessionID || "?"
          const s = stateFor(sid)
          const { diff, truncated } = await gitDiff(dir)
          if (!diff.trim()) return "mint_receipt: no uncommitted change (git diff HEAD is empty) — nothing to attest yet. Make and verify a change first."
          // Manual mint: no verify_done event to read, so record the artifact honestly as unverified-at-mint.
          const verify: ReceiptVerification = { cmd: process.env.FABULA_VERIFY_CMD || "(run verify_done)", exitCode: null, passed: false, outputTail: "(manual mint — run verify_done for a captured green verification)" }
          if (truncated) verify.outputTail += "\n[diff exceeded the capture cap — receipt minted without a patch file]"
          const manualCwdRel = await gitRootRel(dir)
          if (manualCwdRel) verify.cwd = manualCwdRel
          const mintedAt = safeNow()
          const base = await gitHead(dir)
          const provenance = await enrichedProvenance(sid, s)
          const written = writeReceipt(
            dir,
            (patch) => renderReceiptMarkdown(buildReceipt({ state: s, verify, diff, workdir: dir, mintedAt, patchPath: patch, base, provenance })),
            (patch) => renderReceiptJSON(buildReceipt({ state: s, verify, diff, workdir: dir, mintedAt, patchPath: patch, base, provenance })),
            diff,
            truncated,
          )
          if (!written) return "mint_receipt: FAILED — could not write to .fabula/receipts/ (permissions? disk?). No receipt exists."
          const r = buildReceipt({ state: s, verify, diff, workdir: dir, mintedAt, patchPath: written.patchRel, base, provenance })
          return `📄 Receipt written → ${written.rel}\n${receiptSummary(r)}\n\nNote: this is a MANUAL mint (no captured green verify). Run verify_done for a receipt that carries a passing verification.`
        },
      }),
    },
  }))
