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
    /** the part's own text — read ONLY for text and reasoning parts, to tell an answer from a monologue */
    text?: string
    /** recorded failure text, when the call did not succeed */
    error?: string | null
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

/**
 * Does the WINDOW carry evidence that a task ran in this session? Two structural witnesses, no
 * language analysis: an assistant turn that called tools (work happened), or a rebuild/checkpoint
 * boundary on a user message (which only exists because the harness was preserving a task in
 * flight — the same part `postCompactionStall` keys on). Session-scoped on purpose: measured
 * 2026-07-21 (ses_079ede1e4ffe…), an app restart mid book-analysis + «продолжай» produced a
 * text-only plan announcement; the TURN was tool-free, so the turn-scoped test classified a task
 * session as a conversation and the stop-layer honored the stop without consulting the judge.
 *
 * Honest scope of the checkpoint witness: the rebuild boundary is TOKEN-threshold-driven, so a very
 * long pure conversation that crosses it is reclassified as a task session for the rest of its life —
 * its stops then cost one bounded judge call each (auto cap, comparative framing). Accepted: the cost
 * of a spurious judge call is seconds; the cost of the missing one was a silently dead long task.
 */
export function sessionShowsTaskEvidence(messages: readonly ScanMessage[]): boolean {
  // OUTSTANDING work — not a history of tool use.
  //
  // "Any assistant tool part anywhere" was the wrong axis and it over-fired badly (measured live,
  // 2026-07-25): a question that could only ever be answered in prose — find a story — used twenty-two
  // searches, delivered a complete answer, and was re-entered by the judge anyway, because the session
  // had touched tools. The reader watched a finished answer scroll past and then saw the agent keep
  // working, which is exactly the "answers, then cannot stop" shape this layer exists to prevent, only
  // arriving through the layer itself. Using a tool is not a debt. An unfinished obligation is.
  //
  // So the question asked here is the one the literature actually poses (ANSWER as a terminal action,
  // arXiv:2606.28733; verifiable vs non-verifiable, arXiv:2506.00103): is there anything LEFT that can be
  // checked and has not been? The trajectory answers it directly, and it answers the same way whatever
  // the model, the context window, or the length of the reply — none of which appear in this decision.
  return messages.some((m) =>
    m.role === "assistant"
      ? m.parts.some((p) => p.type === "tool")
      : m.role === "user" && m.parts.some((p) => isContextBoundaryPart(p.type)),
  )
}

// A context boundary is EITHER recovery mechanism, and this is the ONE place that says which.
// `postCompactionStall` below already treats the two as one class and says so in its own comment; this
// predicate knew only the checkpoint, so a COMPACTED task session read as a session that had never
// worked — every tool part lives behind the boundary, and the window the gate reads is the one AFTER it.
// Measured live (ses_fe1fdd928ffe…, 2026-08-20): thirteen tool parts before the boundary, zero after, the
// stop-layer short-circuited in 7 ms with no judge call, and a task that had not started reported itself
// finished. The part exists only because the conversation crossed a threshold, which a session doing real
// work reaches and a short chat does not; a very long pure chat that crosses it is reclassified for life,
// which costs one judge call per stop, bounded by the auto-goal cap — the same cost already accepted for
// the checkpoint, and the reason this is a witness rather than a verdict.
export function isContextBoundaryPart(type: string): boolean {
  return type === "checkpoint" || type === "compaction"
}

/** Did THIS turn produce assistant text at all? Presence only — never length: a one-word answer and a
 *  ten-thousand-word one are equally an answer, and gating on size would make the decision depend on the
 *  very thing it must be independent of. */
export function turnProducedText(messages: readonly ScanMessage[]): boolean {
  const lastUser = messages.map((m) => m.role).lastIndexOf("user")
  return messages
    .slice(lastUser + 1)
    .some((m) => m.role === "assistant" && m.parts.some((p) => p.type === "text"))
}

