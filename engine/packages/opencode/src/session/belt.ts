// Context OS Phase 1 (design §4/§9): per-ROOT-SESSION tool-belt
// selection state. Fixes the process-global FABULA_TOOL_MASK race (design K4): the env var
// stays as a STATIC write-once floor, while the dynamic per-task selection lives in a
// session-keyed registry — two concurrent sessions can never clobber each other's tool set.
//
// The registry is a globalThis-backed map because the WRITER is the fabula tool-router plugin
// (loaded in the same engine process; plugins cannot import engine modules) and the READER is
// resolveTools. Session-keyed entries make this safe where the single env cell was not.
//
// Cache discipline (§3): the entry for a session changes only at task boundaries (the plugin
// routes on chat.message — BEFORE resolveTools builds the step's schemas), so the tool set is
// byte-stable within a segment.

export type BeltEntry = {
  profileId: string
  /** exact tool ids to HIDE (deny-list — unknown tools stay visible by design) */
  hide: readonly string[]
  /** glob prefixes to hide whole MCP servers: "serena_*" / "serena:*" */
  hideGlobs: readonly string[]
    /** message id the decision was made on (manifest/provenance) */
  watermark?: string
}

/** Never maskable, regardless of any profile/router decision: the self-firing gates demand
 *  these by name (§13) — hiding one would deadlock a gate against the router. Mirrors
 *  plugin/lib/toolusage.GATE_REQUIRED_TOOLS ∪ toolbelt.ALWAYS_ON. */
export const NEVER_MASK: ReadonlySet<string> = new Set([
  "view",
  "read",
  "verify_done",
  "skill",
  "change_quiz",
  "reference_hunt",
  "expand_tools",
])

const CHANNEL_KEY = "__FABULA_SESSION_BELT__"

type Channel = Map<string, BeltEntry>

function channel(): Channel {
  const g = globalThis as Record<string, unknown>
  if (!(g[CHANNEL_KEY] instanceof Map)) g[CHANNEL_KEY] = new Map<string, BeltEntry>()
  return g[CHANNEL_KEY] as Channel
}

export function setBelt(sessionID: string, entry: BeltEntry): void {
  channel().set(sessionID, entry)
}

export function getBelt(sessionID: string): BeltEntry | undefined {
  return channel().get(sessionID)
}

export function clearBelt(sessionID: string): void {
  channel().delete(sessionID)
}

/** Resolve the belt for a session, inheriting the ROOT session's decision: subagent child
 *  sessions (session.parentID = root) share the parent's belt so 3 parallel explore agents
 *  stay byte-identical (§4). One hop covers the engine's spawn topology; deeper descendants
 *  fall back to the env floor (safe: floor ⊆ any profile's hide set). */
export function beltFor(sessionID: string, parentID?: string | null): BeltEntry | undefined {
  return getBelt(sessionID) ?? (parentID ? getBelt(parentID) : undefined)
}

/** Does a tool key match the hide set? Exact id, or a server glob ("serena_*" / "serena:*")
 *  matching the engine's MCP key form `server:tool` AND the sanitized wire form `server_tool`.
 *  NEVER_MASK ids never match, whatever the entry says. */
export function beltMasks(key: string, entry: Pick<BeltEntry, "hide" | "hideGlobs">): boolean {
  if (NEVER_MASK.has(key)) return false
  if (entry.hide.includes(key)) return true
  for (const g of entry.hideGlobs) {
    const star = g.indexOf("*")
    if (star <= 0) continue
    const prefix = g.slice(0, star)
    // normalize separators: "serena_*" must hide "serena:find_symbol" and vice versa
    const base = prefix.replace(/[:_]$/, "")
    if (key.startsWith(base + ":") || key.startsWith(base + "_")) return true
  }
  return false
}

// ---- shadow executors (attempt-routed dispatch, design K2) ----
// resolveTools builds REAL executors for masked tools into a per-session shadow map. When the
// model ATTEMPTS a masked tool by name (it knows the name from the resident catalog), the
// processor's no-executor branch dispatches through the shadow instead of erroring — the
// harness routes the attempt (RULE #9), the prefix stays untouched (no schema was added), and
// the event is logged as a missed-tool calibration signal.

export type ShadowTool = {
  execute: (args: unknown, options: { toolCallId: string; messages: unknown; abortSignal?: AbortSignal }) => PromiseLike<unknown>
}

const SHADOW_KEY = "__FABULA_SESSION_SHADOW__"

