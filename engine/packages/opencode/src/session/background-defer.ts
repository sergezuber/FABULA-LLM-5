// Background self-improvement must not compete with the user for the model.
//
// MEASURED. There is ONE inference slot, and the "Auto Dream" / "Auto Distill" passes were spawned at
// STEP 1 of the user's own turn — so they ran alongside it for its whole length. On the run that exposed
// this (17:05:09-17:18:35) the two passes produced 22 messages while the user waited, and at the adapter
// the last 293 admissions averaged a 44s wait, median 32s, 74 of them over a minute, 3 pinned to the
// 300s fail-open ceiling, with the queue reaching depth 7. Nothing was hung. Everything was queued.
//
// The rule here is the obvious one, stated once: work nobody asked for waits for work somebody did.
// Deferring costs a self-improvement pass some latency and costs the user nothing; running it early
// costs the user every second of it. If the machine never goes quiet within the deadline the pass is
// SKIPPED rather than forced — its trigger fires again later, so a skip loses nothing at all.
//
// Deliberately keyed on session STATUS, not on which model or which agent is running: whatever sits in
// the socket, a busy foreground session means the user is waiting.

/** How often to look; the wait is minutes long, so a coarse poll is free. */
export const POLL_MS = 5_000

/** Give up waiting after this long and skip the pass. A pass is never worth blocking on forever. */
export const MAX_WAIT_MS = 30 * 60_000

export type StatusLike = { type: string }

/**
 * Is a FOREGROUND session generating right now?
 *
 * `own` excludes the pass's own session (and its sibling pass) — otherwise each pass would see itself as
 * foreground traffic and wait for its own completion, which never comes.
 */
export function foregroundBusy(statuses: Iterable<readonly [string, StatusLike]>, own: Iterable<string>): boolean {
  const mine = new Set(own)
  for (const [id, st] of statuses) {
    if (mine.has(id)) continue
    if (st?.type === "busy") return true
  }
  return false
}

/** Has the wait run out of patience? Split out so the loop's exit condition is testable on its own. */
export function waitExpired(waitedMs: number, maxMs: number = MAX_WAIT_MS): boolean {
  return waitedMs >= maxMs
}
