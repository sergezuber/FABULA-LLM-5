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
    metadata?: { passed?: boolean } | null
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
export function goalStopLayerFires(input: { auto: boolean; messages: readonly ScanMessage[] }): boolean {
  return input.auto === true && answerIsTerminal(input.messages)
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