/** Is there an obligation left that CAN be checked and has not been? Read off the trajectory, so it says
 *  the same thing whatever model produced it. */
export function outstandingWork(messages: readonly ScanMessage[]): boolean {
  const f = trajectoryFeatures(messages)
  return f.unverifiedEdits || f.lastVerify === "red" || f.notDone > 0
}

// DID THIS RE-ENTRY PRODUCE WORK, or is the run circling?
//
// The goal gate re-enters on a "not satisfied" verdict and counted those re-entries with a plain tally
// capped at three. A tally cannot tell a run that is ADVANCING from one that is stuck, so an answer that
// grew with every attempt was cut off by arithmetic while the harness's own judge was still saying the
// work was not done. Measured live (ses_fe18b7baaffe…, 2026-08-20): "attempt=1 goal not satisfied;
// re-entering", "attempt=2 …", then the cap — and the two attempts in between made FOUR tool calls and
// added 1453 characters of answer. The reader saw the reply stop mid-sentence on "Coming next turn…".
//
// The signal is the one this engine already uses for the same shape one layer down (invalid-output.ts:
// progress, not a count). Work here means a TOOL CALL — the model acting on the world — deliberately not
// "it wrote more words", because writing more words is exactly what a stuck model does. So a circling
// chat still stops at the soft cap (the Infinite Agentic Loop guard, arXiv:2607.01641, is untouched)
// while a run that is genuinely working keeps its budget, bounded by the hard ceiling either way.
export function goalAttemptProgressed(messages: readonly ScanMessage[]): boolean {
  let boundary = -1
  for (let j = messages.length - 1; j >= 0; j--) {
    const m = messages[j]
    if (m.role !== "user") continue
    // a re-entry is a user message the HARNESS wrote: every part synthetic. A message the reader wrote
    // starts the turn, so there is no earlier attempt to compare against.
    if (m.parts.length > 0 && m.parts.every((p) => p.synthetic === true)) boundary = j
    break
  }
  // First attempt of the turn — nothing has been spent yet, so it cannot be a stall.
  if (boundary < 0) return true
  return messages.slice(boundary + 1).some((m) => m.role === "assistant" && m.parts.some((p) => p.type === "tool"))
}

