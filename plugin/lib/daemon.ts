// FABULA daemon (KAIROS) — pure core (no IO). The autonomous-work posture, cache-aware sleep pacing,
// terminal-focus posture, and PR-event diffing. The plugin (fabula-daemon.ts) wires the tools, the
// system-prompt injection, and the `gh` polling. Kept pure here so every decision is unit-tested.
//
// FABULA's twist on KAIROS: background "done" is still a test result. Anything the daemon lands runs the
// same gates (verify → reproduce → change-quiz) and mints a replayable receipt — so overnight autonomy
// cannot lie about its work. That is the one thing no other always-on agent has.

// The prompt-cache TTL (the warm-prefix window on the serving backend). Sleeping past this loses the
// warm prefix on the next wake.
export const CACHE_WINDOW_MS = 300_000

export type DaemonState = { tick: number; lastSleepMs: number; firstTickDone: boolean }
export function newDaemonState(): DaemonState {
  return { tick: 0, lastSleepMs: 0, firstTickDone: false }
}

// Advice returned by the sleep tool. The note is cache-aware: crossing CACHE_WINDOW_MS re-reads context
// uncached on the next wake (pricier), so it's only worth it when there's genuinely nothing to check sooner.
export function sleepAdvice(durationMs: unknown): { ms: number; note: string } {
  const raw = typeof durationMs === "number" ? durationMs : parseInt(String(durationMs ?? ""), 10)
  const ms = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  const secs = Math.round(CACHE_WINDOW_MS / 1000)
  const note =
    ms === 0
      ? "0ms — you'll wake immediately; only do this if work is already queued, else pass a real duration."
      : ms < CACHE_WINDOW_MS
        ? `under the ${secs}s cache window → the next wake reuses the warm prompt cache (cheap). Good for active iteration.`
        : `past the ${secs}s cache window → the next wake re-reads context uncached (pricier). Only worth it when nothing needs checking sooner.`
  return { ms, note }
}

// The posture injected when the terminal's focus state is known. Unfocused → full autonomy; focused →
// keep the loop tight and ask before large or irreversible changes.
export function focusPosture(focus: string | undefined): string {
  if (focus === "focused")
    return "TERMINAL FOCUSED — the user is present: keep the feedback loop tight, prefer responding over background work, and ASK before large or irreversible changes."
  if (focus === "unfocused")
    return "TERMINAL UNFOCUSED — full autonomy: read/search/run/test freely, make and commit changes at good stopping points, and course-correct rather than asking. Don't narrate routine steps."
  return "" // unknown focus → inject nothing
}

// The autonomous-work system block. Present only in daemon mode. The last line is FABULA's differentiator.
export const KAIROS_BLOCK = [
  "# Autonomous work (FABULA daemon)",
  "You are running autonomously. `<tick>` prompts keep you alive between turns — treat each as \"you're awake, what now?\". Never echo tick content. Multiple ticks may batch into one message — process the latest.",
  "Pacing: use the `sleep` tool to control the wait. If you have NOTHING useful to do on a tick, you MUST call `sleep` — never reply with only \"still waiting\" or \"nothing to do\"; that burns a turn for nothing.",
  "First tick of a new session: greet briefly and ask what to work on — do not explore or change anything unprompted. Later ticks: look for useful work, bias toward action, investigate and reduce risk. Be concise — no play-by-play.",
  "Verified even in the dark: background \"done\" is still a test result. Every fix you land runs the same gates (verify → reproduce → change-quiz) and mints a replayable Proof-of-Done receipt — so the morning after, the work is VERIFIED, not merely claimed.",
].join("\n\n")

// The full daemon system posture for a given focus state.
export function daemonSystem(focus: string | undefined): string {
  const posture = focusPosture(focus)
  return posture ? `${KAIROS_BLOCK}\n\n${posture}` : KAIROS_BLOCK
}

export type PrEvent = { id: string; kind: "comment" | "check"; who: string; at: string; body: string }

// Normalize GitHub API shapes into a flat event list: issue/PR comments + check-runs.
export function parsePrEvents(
  comments: Array<{ id?: number | string; user?: { login?: string }; created_at?: string; body?: string }>,
  checks: Array<{ id?: number | string; name?: string; status?: string; conclusion?: string | null; completed_at?: string | null }>,
): PrEvent[] {
  const c: PrEvent[] = (comments || []).map((x) => ({
    id: `comment:${x.id}`,
    kind: "comment",
    who: x.user?.login || "?",
    at: x.created_at || "",
    body: (x.body || "").slice(0, 500),
  }))
  const k: PrEvent[] = (checks || []).map((x) => ({
    id: `check:${x.id}:${x.status}:${x.conclusion ?? ""}`,
    kind: "check",
    who: x.name || "check",
    at: x.completed_at || "",
    body: `${x.name}: ${x.status}${x.conclusion ? " → " + x.conclusion : ""}`,
  }))
  return [...c, ...k]
}

// Events not seen on a prior poll (dedup by id — check ids fold in status/conclusion so a state change is new).
export function newEventsSince(events: PrEvent[], seenIds: string[]): PrEvent[] {
  const seen = new Set(seenIds)
  return events.filter((e) => !seen.has(e.id))
}
