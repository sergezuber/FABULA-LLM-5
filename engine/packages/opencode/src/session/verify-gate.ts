// Force-verify gate logic (pure). The done-gate problem (measured 2026-07-09 on SWE-bench Pro): a local
// model edits SOURCE, produces a plausible-but-unverified patch, and finishes WITHOUT ever calling
// `verify_done` — so the harness never runs the tests. A one-time prompt nudge is ignored (RULE #9: an
// unreliable model behavior is a spec for a MECHANISM, not a nudge). This module decides, from a turn's
// message/part stream, whether the model has UNVERIFIED source edits at the moment it tries to stop — the
// engine then force-re-enters (see SessionPrompt.autoContinueUnverified) demanding a verify before "done".
//
// Pure + fully unit-tested; the engine wiring (transcript, fs detect, reminder injection, cap) lives in
// prompt.ts and mirrors the existing continuation contracts (autoContinueOutputLength / goalGate).

/** Tools that mutate SOURCE (engine built-ins + FABULA plugin variants). A turn with any of these,
 *  not followed by a green verify, is "unverified". Reads/greps/globs are NOT edits; a `bash` call IS
 *  an edit when its command mutates the tree (see bashEditsTree) — else a local model can patch source
 *  via the shell, stop, and never trip the force-verify gate (the hole this closes). */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "multiedit",
  "write",
  "apply_patch",
  "str_replace",
  "str-replace",
  "patch",
  "create_file",
  "notebook-edit",
  "notebook_edit",
])

const BASH_TOOLS: ReadonlySet<string> = new Set(["bash", "bash_tool"])

/** True iff a bash command mutates files in the tree (redirect/tee to a real file, or an in-place /
 *  apply idiom). MIRROR of plugin/lib/edittools.ts bashEditsTree — keep the two in sync. Heuristic,
 *  conservative: a false positive only forces a (safe) verify. */