export function goalStopLayerFires(input: {
  auto: boolean
  messages: readonly ScanMessage[]
  /** has the judge already refused a stop in THIS turn? (the persisted goal react count is above zero) */
  judgeRefusedThisTurn?: boolean
}): boolean {
  // WHEN IS A TURN FINISHED? Explicit /goal is the user opting INTO the loop and is never short-circuited.
  // Otherwise the stop is honored only for a session that was never a task: no unverified artifact, and no
  // sign the session is task work (a tool part anywhere, or a rebuild boundary).
  //
  // ⚠️ KNOWN OPEN, and deliberately not papered over (2026-07-25). Two MEASURED failures live in the
  // SAME structural shape — prior tool work, then a text stop — and want opposite answers:
  //   · a book-analysis turn made dozens of reads and stopped at "chapters 2-4 read, continuing in
  //     batches". Honoring that killed the run mid-task (2026-07-21, three sessions).
  //   · a research turn made twenty-two searches and DELIVERED its answer. Re-entering that made the
  //     reader watch a finished answer scroll past while the agent kept working (2026-07-25).
  // Structure cannot separate a report from a promise: both are text after tool calls. `turnProducedText`
  // and `outstandingWork` above were written for a rule keyed on "did the turn do the work it reports",
  // which resolves the second case and REOPENS the first — so that rule is not wired, and they stand
  // ready for the fix rather than pretending to be it. The discriminator has to be SEMANTIC, which is the
  // judge's job under its comparative framing (arXiv:2510.08517) — the open work is that the judge called
  // the research answer insufficient, plus the fact that a re-entry arrives AFTER the reader has already
  // been shown the text as final. Neither is fixed by moving this predicate.
  if (input.auto !== true) return false
  // THE HARNESS DOES NOT OVERRULE ITS OWN EVALUATOR. Every short-circuit below decides a stop WITHOUT
  // calling the judge — which is sound only while the judge has not yet spoken about this turn. Once it
  // has looked at the work and said "not satisfied", bypassing it is the harness contradicting itself,
  // and that is measured, not hypothetical: ses_fe18b7baaffe… (2026-08-20) shows "attempt=1 … re-entering",
  // "attempt=2 … re-entering", and then this layer honouring the stop in 5 ms with no judge call — on an
  // answer that broke off mid-sentence promising the rest "next turn". The two cases the exhausted branch
  // below has to separate — a delivered research answer and a half-written one — differ in MEANING, which
  // is the judge's job; this keeps the decision with the layer that can read it, bounded by the re-entry
  // cap exactly as before.
  if (input.judgeRefusedThisTurn === true) return false
  if (!answerIsTerminal(input.messages)) return false
  // EXHAUSTED is not UNFINISHED, and this is the one place the difference is decidable without reading
  // meaning. When the harness itself has refused further calls and the turn still produced text, the
  // agent has said everything it is ABLE to say — sending it back cannot buy anything, and the reader has
  // already been shown that text as the answer. The book-analysis case (2026-07-21) is untouched: its
  // reads all SUCCEEDED, so nothing was refused and it still reaches the judge.
  const f = trajectoryFeatures(input.messages)
  if (f.harnessBlocked > 0 && turnProducedText(input.messages)) return true
  return !sessionShowsTaskEvidence(input.messages)
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
  /** Calls the HARNESS itself refused this turn (loop/budget guards). See isHarnessSteer. */
  harnessBlocked: number
  /** the visible answer is the model's own reasoning verbatim — nothing was delivered */
  answeredOnlyWithReasoning: boolean
}

/** The marker the guards stamp on a message they throw. Kept in step with plugin/lib/steer.ts, which is
 *  where it is applied; the two are separate build graphs, and a mismatch degrades to "no signal" — the
 *  judge simply learns nothing new — never to a wrong one. */
export const HARNESS_STEER_PREFIX = "[fabula-steer] "

/** Was this call refused by the harness rather than failing on its own? */
export function isHarnessSteer(error?: string | null): boolean {
  return String(error ?? "").replace(/^Error:\s*/, "").startsWith(HARNESS_STEER_PREFIX)
}

/** Deterministic process-level features of THIS turn (since the last real user boundary). */
export function trajectoryFeatures(messages: readonly ScanMessage[]): TrajectoryFeatures {
  let verifyGreen = 0, verifyRed = 0, edits = 0, rewinds = 0, notDone = 0, harnessBlocked = 0
  let lastVerify: "green" | "red" | "none" = "none"
  for (const m of messages) {
    if (isRealUserBoundary(m)) { verifyGreen = 0; verifyRed = 0; edits = 0; rewinds = 0; notDone = 0; harnessBlocked = 0; lastVerify = "none"; continue }
    if (m.role !== "assistant") continue
    for (const p of m.parts) {
      if (p.type !== "tool" || !p.tool) continue
      const md = p.metadata
      if (p.tool === "verify_done") {
        if (md?.passed === true) { verifyGreen++; lastVerify = "green" }
        else if (md?.passed === false) { verifyRed++; lastVerify = "red" }
      } else if (EDIT_TOOLS.has(p.tool)) edits++
      else if (BASH_TOOLS.has(p.tool) && bashEditsTree(p.input?.command)) edits++
      // A call the HARNESS refused is the one fact that separates "there is more to do" from "there is
      // nothing left this agent is allowed to try". Both look identical otherwise — tool calls, then text.
      if (isHarnessSteer(p.error)) harnessBlocked++
      if (md?.autoRewind != null) rewinds++
      if (md?.notDone != null) notDone++
    }
  }
  return { verifyGreen, verifyRed, lastVerify, edits, rewinds, notDone, unverifiedEdits: needsForcedVerify(messages) , harnessBlocked, answeredOnlyWithReasoning: turnAnsweredOnlyWithItsReasoning(messages) }
}

