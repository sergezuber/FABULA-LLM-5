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
import { existsSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, dirname } from "node:path"
import { homedir, tmpdir } from "node:os"
import { gate } from "./lib/manage"
import { snapshot, restore } from "./lib/checkpoint"
import { initRewind, updateRewind, RewindState } from "./lib/rewind"
import { escalationDecision, attemptCost } from "./lib/risk"
import { looksLikeVerifyCommand, verdictFromTestOutput } from "./lib/verifycmd"
import { qeVerdict, qeBlocksRetry } from "./lib/qe"
import { secondOpinion } from "./lib/escalate"
import { appendDecision, initLedger, askLedgerPath as sharedLedgerPath, type AskLedger } from "./lib/askledger"
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
const disabled = () => process.env.FABULA_AUTO_REWIND === "0"

// The whole-tree checkpoint restores files that EXISTED at the green snapshot but cannot know about
// files created after it — a new broken test/module would survive a rewind and keep the verify red for
// a reason the model was told is gone. So the plugin watches edit tools (shared EDIT_TOOLS/editPaths,
// one source of truth) AND common bash file-creating redirects, remembering which paths did NOT exist
// before the tool ran (= creations since the last green); a rewind deletes exactly those.

const states = new Map<string, RewindState>()
const createdSince = new Map<string, Set<string>>() // sid → workspace-relative paths created after the last green
// W2 evidence, all reset on a green verify:
const editedSince = new Map<string, Set<string>>()   // sid → edited source paths since last green (#2 diagnosis)
const editCounts = new Map<string, Map<string, number>>() // sid → path → how many times it was edited (W6 churn)
const sidefxSince = new Map<string, SideEffect[]>()   // sid → non-idempotent effects since last green (#3 ledger)
const greenPending = new Map<string, boolean>()       // sid → capture the conversation boundary at the next transform
const greenBoundary = new Map<string, string>()       // sid → max message id present at the last green (#1 boundary)
const pendingRewind = new Map<string, string>()       // sid → the summary to collapse the failed span to (#1)
const collapseMisses = new Map<string, number>()      // sid → transcript collapses that could NOT be applied

/** Sessions already told, once, that their transcript could not be cleaned. */
const contaminationTold = new Set<string>()

/**
 * Say — where the model will actually read it — that the failed attempts are STILL in the context.
 *
 * The steer written when the rewind fires cannot know this. It is composed in `tool.execute.after`, and
 * the collapse is attempted later, in this transform: at steer time the outcome is simply not available,
 * so any claim about the transcript there is a guess. On the FIRST rewind the guess is always "clean",
 * because nothing has missed yet — which is precisely the run where a miss goes unannounced and the model
 * retries inside the contaminated context this mechanism exists to remove.
 *
 * So the claim is made where the outcome is known. Once per session, because a note repeated on every
 * turn becomes furniture the model stops reading, and it is appended to the LAST message — the one the
 * model reads immediately before deciding what to do next.
 */
function noteContaminated(sid: string, messages: any[], reason?: string): void {
  if (contaminationTold.has(sid)) return
  const last = messages[messages.length - 1]
  const parts = last?.parts
  if (!Array.isArray(parts)) return
  const text =
    `\n\n<system-reminder>The failed attempts could NOT be removed from this conversation` +
    `${reason ? ` (${reason})` : ""} — they are still above. The FILES were rolled back to the last state` +
    ` that passed; the transcript was not. Treat everything after the last green verification as` +
    ` discarded, and do not re-read it as if it described the current tree.</system-reminder>`
  const t = [...parts].reverse().find((p: any) => typeof p?.text === "string")
  if (!t) return
  t.text += text
  contaminationTold.add(sid)
}
// W6 escalation economics, all reset on a green verify:
const streakStart = new Map<string, number>()         // sid → when the current red streak began (wall-clock cost)
const escalations = new Map<string, number>()         // sid → second opinions actually DELIVERED this task
const escalationTries = new Map<string, number>()     // sid → attempts that came back empty (a dead endpoint)
const shellReds = new Map<string, number>()            // sid → failed suites seen through the shell (advisory only)
const BASH_TOOLS = new Set(["bash", "bash_tool", "shell", "execute_code"])
function editedFor(sid: string): Set<string> { let s = editedSince.get(sid); if (!s) { s = new Set(); editedSince.set(sid, s) } return s }
/** Record that `path` was edited again. The Set above answers "which files"; this answers "how often",
 *  which is the question the churn feature actually asks. */
