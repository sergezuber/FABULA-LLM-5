// Auto-rewind decision core (pure, LOCK 4). When the model keeps making a change that fails verify —
// digging the hole deeper instead of fixing it — the HARNESS (not the model) should revert to the last
// known-good state and force a different approach. This module is the deterministic decision: it tracks
// the green/red verify streak, remembers the last GREEN checkpoint, and after N consecutive REDs signals
// a rewind to that checkpoint plus a distilled summary of what the failed attempt tried (so the model
// doesn't just repeat it). The actual file revert uses the existing shadow-git checkpoint store; a true
// atomic conversation+file rewind additionally needs the session tree (separate, larger engine work).

export interface VerifyEvent {
  green: boolean
  checkpoint?: string   // checkpoint id captured at this point (for a green, this is a good state to return to)
  note?: string         // one-line: what this attempt changed / why it failed
}

export interface RewindState {
  redStreak: number
  lastGreenCheckpoint?: string
  failedNotes: string[]
  /** how many auto-rewinds already fired this task (bounds the rewind↔red see-saw) */
  rewinds?: number
  /** a green verify happened at some point, even if its checkpoint later became unusable — so the
   *  terminal verdict never falsely claims "none has ever passed" after a failed restore dropped the anchor */
  hadGreen?: boolean
}

export type RewindAction =
  | { type: "rewind"; toCheckpoint: string; summary: string; redStreak: number; failedNotes: string[] }
  // Terminal rung of the ladder (Greenpaper §2): the honest state is NOT DONE — either the run never
  // once passed verify (nothing to rewind to), or every fresh approach after the allowed rewinds
  // stayed red. Silent stops and unproven "done" are protocol violations; this surfaces the verdict.
  | { type: "notdone"; reason: string; redStreak: number; failedNotes: string[] }

export const REWIND_THRESHOLD = 2 // consecutive RED verifies with no green between → revert
export const NOTDONE_THRESHOLD = 4 // consecutive REDs with no green anchor → terminal NOT DONE
export const REWIND_MAX = 2 // rewinds per task; past this, another full red streak → terminal NOT DONE

export function initRewind(): RewindState {
  return { redStreak: 0, lastGreenCheckpoint: undefined, failedNotes: [], rewinds: 0 }
}

/** Advance the state with a verify result; return the (possibly) triggered rewind/notdone action. */
export function updateRewind(
  state: RewindState,
  ev: VerifyEvent,
  threshold = REWIND_THRESHOLD,
  notdoneThreshold = NOTDONE_THRESHOLD,
  rewindMax = REWIND_MAX,
): {
  state: RewindState
  action: RewindAction | null
} {
  const rewinds = state.rewinds ?? 0
  if (ev.green) {
    // A genuine green is a NEW anchor: the rewind budget resets with it, otherwise a recovered run
    // that later struggles again would jump straight to the terminal verdict with a false
    // "restored N time(s)" reason describing an older phase of the task.
    return { state: { redStreak: 0, lastGreenCheckpoint: ev.checkpoint ?? state.lastGreenCheckpoint, failedNotes: [], rewinds: 0, hadGreen: true }, action: null }
  }
  const failedNotes = ev.note ? [...state.failedNotes, ev.note] : state.failedNotes
  const redStreak = state.redStreak + 1
  const next: RewindState = { ...state, redStreak, failedNotes, rewinds }
  if (redStreak >= threshold && state.lastGreenCheckpoint && rewinds < rewindMax) {
    const summary = [
      `Reverted your last ${redStreak} change(s): each kept the verify RED.`,
      failedNotes.length ? "What was tried (and failed): " + failedNotes.map((n, i) => `(${i + 1}) ${n}`).join("; ") : "",
      "Files are back at the last state that passed verify. Take a DIFFERENT approach — do not repeat the above.",
      "If a different approach also fails, call escalate_to_cloud for a second opinion from a stronger model.",
    ].filter(Boolean).join(" ")
    // reset the streak so we don't rewind again immediately on the next red
    return { state: { redStreak: 0, lastGreenCheckpoint: state.lastGreenCheckpoint, failedNotes: [], rewinds: rewinds + 1, hadGreen: state.hadGreen },
             action: { type: "rewind", toCheckpoint: state.lastGreenCheckpoint, summary, redStreak, failedNotes } }
  }
  // Terminal NOT DONE — two ways to exhaust the ladder:
  // (a) no green anchor ever existed: a long red streak with nothing to rewind to used to be a silent
  //     no-op loop; (b) the rewind budget is spent and a fresh full streak is red again (see-saw).
  const anchorless = !state.lastGreenCheckpoint && redStreak >= notdoneThreshold
  const seesaw = !!state.lastGreenCheckpoint && rewinds >= rewindMax && redStreak >= threshold
  if (anchorless || seesaw) {
    // "none has ever passed" is only true if no green was ever seen. A failed restore can drop the
    // anchor while hadGreen stays set — then the honest reason is that the good state is unrecoverable.
    const reason = seesaw
      ? `the last-green state was restored ${rewinds} time(s) and every fresh approach still failed verification.`
      : state.hadGreen
        ? `${redStreak} consecutive verifications failed and the last known-good state can no longer be restored.`
        : `${redStreak} consecutive verifications failed and none has ever passed — there is no known-good state to return to.`
    // reset the streak so the verdict re-fires only after another full red streak (no per-call spam);
    // a later green still recovers the run completely.
    return { state: { redStreak: 0, lastGreenCheckpoint: state.lastGreenCheckpoint, failedNotes: [], rewinds, hadGreen: state.hadGreen },
             action: { type: "notdone", reason, redStreak, failedNotes } }
  }
  return { state: next, action: null }
}