/**
 * The HARD-VETO: should an overconfident judge `ok:true` be REFUSED because the dynamics are self-evidently
 * not-done? Fires ONLY on hard, unambiguous signals so it never traps a genuine "done" (a clean green
 * trajectory is never vetoed). Order matters for a single honest `reason`.
 */
// AN ANSWER THAT IS ONLY THE MODEL THINKING OUT LOUD IS NOT AN ANSWER.
//
// A reasoning model that produces no answer leaves `content` empty, and the transport then moves
// `reasoning_content` into it so the turn is not lost — a deliberate, useful fallback (see the adapter's
// second translation). The cost was invisible until measured: the engine's own think-only continuation
// keys on the ABSENCE of a text part, and after that move a text part is present, so a turn that answered
// nothing reads as a turn that answered. Measured live (ses_fe18b7baaffe…, 2026-08-20): 64 output tokens,
// a 204-character "answer" byte-identical to the 204-character reasoning beside it, opening with "The
// user wants me to continue exactly from where I left off… Let me recall what was cut off mid-sentence" —
// and the judge accepted it as the finished work.
//
// The test is byte identity, not language: on the healthy turn of the same session the two differ
// (1453 against 1258 characters), and any turn that really wrote something differs by construction. A
// turn with no reasoning at all is untouched, so nothing about an ordinary model changes.
export function turnAnsweredOnlyWithItsReasoning(messages: readonly ScanMessage[]): boolean {
  let i = messages.length - 1
  while (i >= 0 && messages[i].role !== "assistant") i--
  if (i < 0) return false
  const join = (kind: string) =>
    messages[i].parts
      .filter((p) => p.type === kind && !p.synthetic && typeof p.text === "string")
      .map((p) => (p.text as string).trim())
      .join("")
  const text = join("text")
  const reasoning = join("reasoning")
  if (text.length === 0 || reasoning.length === 0) return false
  return text === reasoning
}