function noteEdit(sid: string, p: string): void {
  let m = editCounts.get(sid)
  if (!m) { m = new Map(); editCounts.set(sid, m) }
  m.set(p, (m.get(p) ?? 0) + 1)
}
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
// ── W6 helpers ──────────────────────────────────────────────────────────────────────────────────────
// How many second opinions one task may buy. Escalation spends against a paid endpoint, so "ask when
// stuck" must not become "ask on every red" — an unbounded feedback edge is the exact class W4 spent a
// whole wave removing.
/** An explicitly set 0 MEANS zero — it is how the owner turns a budget off. Only a value that is not a
 *  number at all falls back to the default. (Three knobs here each treated "explicitly zero" differently
 *  before: one disabled, one silently became 8000, one silently became 32 — the same reflex that once had
 *  a "protect the user" default overriding an explicit XDG_DATA_HOME.) */
const envInt = (name: string, fallback: number): number => {
  const raw = (process.env[name] ?? "").trim()
  if (raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}
const maxEscalations = () => envInt("FABULA_ESCALATE_MAX", 2)
// Kill-switch: with this off the harness goes back to asking the model in prose, and buys nothing.
// Read at CALL time, not at module load. Captured in a top-level const, this switch became unreachable
// the moment the module was imported: no test could turn the mechanism back on, so the harness-fired
// second opinion — a shipped mechanism of the previous wave — silently lost its entire test coverage the
// day something set the variable before import. A kill-switch that can only ever be read once is a
// build-time constant wearing an env var's name.
const escalateAuto = () => String(process.env.FABULA_ESCALATE_AUTO ?? "1").trim().toLowerCase() !== "0"
const qeEnabled = () => String(process.env.FABULA_QE ?? "1").trim().toLowerCase() !== "0"
// How long the harness will WAIT for that second opinion. Deliberately short: this escalation is an
// enhancement to a turn that is already in trouble, not a dependency of it. The agent is blocked while
// we wait, so a cloud that is slow or hung must cost seconds and then be forgotten — the alternative is
// a harness that wedges the user's turn on someone else's outage.
/** How many FAILED attempts one task will make before giving up on the endpoint entirely. */
const maxEscalationTries = () => envInt("FABULA_ESCALATE_TRIES", 3)
const escalateTimeoutMs = () => envInt("FABULA_ESCALATE_TIMEOUT_MS", 8000)

// The path resolver is SHARED with the report tool — a local copy had already drifted, so under a test
// runner the hook wrote one file while the reader read another.
const askLedgerPath = () => sharedLedgerPath(process.env as Record<string, string | undefined>)

/** Append one escalation decision — FIRED or NOT — so the harness can later be scored on when it asks
 *  for help (Ask-F1). Recording only the times we escalated would make the metric unfalsifiable: the
 *  decisions NOT to ask are half the evidence. Never throws; a ledger failure must cost the run nothing. */
function recordAsk(sid: string, verdict: { decision: string; score: number; reason: string }, features: Record<string, unknown>, fired: boolean, failure?: string) {
  try {
    const file = askLedgerPath()
    let ledger: AskLedger
    try {
      ledger = JSON.parse(readFileSync(file, "utf8"))
    } catch {
      ledger = initLedger()
    }
    const next = appendDecision(ledger, {
      id: `ask_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
      ts: safeNow(),
      sessionID: sid,
      decision: verdict.decision,
      fired,
      // The outcome is NOT known yet and is deliberately left null: guessing it here would be the
      // "unknown counted as success" lie the metric exists to avoid.
      helped: null,
      score: verdict.score,
      reason: failure ? `${verdict.reason} (escalation attempted but ${failure})` : verdict.reason,
      features,
    })
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(next))
  } catch {
    /* the ledger is observability, never a dependency of the run */
  }
}

/** Fetch the second opinion. Returns null on ANY failure — no cloud configured, bad key, timeout, HTTP
 *  error — because a failed escalation must be indistinguishable from one that was never attempted. */
async function askCloud(features: Record<string, unknown>, note: string, tried: string[]): Promise<string | null> {
  try {
    const cfgPath = process.env.MIMOCODE_CONFIG || join(process.cwd(), "fabula.config.json")
    let config: unknown = null
    try {
      config = JSON.parse(readFileSync(cfgPath, "utf8"))
    } catch {
      config = null
    }
    const res = await secondOpinion(
      {
        task: `A coding task in this workspace keeps failing its verification. Latest failure: ${note || "(no error line captured)"}`,
        tried: tried.length ? tried.map((t, i) => `(${i + 1}) ${t}`).join("; ") : undefined,
        context: `Harness evidence: ${JSON.stringify(features)}`,
      },
      {
        config,
        env: process.env as Record<string, string | undefined>,
        readFile: (p: string) => readFileSync(p, "utf8"),
        timeoutMs: escalateTimeoutMs(),
      },
    )
    return res.ok && res.answer ? res.answer : null
  } catch {
    return null
  }
}

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
    if (disabled()) return
    try {
      const tool = hookInput?.tool
      const paths = EDIT_TOOLS.has(tool)
        ? editPaths(tool, hookInput?.args)
        : (tool === "bash" || tool === "bash_tool") ? bashCreatedPaths(hookInput?.args) : []
      if (!paths.length) return
      const sid = hookInput?.sessionID || "?"
      const workspace = input?.directory || process.cwd()
      evictOthers(createdSince, sid)
      if (EDIT_TOOLS.has(tool)) {
        if (!streakStart.has(sid)) streakStart.set(sid, safeNow()) // the attempt's cost clock (see above)
        for (const p of paths) { editedFor(sid).add(p); noteEdit(sid, p) } // #2 diagnosis + W6 churn
      }
      for (const p of paths) {
        const abs = isAbsolute(p) ? p : join(workspace, p)
        const rel = relative(workspace, abs)
        if (rel.startsWith("..")) continue // outside the workspace — not ours to delete later
        if (!existsSync(abs)) createdFor(sid).add(rel)
      }
    } catch {}
  },

  "tool.execute.after": async (hookInput: any, output: any) => {
    if (disabled() || !output) return
    try {
      const toolName = hookInput?.tool
      // Accumulate the rewind EVIDENCE during the red window (reset on a green verify): which source files
      // the attempts edited (#2 diagnosis attribution) + which calls had non-idempotent side effects (#3).
      if (toolName && toolName !== "verify_done") {
        const sid0 = hookInput?.sessionID || "?"
        if (EDIT_TOOLS.has(toolName)) {
          // The attempt's clock starts with the WORK, not with the failure. It used to start on the first
          // red — so `elapsedMs` was `now − now ≈ 0` at exactly the moment the early rung consults it, and
          // the "how much has this attempt already cost" signal could never speak on the only red where
          // it is asked. Three redesigns of the score never fixed that, because it was never the score.
          if (!streakStart.has(sid0)) streakStart.set(sid0, safeNow())
          for (const p of editPaths(toolName, hookInput?.args)) { editedFor(sid0).add(p); noteEdit(sid0, p) }
        }
        const fx = nonIdempotentEffect(toolName, hookInput?.args)
        if (fx) fxFor(sid0).push(fx)
        // A test suite run through the SHELL is still a verification. Everything below keys on
        // `verify_done`, so a model that types `npm test` into bash produced no streak, no rewind, no
        // escalation and no ledger record — the run looked healthy because nothing was watching, and the
        // decision corpus quietly became a sample of one testing style. Recognised conservatively (see
        // `looksLikeVerifyCommand`): a false positive here could push a healthy run toward giving up.
        if (BASH_TOOLS.has(toolName) && looksLikeVerifyCommand(String(hookInput?.args?.command ?? hookInput?.args?.cmd ?? ""))) {
          const text = typeof output?.output === "string" ? output.output : ""
          const v = verdictFromTestOutput(text, typeof output?.metadata?.exitCode === "number" ? output.metadata.exitCode : null)
          // ONLY a red is actionable from a shell, and it feeds a SEPARATE counter.
          //
          // Two things were wrong when this first landed. It trusted a "green" inferred from text — the
          // engine supplies no exit code for bash — and this repository's own runner prints `1732 pass
          // 3 fail` on a FAILING suite, so a broken run reset the streak, cleared the notes and refunded
          // the rewind budget. And it wrote into the SAME state `verify_done` drives, which silently
          // halved constants calibrated against verify_done events: a model that runs pytest before
          // verify_done was rewound after ONE real failure and reached NOT DONE in two instead of four.
          // The spec-card calls that rewind threshold untouchable; adding a second event source to its
          // counter touched it from the other side.
          //
          // So: shell evidence informs the ADVISORY escalation decision and the ledger, and never the
          // rewind/terminal ladder. Observing is worth doing; deciding a revert on a guess is not.
          if (v === "red") {
            const n = (shellReds.get(sid0) ?? 0) + 1
            shellReds.set(sid0, n)
            if (!streakStart.has(sid0)) streakStart.set(sid0, safeNow())
            const cs = editCounts.get(sid0)
            const shellRisk = {
              redStreak: n,
              sameFileChurn: cs ? [...cs.values()].reduce((a, k) => a + Math.max(0, k - 1), 0) : 0,
              elapsedMs: attemptCost({ elapsedMs: Math.max(0, safeNow() - (streakStart.get(sid0) ?? safeNow())) }),
            }
            const shellVerdict = escalationDecision(shellRisk)
            recordAsk(sid0, shellVerdict, { ...shellRisk, via: "shell" }, false)
            if (shellVerdict.decision !== "continue-locally" && typeof output.output === "string") {
              output.output +=
                `\n\n⚖ FABULA saw ${n} failed verification(s) run through the shell. ${shellVerdict.reason}` +
                ` Run \`verify_done\` so the harness can act on it — from bash it can only watch.`
            }
          }
        }
        return
      }
      const sid = hookInput?.sessionID || "?"
      evictOthers(states, sid)
      for (const m of [editedSince, editCounts, sidefxSince, greenBoundary, pendingRewind, greenPending, collapseMisses, streakStart, escalations, escalationTries, shellReds] as Map<string, unknown>[]) evictOthers(m, sid)
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
        editedSince.set(sid, new Set()); sidefxSince.set(sid, []); editCounts.delete(sid) // fresh evidence window after green
        streakStart.delete(sid)   // W6: the cost clock belongs to a streak, and this streak is over
        collapseMisses.delete(sid) // a green is a fresh conversation window too
        contaminationTold.delete(sid) // …so a later contamination must be announced again
        greenPending.set(sid, true)      // capture the conversation boundary at the next transform
        pendingRewind.delete(sid)        // a green recovered the run — nothing to collapse
        return
      }

      // RED verify — advance the streak; may trigger a rewind or the terminal NOT DONE verdict.
      const note = extractNote(output)
      const prev = stateFor(sid)
      const { state, action } = updateRewind(prev, { green: false, note }, THRESHOLD, NOTDONE_AFTER)
      states.set(sid, state)

      // ── W6: DECIDE whether to ask a stronger model, and if so, ASK. ────────────────────────────
      // Until W6 this was a sentence in a steer hoping the model would call escalate_to_cloud; RULE #9
      // says an observation that a model will not reliably do X is a specification for a mechanism.
      // The decision is made from measured evidence (how many reds, thrashing on the same file, how
      // much wall-clock this streak has already cost, how many times we already reverted) rather than
      // from the bare counter — and it is bounded, never fires on a green, and never blocks the run.
      if (!streakStart.has(sid)) streakStart.set(sid, safeNow())
      // TRUE churn: how many times an attempt went BACK to a file it had already changed. The first
      // version passed the count of DISTINCT edited paths, which is the inverse of the contract — a run
      // thrashing one file ten times scored 1, while a healthy broad edit across six files scored 6 and
      // looked like the pathological case.
      const counts = editCounts.get(sid)
      const churn = counts ? [...counts.values()].reduce((a, n) => a + Math.max(0, n - 1), 0) : 0
      // The same failure line coming back is a near-duplicate at the level that matters here: the run is
      // re-arriving at a state it has already been in.
      const notes = state.failedNotes ?? []
      const repeats = notes.length - new Set(notes).size
      const risked = {
        redStreak: prev.redStreak + 1,
        sameFileChurn: churn,
        nearDuplicates: repeats,
        elapsedMs: attemptCost({ elapsedMs: Math.max(0, safeNow() - (streakStart.get(sid) ?? safeNow())) }),
        rewinds: state.rewinds ?? 0,
        hasGreenAnchor: !!state.lastGreenCheckpoint,
      }
      let verdict = escalationDecision(risked)
      // QE's ONLY power: promote "keep trying locally" to "ask now" when another attempt on this diff
      // looks not worth its cost. It can never do the reverse and it never runs near a verify — the
      // estimator gates a RETRY, and verify stays the only source of truth. Fail-open by construction:
      // an unreachable or unreadable estimator leaves the decision exactly as the risk score made it.
      if (verdict.decision === "continue-locally" && risked.redStreak >= 1 && qeEnabled()) {
        try {
          // The REAL streak, not a hard-coded pair. Fabricating "2 failures" put a false count on the
          // wire to the estimator AND into the ledger record that is supposed to be the honest artifact.
          const realHistory = Array.from({ length: risked.redStreak }, () => ({ green: false }))
          const qe = await qeVerdict(String(note || ""), realHistory)
          if (qeBlocksRetry(qe)) {
            verdict = { ...verdict, decision: "escalate", reason: `quality estimate promoted this to an escalation: ${qe.reason}` }
          }
        } catch { /* an estimator that fails must cost the run nothing */ }
      }
      const alreadyAsked = escalations.get(sid) ?? 0
      const triedAndFailed = escalationTries.get(sid) ?? 0
      const mayAsk =
        verdict.decision === "escalate" &&
        alreadyAsked < maxEscalations() &&
        triedAndFailed < maxEscalationTries() &&
        escalateAuto()
      if (mayAsk) {
        escalations.set(sid, alreadyAsked + 1)
        const opinion = await askCloud(risked, note, action?.failedNotes ?? state.failedNotes)
        // `fired` records what HAPPENED, not what was decided. Writing it before the call made the
        // ledger claim escalations that delivered nothing — and Ask-F1, the metric this wave exists to
        // make honest, then scored those non-events as escalations. A call that failed also refunds the
        // budget: two transient timeouts must not permanently exhaust a task's second opinions.
        // Refunding the DELIVERY budget on failure keeps the ledger honest, but it must not turn the
        // cap into "unbounded attempts": against a cloud that always fails, every escalate-rung red
        // would try again and each try costs the blocked turn its timeout. Attempts carry their own,
        // larger bound so a broken endpoint is tried a few times and then left alone.
        if (!opinion) {
          escalations.set(sid, alreadyAsked)
          escalationTries.set(sid, (escalationTries.get(sid) ?? 0) + 1)
        }
        recordAsk(sid, verdict, risked, !!opinion, opinion ? undefined : "the cloud returned nothing")
        if (opinion && typeof output.output === "string") {
          // Planted on the tool result the model just read — the steer pattern this harness has
          // measured the model actually acts on, unlike a nudge buried in the prompt.
          output.output += `\n\n🛰️ SECOND OPINION (fetched by the harness after ${risked.redStreak} failed verification(s) — you did not have to ask):\n${opinion}`
          if (output.metadata && typeof output.metadata === "object")
            (output.metadata as Record<string, unknown>).secondOpinion = { redStreak: risked.redStreak, score: verdict.score }
        }
      } else {
        recordAsk(sid, verdict, risked, false)
      }

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
          // Whether the CONVERSATION can also be rewound is a separate question from whether the FILES
          // were: the transcript collapse needs a green boundary captured by the transform hook. If we
          // never got one — or the last collapse could not match the span — say so plainly instead of
          // implying a clean retry, because the model reads the failed attempts either way and a false
          // "we started over" is worse than no claim at all.
          const canCollapse = greenBoundary.has(sid) && (collapseMisses.get(sid) ?? 0) === 0
          const contextNote = canCollapse
            ? ""
            : ` NOTE: the failed attempts above could NOT be removed from this conversation — they are still` +
              ` in your context. Do not re-read them as if they were current; treat everything after the last` +
              ` green verification as discarded.`
          output.output += `\n\n🔄 AUTO-REWIND${reverted}: ${groundedSteer}${contextNote}`
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
    if (disabled()) return
    // the summarizer must see the TRUE history: collapsing a failed span inside the COMPACTION build
    // would hide it from the summary and desync the boundary state machine (same input flag as the
    // steer hooks — the engine marks the summarizer build)
    if ((_input as any)?.compaction === true) return
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
        const res = collapseFailedSpan(messages, boundary, summary)
        // Only a collapse that ACTUALLY happened retires the request. The core reports `applied` and the
        // first version of this call threw that away: when the span could not be matched the transcript
        // kept every failed attempt while the model had already been told the run was back at green —
        // the retry then ran in exactly the contaminated context this mechanism exists to remove, and
        // nothing anywhere said so. A failed collapse now stays pending and is retried next transform.
        if (res.applied) pendingRewind.delete(sid)
        else {
          collapseMisses.set(sid, (collapseMisses.get(sid) ?? 0) + 1)
          noteContaminated(sid, messages, res.reason)
        }
      } else if (summary && !boundary) {
        collapseMisses.set(sid, (collapseMisses.get(sid) ?? 0) + 1)
        noteContaminated(sid, messages, "no green boundary was captured")
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