function shadowChannel(): Map<string, Map<string, ShadowTool>> {
  const g = globalThis as Record<string, unknown>
  if (!(g[SHADOW_KEY] instanceof Map)) g[SHADOW_KEY] = new Map()
  return g[SHADOW_KEY] as Map<string, Map<string, ShadowTool>>
}

/** Sessions whose shadow executors stay resident. This map hangs off `globalThis` and the server is
 *  long-lived, so without a bound every session ever routed keeps its tool CLOSURES alive for as long as
 *  the process runs. The plugin side added a cap; this is the writer that actually runs on every prompt
 *  build, and it had none — the cap was real code with no callers. */
const SHADOW_MAX_SESSIONS = (() => {
  // An explicitly set 0 means "no cap" — the owner's choice, honoured. Only junk falls back.
  const raw = (process.env.FABULA_CHANNEL_MAX_SESSIONS ?? "").trim()
  if (raw === "") return 32
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 32
})()

export function stashShadow(sessionID: string, tools: Map<string, ShadowTool>): void {
  const m = shadowChannel()
  // Re-insert so the session being written is always the most RECENT key. A plain `set` leaves an
  // existing key where it was first inserted, so "oldest" meant FIRST SEEN rather than least recently
  // used: a long-running session that re-stashes on every prompt build stayed the oldest key forever and
  // was evicted by the next OTHER session's write — the one case the eviction below promises cannot
  // happen. Measured on the pre-fix order: the actively-used session was dropped once across 60
  // interleaved stashes, and zero times after. (It is dropped, not lost — the next build re-stashes it —
  // so the cost is a lookup miss inside the turn, not permanent loss. The bound itself was never in
  // question: an interleaved write from any other session still evicts, so nothing grew unbounded.)
  m.delete(sessionID)
  m.set(sessionID, tools)
  // Evict least-recently-stashed first, and never the session being written: dropping a LIVE session's
  // entry would silently change its tool prefix mid-run, which is the byte-parity break this file exists
  // to avoid. Only older, quiet sessions are released.
  while (SHADOW_MAX_SESSIONS > 0 && m.size > SHADOW_MAX_SESSIONS) {
    const oldest = m.keys().next().value as string | undefined
    if (oldest === undefined || oldest === sessionID) break
    m.delete(oldest)
  }
}

export function shadowFor(sessionID: string, toolName: string, parentID?: string | null): ShadowTool | undefined {
  const own = shadowChannel().get(sessionID)?.get(toolName)
  if (own) return own
  return parentID ? shadowChannel().get(parentID)?.get(toolName) : undefined
}

export function clearShadow(sessionID: string): void {
  shadowChannel().delete(sessionID)
}

/**
 * THE single visibility decision for a registry tool id (design §4.2: one pure function feeds
 * EVERY prefix-assembly site — runLoop resolveTools AND the checkpoint/fork capture path
  * (llm-request-prefix). Divergence here is the M10 silent-corruption class: a fork built with
 * a different tool set than its parent breaks the byte-parity contract and the KV/provider
 * cache. Semantics mirror resolveTools exactly:
 *  - no dynamic belt (router off): hidden iff the static env mask lists the id (legacy path,
 *    byte-compatible with pre-belt behavior — no NEVER_MASK exemption);
 *  - dynamic belt present: hidden iff the belt masks it OR the env floor lists it, except
 *    NEVER_MASK ids which are always visible.
 */
export function beltVisible(
  id: string,
  envMask: ReadonlySet<string>,
  entry: Pick<BeltEntry, "hide" | "hideGlobs"> | undefined,
): boolean {
  if (!entry) return !envMask.has(id)
  if (NEVER_MASK.has(id)) return true
  return !(beltMasks(id, entry) || envMask.has(id))
}

/**
 * Rewrite a direct by-name attempt at a SHADOW (belt-hidden) tool into an `expand_tools` call
  * (design K2, normal streaming path): the AI SDK raises NoSuchToolError for names absent from
 * the tools map, and experimental_repairToolCall consults this helper. The rewritten call
 * executes through expand_tools' real dispatcher — prefix untouched, task never blocked.
 * Returns the new input JSON for expand_tools; pure (unit-tested).
 */
export function wrapShadowCall(toolName: string, rawInputJson: string | undefined): string {
  let args: unknown
  try {
    args = rawInputJson ? JSON.parse(rawInputJson) : {}
  } catch {
    // half-written / non-JSON args: pass through raw so the dispatcher can show the schema
    args = { args_raw: rawInputJson }
  }
  return JSON.stringify({ tool: toolName, args })
}
