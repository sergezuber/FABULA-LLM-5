// The UI half of the harness-steer marker. Kept byte-identical in meaning to plugin/lib/steer.ts, which
// is where the marker is APPLIED; the two cannot be one module because the plugins and the frontend are
// separate build graphs. If the prefix ever changes it must change in both — a mismatch degrades safely
// (a steer would render as an ordinary error card again), never dangerously.

export const STEER_PREFIX = "[fabula-steer] "

/** Is this recorded error a harness steer rather than a tool failure? */
export function isSteer(message: string): boolean {
  return String(message ?? "")
    .replace(/^Error:\s*/, "")
    .startsWith(STEER_PREFIX)
}

/** The guidance without its marker, for display. */
export function steerText(message: string): string {
  return String(message ?? "")
    .replace(/^Error:\s*/, "")
    .slice(STEER_PREFIX.length)
    .trim()
}