export function badDynamicsSignature(
  f: TrajectoryFeatures,
  opts?: { hasVerifyCommand?: boolean },
): { veto: boolean; reason: string } {
  if (f.answeredOnlyWithReasoning)
    return {
      veto: true,
      reason: `the turn produced no answer — the visible text is the model's own reasoning verbatim, so nothing has been delivered yet`,
    }
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
    (f.unverifiedEdits ? "; UNVERIFIED source edits present" : "") +
    // The decisive fact for a non-verifiable ask, and the one the judge could not see. A turn that
    // searched twenty-two ways and was then REFUSED further searches has no improvement left to make;
    // without this line the judge read it as an ordinary answer and sent the agent back for more, so the
    // reader watched a finished answer scroll past and the work carry on. A turn whose tools all
    // SUCCEEDED and that reports partial progress carries no such line, and is judged exactly as before.
    (f.harnessBlocked > 0
      ? `; the harness REFUSED ${f.harnessBlocked} further tool call(s) this turn (loop/budget guard) — ` +
        `repeating that tool is NOT available, so more of it cannot improve the answer`
      : "")
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

export function postCompactionStall(
  messages: ReadonlyArray<PostCompactionScanMessage>,
  // Was work in flight before the FIRST message of `messages`? The production caller passes the live
  // window, which begins AT the boundary — so the work turn is outside it by construction and the walk
  // below runs off the start. Supplying this answer (message-v2.ts priorWorkBeforeWindow, one message
  // further back) is what makes the detector reachable at all. Left undefined it answers exactly as
  // before: no evidence of prior work, no re-entry — a missing history never invents a stall.
  priorWorkBeforeList?: boolean,
): boolean {
  // walk from the end: the CURRENT assistant reply
  let i = messages.length - 1
  while (i >= 0 && messages[i].role !== "assistant") i--
  if (i < 0) return false
  const current = messages[i]
  if (current.summary === true) return false // the summary itself is not a work turn
  if (current.parts.some((p) => p.type === "tool")) return false // real work happened — no stall
  // The boundary this guards is EITHER context-recovery mechanism, because both reset the visible
  // conversation and both were measured producing the same failure: (a) the compaction SUMMARY (an
  // assistant message with summary===true), and (b) the checkpoint REBUILD boundary (a user message
  // carrying a "checkpoint" part — that part has no synthetic flag, so isRealUserBoundary treats the
  // boundary as a REAL turn start, the turn segment resets to tool-free, and a text-only announcement
  // right after a rebuild sails through the narrowed goal stop-layer exactly like the summary case did).
  // Walk back to the nearest of the two; anything else finishing in between makes this an ordinary stop.
  let j = i - 1
  let boundary: "summary" | "rebuild" | null = null
  while (j >= 0) {
    const m = messages[j]
    if (m.role === "assistant" && m.finished) {
      boundary = m.summary === true ? "summary" : null
      break
    }
    if (m.role === "user" && m.parts.some((p) => p.type === "checkpoint")) {
      boundary = "rebuild"
      break
    }
    j--
  }
  if (boundary === null) return false
  // and before the boundary, work was genuinely in flight
  //
  // SKIP SUMMARIES WALKING BACK. This function opens by declaring that a summary is not a work turn, and
  // then — before this line — accepted one as the work turn simply because it was the nearest assistant
  // message. One rule, applied in one direction only. It cost nothing while a compaction produced exactly
  // one summary; `planFold` (compaction.ts) now folds an oversized head into N passes and writes N summary
  // messages, so from the boundary the nearest assistant message is ANOTHER summary and the detector
  // reported "no work was in flight" for every fold with N > 1. Measured live (ses_fe1fdd928ffe…,
  // 2026-08-20): "head is ~42850 tokens against a 25536 budget — folding into 3 passes", three summaries,
  // work turn three messages further back, stall undetected, session ended on an announcement.
  let k = j - 1
  while (k >= 0 && !(messages[k].role === "assistant" && messages[k].summary !== true)) k--
  if (k < 0) return priorWorkBeforeList === true
  return messages[k].parts.some((p) => p.type === "tool")
}

// ── did this turn end with an ANSWER? ─────────────────────────────────────────────────────────────
//
// The model's own signal, not a threshold and not a count. A step that stopped of its own accord and
// left a final text with no tool call still pending IS the end of the work: the reader has their answer.
// Nothing here bounds the answer's size — a one-line reply and a twenty-page report are both answers,
// and which one the question deserved is the model's business, not the harness's.
//
// Measured live 2026-07-28: a conversation that stayed permanently above the last checkpoint threshold
// made compaction fire on every step after the answer, and each pass returned "continue" — ten
// compactions and fifty-one messages on one question, the model still generating long after the answer
// was on screen. Room for the NEXT turn is made when that turn starts.

/** Finish reasons that mean the model chose to stop rather than being cut off. */
const ANSWERED_FINISH = new Set(["stop", "end_turn", "stop_sequence"])

export function turnEndedWithAnswer(
  assistant: { finish?: string; error?: unknown; summary?: boolean } | undefined,
  parts: readonly { type: string; text?: string; synthetic?: boolean; state?: { status?: string } }[],
): boolean {
  if (!assistant || assistant.error || assistant.summary === true) return false
  if (!ANSWERED_FINISH.has(String(assistant.finish ?? ""))) return false
  // A tool still pending or running means the work is not finished, whatever the finish reason said.
  const toolPending = parts.some(
    (p) => p.type === "tool" && (p.state?.status === "pending" || p.state?.status === "running"),
  )
  if (toolPending) return false
  // The answer itself: real text the reader can read. Synthetic text is the harness talking to the model.
  return parts.some((p) => p.type === "text" && !p.synthetic && (p.text ?? "").trim().length > 0)
}