export function bashEditsTree(command: string | undefined | null): boolean {
  if (typeof command !== "string" || !command) return false
  for (const m of command.matchAll(/(?:>>?|\btee(?:\s+-a)?)\s+(['"]?)([^\s'"|;&>]+)\1/g)) {
    const p = m[2]
    if (p && !p.startsWith("/dev/") && !/^\d+$/.test(p)) return true
  }
  return /\b(?:sed\s+(?:-\S+\s+)*-i|perl\s+(?:-\S+\s+)*-i|ruby\s+(?:-\S+\s+)*-i)\b/.test(command)
    || /\bgit\s+apply\b/.test(command)
    || /\bpatch\b[^|]*<|\bpatch\s+(?:-\S+\s+)*-i\b/.test(command)
}

/** One normalized event from the transcript, in chronological order. */
export type TurnEvent =
  | { type: "boundary" } // a REAL user turn (not a synthetic continuation) — resets the scan
  | { type: "edit" } // a source-editing tool call
  | { type: "verify-green" } // a verify_done that passed (or an explicit green verify)

/**
 * Does the model have unverified source edits at stop time?
 * Scan from the LAST real-user boundary forward: true iff there is at least one `edit` that is NOT
 * followed by a `verify-green`. A green verify clears everything before it; a later edit re-dirties.
 * No edits (read-only / Q&A turn) → false, so pure-chat turns are never gated.
 */
export function hasUnverifiedSourceEdits(events: readonly TurnEvent[]): boolean {
  let dirty = false
  for (const e of events) {
    if (e.type === "boundary") dirty = false
    else if (e.type === "verify-green") dirty = false
    else if (e.type === "edit") dirty = true
  }
  return dirty
}

/** Minimal message shape needed to extract events (structural subset of MessageV2). */
export interface ScanMessage {
  role: "user" | "assistant" | string
  parts: ReadonlyArray<{
    type: string
    tool?: string
    synthetic?: boolean
    metadata?: { passed?: boolean; autoRewind?: unknown; notDone?: unknown } | null
    /** tool input (only `command` is read, for bash edit detection) */
    input?: { command?: string } | null
  }>
}

/** Is this user message a REAL turn boundary (the human/task prompt) vs a synthetic continuation
 *  (output-length / goal / verify reminder)? Real = has at least one non-synthetic part. */
export function isRealUserBoundary(msg: ScanMessage): boolean {
  if (msg.role !== "user") return false
  return msg.parts.some((p) => !p.synthetic)
}

/** Extract the chronological TurnEvent stream from a transcript (already in order, oldest→newest). */
export function turnEvents(messages: readonly ScanMessage[]): TurnEvent[] {
  const out: TurnEvent[] = []
  for (const m of messages) {
    if (isRealUserBoundary(m)) {
      out.push({ type: "boundary" })
      continue
    }
    if (m.role !== "assistant") continue
    for (const p of m.parts) {
      if (p.type !== "tool" || !p.tool) continue
      if (p.tool === "verify_done" && p.metadata?.passed === true) out.push({ type: "verify-green" })
      else if (EDIT_TOOLS.has(p.tool)) out.push({ type: "edit" })
      else if (BASH_TOOLS.has(p.tool) && bashEditsTree(p.input?.command)) out.push({ type: "edit" })
    }
  }
  return out
}

/** Convenience: unverified source edits directly from a transcript. */
export function needsForcedVerify(messages: readonly ScanMessage[]): boolean {
  return hasUnverifiedSourceEdits(turnEvents(messages))
}

/**
 * Is this turn's answer TERMINAL — i.e. there is no verifiable artifact to gate,
 * so the goal judge must NOT be called and the stop must be honored? (Change 1,
 * PRIMARY, stop-layer.) The goal gate is a "prove the work" gate: a turn that
 * needs forcing (unverified source edits) has a verifiable artifact and is NOT
 * terminal; every other turn — a pure Q&A / conversational answer, or a turn
 * whose edits were already verified green — is terminal. SOTA: Agentic Abstention
 * (arXiv:2606.28733) formalizes ANSWER ∈ {ANSWER, ABSTAIN, ACT} as a terminal
 * action distinct from the ACT loop; Calling the verifier loop on a terminal
 * ANSWER (esp. with a same-model judge on a 200k local context) is the root
 * cause of the "answers, then loops and cannot stop" Infinite Agentic Loop
 * (arXiv:2607.01641). Composes needsForcedVerify so the goal gate and the
 * force-verify gate read off the SAME artifact signal — one source of truth.
 */
export function answerIsTerminal(messages: readonly ScanMessage[]): boolean {
  return !needsForcedVerify(messages)
}

/**
 * Should the goal gate's stop-layer short-circuit fire for THIS goal? (Change 1
 * wiring guard.) It fires ONLY for an AUTO-armed goal on a terminal answer:
 *
 *  - AUTO goal (harness-derived condition): a conversational / no-artifact turn
 *    is terminal and must NOT re-enter the judge — that is the Infinite Agentic
 *    Loop this whole fix targets (arXiv:2607.01641). Short-circuit → honor stop.
 *  - EXPLICIT /goal (auto !== true): the user DELIBERATELY opted into the loop
 *    with a stated stop-condition, bounded by MAX_GOAL_REACT. It must ALWAYS
 *    reach the judge — even on a no-artifact answer — so the user's condition
 *    is honored (e.g. "keep researching until all 10 bugs are listed" must not
 *    be silently satisfied by a 3-bug answer). The comparative framing (Change
 *    3, JUDGE_SYSTEM) is what keeps the judge from over-refusing here.
 *
 * So the short-circuit requires BOTH `auto` AND a terminal (no verifiable
 * artifact) answer. Kept pure here so the auto-vs-explicit invariant is unit-tested.
 */
/**
 * Did the CURRENT turn (after the last real user boundary) make any tool call at all?
 * The structural line between a CONVERSATION and a TASK. A conversational answer is produced from
 * knowledge — its turn is tool-free; a turn that was reading files, searching, running commands is a
 * task in progress, whatever its final message looks like. No language analysis, no thresholds.
 */
export function turnMadeToolCalls(messages: readonly ScanMessage[]): boolean {
  let start = 0
  for (let i = 0; i < messages.length; i++) if (isRealUserBoundary(messages[i])) start = i + 1
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== "assistant") continue
    if (m.parts.some((p) => p.type === "tool")) return true
  }
  return false
}

export function goalStopLayerFires(input: { auto: boolean; messages: readonly ScanMessage[] }): boolean {
  // The short-circuit exists for CONVERSATIONAL turns — the "answers, then loops and cannot stop"
  // failure it was built against was a chat question judged by a same-model judge on a 200k context.
  // It used to fire on ANY turn without unverified edits, which covered every READING task too: a
  // book-analysis session that stopped mid-task at "chapters 2-4 read, continuing in batches" was
  // honored as a finished answer, because reading produces no edits (measured live, three sessions in a
  // row, 2026-07-21). A turn that was actively CALLING TOOLS is not a conversation — it is a task, and
  // a task's stop must reach the judge (which is bounded by MAX_GOAL_REACT and the hard-veto, and whose
  // comparative framing already knows an informational request is satisfied by a direct answer).
  return input.auto === true && answerIsTerminal(input.messages) && !turnMadeToolCalls(input.messages)
}

/**
 * Is there SOME verification command for this project? Mirrors the verify_done tool's detection
 * (plugin/lib/verifycmd.ts) so the gate NEVER force-loops a project that has nothing to verify.
 * `verifyCmdEnv` = FABULA_VERIFY_CMD (explicit override) short-circuits to true.
 */
export function hasVerifyCommand(files: readonly string[], verifyCmdEnv?: string | null): boolean {
  if (verifyCmdEnv && verifyCmdEnv.trim()) return true
  const has = (f: string) => files.includes(f)
  return (
    has("package.json") ||
    has("pyproject.toml") ||
    has("pytest.ini") ||
    has("setup.cfg") ||
    has("tox.ini") ||
    has("go.mod") ||
    has("Cargo.toml") ||
    has("Makefile") ||
    has("makefile") ||
    (has("Gemfile") && has("Rakefile"))
  )
}

/** Stamped VISIBLY on the final assistant message when the force-verify cap is exhausted but source
 *  edits are still unverified — so a run can never end on a silent "done" it never proved. */
export const FORCE_VERIFY_NOT_DONE = [
  "",
  "— ❌ NOT DONE (unverified): source files were edited but the tests were never confirmed green.",
  "The verification gate asked for `verify_done` and the limit was reached without a passing run, so",
  "this result is NOT proven. Treat it as a draft: run the project's tests before trusting this change.",
].join("\n")

/** The re-entry reminder injected as a synthetic user turn when the gate fires. */
export const FORCE_VERIFY_REMINDER = [
  "<system-reminder>",
  "You edited source files but have NOT confirmed the tests pass. Before concluding, call the",
  "`verify_done` tool now — it runs the project's tests/build. If it fails, read the output, fix the",
  "code, and call `verify_done` again. Do NOT report the task done until `verify_done` is green. If no",
  "verification command exists for this project, say so explicitly and then stop.",
  "</system-reminder>",
].join("\n")

// ── W3: trajectory features + hard-veto for the auto-goal judge ──────────────────────────────────────
// The goal judge runs ALONE on the raw transcript, same socketed model — the worst calibration setting
// (arXiv:2508.06225: LLM-as-judge is systematically overconfident). The harness ALREADY computes the run
// dynamics deterministically; HTC (arXiv:2601.15778) shows those process-level features predict success far
// better than the prose. So we (a) hand the judge a measured trajectory block, and (b) HARD-VETO an
// overconfident ok:true when the dynamics are self-evidently not-done. Pure + deterministic + model-agnostic
// (RULE #9/#14): the same signal for any model in the socket. Scan resets at the last real user boundary.

export interface TrajectoryFeatures {
  verifyGreen: number
  verifyRed: number
  lastVerify: "green" | "red" | "none"
  edits: number
  rewinds: number
  notDone: number
  unverifiedEdits: boolean
}

/** Deterministic process-level features of THIS turn (since the last real user boundary). */
export function trajectoryFeatures(messages: readonly ScanMessage[]): TrajectoryFeatures {
  let verifyGreen = 0, verifyRed = 0, edits = 0, rewinds = 0, notDone = 0
  let lastVerify: "green" | "red" | "none" = "none"
  for (const m of messages) {
    if (isRealUserBoundary(m)) { verifyGreen = 0; verifyRed = 0; edits = 0; rewinds = 0; notDone = 0; lastVerify = "none"; continue }
    if (m.role !== "assistant") continue
    for (const p of m.parts) {
      if (p.type !== "tool" || !p.tool) continue
      const md = p.metadata
      if (p.tool === "verify_done") {
        if (md?.passed === true) { verifyGreen++; lastVerify = "green" }
        else if (md?.passed === false) { verifyRed++; lastVerify = "red" }
      } else if (EDIT_TOOLS.has(p.tool)) edits++
      else if (BASH_TOOLS.has(p.tool) && bashEditsTree(p.input?.command)) edits++
      if (md?.autoRewind != null) rewinds++
      if (md?.notDone != null) notDone++
    }
  }
  return { verifyGreen, verifyRed, lastVerify, edits, rewinds, notDone, unverifiedEdits: needsForcedVerify(messages) }
}

/**
 * The HARD-VETO: should an overconfident judge `ok:true` be REFUSED because the dynamics are self-evidently
 * not-done? Fires ONLY on hard, unambiguous signals so it never traps a genuine "done" (a clean green
 * trajectory is never vetoed). Order matters for a single honest `reason`.
 */
export function badDynamicsSignature(
  f: TrajectoryFeatures,
  opts?: { hasVerifyCommand?: boolean },
): { veto: boolean; reason: string } {
  if (f.lastVerify === "red")
    return { veto: true, reason: `the most recent verify_done was RED (${f.verifyRed} red / ${f.verifyGreen} green this turn) — the tests are not passing` }
  if (f.notDone > 0 && f.lastVerify !== "green")
    return { veto: true, reason: `a terminal NOT-DONE verdict was stamped this turn and no green verify has passed since` }
  // "Unverified edits" is only a not-done signal when the project HAS something to verify. In a repo with
  // no verify command (docs/prompts) `verify_done` can never go green, so vetoing here would burn the whole
  // re-entry budget demanding an impossible green. This mirrors the arming layer's own refusal to gate a
  // non-verifiable project (hasVerifyCommand) — the two gates read the SAME project signal. Default
  // (undefined) keeps the strict behavior for callers that don't know the project.
  if (f.unverifiedEdits && opts?.hasVerifyCommand !== false)
    return { veto: true, reason: `source was edited but never confirmed green by verify_done — an unverified change` }
  if (f.verifyRed >= 2 && f.verifyGreen === 0)
    return { veto: true, reason: `${f.verifyRed} verifies failed this turn and none ever passed` }
  return { veto: false, reason: `no hard not-done signal in the trajectory` }
}

/** A compact, deterministic trajectory block for the judge context — grounds the verdict in measured
 *  dynamics instead of prose alone (HTC). */
export function renderFeatureBlock(f: TrajectoryFeatures): string {
  return `[trajectory this turn] verify_done: ${f.verifyGreen} green / ${f.verifyRed} red (last: ${f.lastVerify}); ` +
    `${f.edits} source edit(s), ${f.rewinds} auto-rewind(s), ${f.notDone} terminal not-done` +
    (f.unverifiedEdits ? "; UNVERIFIED source edits present" : "")
}

// ── Post-compaction stall ────────────────────────────────────────────────────────────────────────
//
// Measured failure (live session, 2026-07-21): mid-task, the context boundary fired and the session was
// compacted; the very next turn the model produced a TEXT-ONLY reply announcing what it would do next
// ("now I'll move on to the chapters, starting with the first five") and the turn ended. Nothing forced a
// continuation: the project was a book folder with no verify command, so the auto-goal gate was never
// armed (its arming deliberately keys on hasVerifyCommand), and every other continuation contract keys on
// edits or malformed output — none of which a pure announcement has. Work in flight silently became a
// stop, and the user found a session that "finished" without doing the job.
//
// The rule is STRUCTURAL, no language matching and no tuned numbers: work was in flight before the
// boundary (the last real assistant step before the compaction summary made tool calls), the first turn
// after the boundary made NONE. Announcing is not doing; a model that had genuinely finished would have
// nothing left to announce. One bounded re-entry converges: either the model resumes real work (tool
// calls appear), or it repeats a text-only reply and the second stop stands.
export interface PostCompactionScanMessage {
  role: "user" | "assistant" | string
  /** the assistant message that carries the compaction summary */
  summary?: boolean
  /** message finished (has a finish reason) — mirrors info.finish presence */
  finished?: boolean
  parts: ReadonlyArray<{ type: string }>
}

export function postCompactionStall(messages: ReadonlyArray<PostCompactionScanMessage>): boolean {
  // walk from the end: the CURRENT assistant reply
  let i = messages.length - 1
  while (i >= 0 && messages[i].role !== "assistant") i--
  if (i < 0) return false
  const current = messages[i]
  if (current.summary === true) return false // the summary itself is not a work turn
  if (current.parts.some((p) => p.type === "tool")) return false // real work happened — no stall
  // the nearest FINISHED assistant before it must be the compaction summary (i.e. this is the FIRST
  // post-boundary turn — later turns are ordinary stops and none of this applies)
  let j = i - 1
  while (j >= 0 && !(messages[j].role === "assistant" && messages[j].finished)) j--
  if (j < 0 || messages[j].summary !== true) return false
  // and before the boundary, work was genuinely in flight
  let k = j - 1
  while (k >= 0 && messages[k].role !== "assistant") k--
  if (k < 0) return false
  return messages[k].parts.some((p) => p.type === "tool")
}
