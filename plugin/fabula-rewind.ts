// FABULA-LLM-5 — auto-rewind on repeated verify failure (LOCK 4: the harness reverts, not the model).
// When the model keeps editing and each attempt leaves the verify RED, it is digging the hole deeper.
// This plugin makes the HARNESS take over: on a GREEN verify_done it snapshots the good state; after
// FABULA_REWIND_THRESHOLD consecutive RED verifies with no green between, it atomically restores the
// files to that last-green checkpoint (via the shadow-git store — the real .git is never touched) and
// plants a steer on the verify result telling the model what its failed attempts were, so it takes a
// DIFFERENT approach instead of repeating them. Decision logic is pure + unit-tested in lib/rewind.ts.
//
// Why a hook and not a skill (RULE #9): a local model will not reliably notice "I'm looping on the same
// failing edit" and revert itself. The harness must do it deterministically — this fires on every RED.
//
// Scope note: this rewinds FILES atomically (the shadow-git checkpoint the plugin captured at the last
// green). A true atomic rewind of the CONVERSATION as well needs the engine session tree — separate,
// larger engine work — so the steer summary carries the failed-attempt context forward instead.

import type { Plugin } from "@mimo-ai/plugin"
import { existsSync, unlinkSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { gate } from "./lib/manage"
import { snapshot, restore } from "./lib/checkpoint"
import { initRewind, updateRewind, RewindState } from "./lib/rewind"
import { EDIT_TOOLS, editPaths } from "./lib/edittools"
import { diagnose } from "./lib/diagnose"
import { nonIdempotentEffect, renderLedger, type SideEffect } from "./lib/sidefx"
import { collapseFailedSpan } from "./lib/convrewind"

const THRESHOLD = (() => {
  const n = parseInt(process.env.FABULA_REWIND_THRESHOLD ?? "", 10)
  return Number.isFinite(n) && n >= 1 ? n : 2
})()
const NOTDONE_AFTER = (() => {
  const n = parseInt(process.env.FABULA_NOTDONE_THRESHOLD ?? "", 10)
  return Number.isFinite(n) && n >= 1 ? n : 4
})()
const DISABLED = process.env.FABULA_AUTO_REWIND === "0"

// The whole-tree checkpoint restores files that EXISTED at the green snapshot but cannot know about
// files created after it — a new broken test/module would survive a rewind and keep the verify red for
// a reason the model was told is gone. So the plugin watches edit tools (shared EDIT_TOOLS/editPaths,
// one source of truth) AND common bash file-creating redirects, remembering which paths did NOT exist
// before the tool ran (= creations since the last green); a rewind deletes exactly those.

const states = new Map<string, RewindState>()
const createdSince = new Map<string, Set<string>>() // sid → workspace-relative paths created after the last green
// W2 evidence, all reset on a green verify:
const editedSince = new Map<string, Set<string>>()   // sid → edited source paths since last green (#2 diagnosis)
const sidefxSince = new Map<string, SideEffect[]>()   // sid → non-idempotent effects since last green (#3 ledger)
const greenPending = new Map<string, boolean>()       // sid → capture the conversation boundary at the next transform
const greenBoundary = new Map<string, string>()       // sid → max message id present at the last green (#1 boundary)
const pendingRewind = new Map<string, string>()       // sid → the summary to collapse the failed span to (#1)
function editedFor(sid: string): Set<string> { let s = editedSince.get(sid); if (!s) { s = new Set(); editedSince.set(sid, s) } return s }
function fxFor(sid: string): SideEffect[] { let a = sidefxSince.get(sid); if (!a) { a = []; sidefxSince.set(sid, a) } return a }
function stateFor(sid: string): RewindState {
  let s = states.get(sid)
  if (!s) { s = initRewind(); states.set(sid, s) }
  return s
}
function createdFor(sid: string): Set<string> {
  let c = createdSince.get(sid)
  if (!c) { c = new Set(); createdSince.set(sid, c) }
  return c
}
// Bound the maps without nuking the ACTIVE session mid-streak (a wiped state loses the green anchor
// and can later mint a false "none has ever passed" verdict).
function evictOthers(map: Map<string, unknown>, keep: string) {
  if (map.size <= 500) return
  for (const k of map.keys()) {
    if (k === keep) continue
    map.delete(k)
    if (map.size <= 500) break
  }
}

// Best-effort file targets of a bash command: `> f`, `>> f`, `| tee f`, `cat > f <<EOF`. Not a shell
// parser — it catches the common create-a-file idioms agents use (heredocs, tee) so a bash-created
// broken file doesn't survive a rewind while the model is told the tree is back at green. Exotic bash
// creations (sed -i on a new path, scripts) remain a documented gap, same as bash source edits.
function bashCreatedPaths(args: any): string[] {
  const cmd = args?.command ?? args?.cmd ?? args?.script
  if (typeof cmd !== "string" || !cmd) return []
  const out: string[] = []
  for (const m of cmd.matchAll(/(?:>>?|\btee(?:\s+-a)?)\s+(['"]?)([^\s'"|;&>]+)\1/g)) {
    const p = m[2]
    if (p && p !== "/dev/null" && !p.startsWith("/dev/")) out.push(p)
  }
  return out
}

let _seq = 0
function nextId(): string {
  const t = (() => { try { return Date.now() } catch { return 0 } })()
  return `rewind_${t}_${++_seq}`
}
function safeNow(): number { try { return Date.now() } catch { return 0 } }

export const FabulaRewind: Plugin = async (input: any) => gate("rewind", ({
  // Watch edits BEFORE they run: a path that doesn't exist yet is a creation — remember it so a
  // rewind can remove it (the whole-tree checkpoint alone can't).
  "tool.execute.before": async (hookInput: any) => {
    if (DISABLED) return
    try {
      const tool = hookInput?.tool
      const paths = EDIT_TOOLS.has(tool)
        ? editPaths(tool, hookInput?.args)
        : (tool === "bash" || tool === "bash_tool") ? bashCreatedPaths(hookInput?.args) : []
      if (!paths.length) return
      const sid = hookInput?.sessionID || "?"
      const workspace = input?.directory || process.cwd()
      evictOthers(createdSince, sid)
      if (EDIT_TOOLS.has(tool)) for (const p of paths) editedFor(sid).add(p) // #2 diagnosis file attribution
      for (const p of paths) {
        const abs = isAbsolute(p) ? p : join(workspace, p)
        const rel = relative(workspace, abs)
        if (rel.startsWith("..")) continue // outside the workspace — not ours to delete later
        if (!existsSync(abs)) createdFor(sid).add(rel)
      }
    } catch {}
  },

  "tool.execute.after": async (hookInput: any, output: any) => {
    if (DISABLED || !output) return
    try {
      const toolName = hookInput?.tool
      // Accumulate the rewind EVIDENCE during the red window (reset on a green verify): which source files
      // the attempts edited (#2 diagnosis attribution) + which calls had non-idempotent side effects (#3).
      if (toolName && toolName !== "verify_done") {
        const sid0 = hookInput?.sessionID || "?"
        if (EDIT_TOOLS.has(toolName)) for (const p of editPaths(toolName, hookInput?.args)) editedFor(sid0).add(p)
        const fx = nonIdempotentEffect(toolName, hookInput?.args)
        if (fx) fxFor(sid0).push(fx)
        return
      }
      const sid = hookInput?.sessionID || "?"
      evictOthers(states, sid)
      for (const m of [editedSince, sidefxSince, greenBoundary, pendingRewind, greenPending] as Map<string, unknown>[]) evictOthers(m, sid)
      const workspace = input?.directory || process.cwd()

      // "Verify never ran" (no command detected, spawn error → plain-string result, no `passed` key)
      // must not advance the streak: conflating not-run with failed can revert correct in-progress
      // edits or mint a terminal NOT DONE over configuration, not over failed checks.
      const passed = output?.metadata?.passed
      if (passed !== true && passed !== false) return

      if (passed === true) {
        // Capture the good state so we can return to it if later edits regress.
        let ckId: string | undefined
        try {
          const entry = snapshot(workspace, null, { id: nextId(), ts: safeNow(), label: "green verify", tool: "verify_done" })
          ckId = entry && !entry.skipped ? entry.id : undefined
        } catch { /* snapshot best-effort */ }
        const { state } = updateRewind(stateFor(sid), { green: true, checkpoint: ckId }, THRESHOLD)
        states.set(sid, state)
        createdSince.set(sid, new Set()) // everything on disk is now part of the green state
        editedSince.set(sid, new Set()); sidefxSince.set(sid, []) // fresh evidence window after green
        greenPending.set(sid, true)      // capture the conversation boundary at the next transform
        pendingRewind.delete(sid)        // a green recovered the run — nothing to collapse
        return
      }

      // RED verify — advance the streak; may trigger a rewind or the terminal NOT DONE verdict.
      const note = extractNote(output)
      const prev = stateFor(sid)
      const { state, action } = updateRewind(prev, { green: false, note }, THRESHOLD, NOTDONE_AFTER)
      states.set(sid, state)
      if (!action) return

      // Terminal rung (Greenpaper §2): the ladder is exhausted — surface an explicit NOT DONE verdict
      // instead of letting the run spin or stop silently. A later green still recovers the run.
      if (action.type === "notdone") {
        if (typeof output.output === "string") {
          const tried = action.failedNotes.length
            ? ` What was tried: ${action.failedNotes.map((n, i) => `(${i + 1}) ${n}`).join("; ")}.`
            : ""
          output.output +=
            `\n\n❌ NOT DONE — terminal verdict: ${action.reason}${tried}` +
            ` Stop iterating on this approach. Report honestly to the user what was attempted and what still fails` +
            ` (mint_receipt attaches the evidence); if you haven't yet, escalate_to_cloud may offer a different root cause.` +
            ` Do not claim success — done is a proof, not a feeling.`
          if (output.metadata && typeof output.metadata === "object")
            output.metadata.notDone = { reason: action.reason, redStreak: action.redStreak }
        }
        return
      }

      // LOCK 4: revert the files to the last known-good checkpoint, then steer. The summary claims
      // "files are back at the last green" — that claim must only ship when the restore SUCCEEDED
      // (no per-path checkout failure), else the model reasons from a green baseline that doesn't exist.
      let restored = false
      let reverted = ""
      let removedCount = 0
      try {
        const r = restore(workspace, action.toCheckpoint)
        // Success requires: no ledger error AND no swallowed per-path failure AND something actually
        // happened (a non-empty green tree that moved zero bytes = the workspace was unwritable).
        const didWork = r.restored.length + r.deleted.length > 0
        const emptyTree = r.treePaths.length === 0
        if (!r.error && r.failed.length === 0 && (didWork || emptyTree)) {
          restored = true
          // The checkpoint restores green-tree files; a file that was in the green tree, deleted, then
          // re-created during the red streak is ALREADY back via restore — never unlink those. Only
          // remove creations that are NOT part of the green state.
          const greenTree = new Set(r.treePaths)
          for (const rel of createdFor(sid)) {
            if (greenTree.has(rel)) continue
            try {
              const abs = join(workspace, rel)
              if (existsSync(abs)) { unlinkSync(abs); removedCount++ }
            } catch {}
          }
          createdSince.set(sid, new Set())
          const bits: string[] = []
          if (r.restored.length) bits.push(`${r.restored.length} file(s) restored`)
          if (r.deleted.length + removedCount) bits.push(`${r.deleted.length + removedCount} newly-created file(s) removed`)
          reverted = bits.length ? ` (${bits.join(", ")})` : ""
        }
      } catch { /* restore failed — handled honestly below */ }

      // #2 grounded root-cause steer + #3 side-effect ledger REPLACE the generic summary; #1 sets the
      // conversation-collapse summary so the retry runs in near-clean context (the 7× contamination fix).
      const evFiles = [...editedFor(sid)]
      const grounded = diagnose((action as any).failedNotes ?? [], evFiles)
      const ledger = renderLedger(sidefxSince.get(sid) ?? [])
      const groundedSteer =
        `Reverted your last ${action.redStreak} change(s); files are back at the last state that passed verify. ` +
        `${grounded}${ledger} Take a DIFFERENT approach — do not repeat the reverted edits; if it also fails, call escalate_to_cloud for a second opinion.`

      if (typeof output.output === "string") {
        if (restored) {
          output.output += `\n\n🔄 AUTO-REWIND${reverted}: ${groundedSteer}`
          pendingRewind.set(sid, `🔄 Rewound ${action.redStreak} failed attempt(s) to the last green state; files are back at green. ${grounded}${ledger} Take a DIFFERENT approach.`)
          if (output.metadata && typeof output.metadata === "object")
            output.metadata.autoRewind = { toCheckpoint: action.toCheckpoint, reverted: action.redStreak }
        } else {
          // The checkpoint restore failed (wiped store, pruned objects, unwritable tree). Saying
          // "files are back" would make the model reason from a green baseline that does not exist —
          // and the receipt would record a rewind gate that never fired. Tell the truth and refund the
          // budget. Keep the anchor: a green verify DID happen, so a later terminal verdict must NOT
          // claim "none has ever passed"; mark the anchor unusable so we don't retry the dead store.
          states.set(sid, { ...state, rewinds: Math.max(0, (state.rewinds ?? 1) - 1), lastGreenCheckpoint: undefined, hadGreen: true })
          output.output +=
            `\n\n⚠️ AUTO-REWIND attempted but the checkpoint store is unavailable — files were NOT reverted.` +
            ` Your last ${action.redStreak} attempt(s) are still on disk and still failing; fix forward or undo them yourself.`
        }
      }
    } catch { /* never break the verify tool */ }
  },

  // #1 conversation-tree rewind — the failed-attempt transcript must leave the context so the retry runs
  // in near-clean context (arXiv:2605.08563: contaminated retry = ~7× error). The engine passes the wire
  // messages by reference (session/prompt.ts:3172) with input {} (no sessionID) — derive it from the
  // messages. Capture the green boundary at the FIRST transform after a green verify; on a pending rewind,
  // collapse the failed span (id > boundary) into ONE summary. Honest degrade: no boundary → no mutation.
  "experimental.chat.messages.transform": async (_input: any, output: any) => {
    if (DISABLED) return
    try {
      const messages = output?.messages
      if (!Array.isArray(messages) || !messages.length) return
      const sid = messages.find((m: any) => m?.info?.sessionID)?.info?.sessionID
      if (!sid) return
      if (greenPending.get(sid)) {
        let maxId = ""
        for (const m of messages) { const id = m?.info?.id; if (typeof id === "string" && id > maxId) maxId = id }
        if (maxId) greenBoundary.set(sid, maxId)
        greenPending.set(sid, false)
      }
      const summary = pendingRewind.get(sid)
      const boundary = greenBoundary.get(sid)
      if (summary && boundary) {
        collapseFailedSpan(messages, boundary, summary)
        pendingRewind.delete(sid) // one collapse per rewind (idempotent)
      }
    } catch { /* never break the turn */ }
  },
}))

// Pull a one-line reason out of the verify result so the summary tells the model what actually failed.
// Pull the MOST INFORMATIVE failure line (PROBE / AgentDebug: structured evidence beats the first match).
// A generic summary line ("FAILED (1 failed)") is worthless for a diagnosis — prefer a SPECIFIC named
// error / expectation, falling back to any failure line, then the first line.
function extractNote(output: any): string | undefined {
  const s = typeof output?.output === "string" ? output.output : ""
  if (!s) return undefined
  const lines = s.split("\n").map((l: string) => l.trim()).filter(Boolean)
  const specific = lines.find((l: string) =>
    /\b\w*(Error|Exception)\b\s*:|expected\b[^\n]*\b(got|but|to)\b|\bassert\w*\b[^\n]*[:=]|no module named|cannot find module|is not a function|has no attribute|timed? ?out\b|syntax ?error/i.test(l))
  const generic = lines.find((l: string) => /fail|error|✗|❌|traceback/i.test(l))
  const pick = specific || generic || lines[0] || ""
  return pick ? pick.slice(0, 200) : undefined
}
