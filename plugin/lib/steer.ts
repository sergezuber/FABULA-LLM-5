// A harness steer is not a tool failure, and must not be dressed as one.
//
// The guards stop a call by THROWING, because that is the only channel a `tool.execute.before` hook has.
// The engine records the throw as `state.status = "error"`, and the UI renders every such state as a red
// error card — so the reader watching a search loop being correctly stopped saw a stack of red "errors"
// carrying instructions addressed to the model ("STOP searching; synthesize what you have gathered and
// produce the answer now"). Supervision working exactly as designed looked like the app breaking.
//
// The distinction is real, so it is marked at the SOURCE rather than guessed at the far end. A shape
// heuristic was the obvious alternative and it is wrong: `ENOENT: no such file` has the same ALL-CAPS
// marker shape as `LOOP BLOCKED:`, so any rule broad enough to catch our steers would quietly hide
// genuine failures. One prefix, applied where the throw happens, cannot misfire.
//
// The prefix reaching the model is deliberate, not a leak: it tells the model this is the harness
// stopping it on purpose, not a tool that broke and might work on a retry.

export const STEER_PREFIX = "[fabula-steer] "

/** Mark a guidance message as harness supervision. Idempotent. */
export function asSteer(message: string): string {
  const m = String(message ?? "")
  return m.startsWith(STEER_PREFIX) ? m : STEER_PREFIX + m
}

/** Is this recorded error a harness steer rather than a tool failure? */
export function isSteer(message: string): boolean {
  return String(message ?? "").replace(/^Error:\s*/, "").startsWith(STEER_PREFIX)
}

/** The guidance without its marker, for display. */
export function steerText(message: string): string {
  return String(message ?? "")
    .replace(/^Error:\s*/, "")
    .slice(STEER_PREFIX.length)
    .trim()
}
