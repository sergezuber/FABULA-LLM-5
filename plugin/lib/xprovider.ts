// Cross-provider message transform (pure). This is the reusable core of mid-session local->cloud
// escalation (§5): when the harness detects the local model is stuck, the SAME conversation must replay
// onto a different provider — but providers disagree on tool-call-id shape, drop each other's thinking,
// and choke on orphaned/aborted turns. These pure rules make an arbitrary session replayable on any
// OpenAI-compatible target so the model is a swappable worker mid-turn. (The engine wiring that actually
// switches the model mid-session is separate.)

// Tool-call-id styles a target provider can require:
//   "strict" — ids must match ^[a-zA-Z0-9_-]{1,64}$ (many chat-completions endpoints enforce this).
//   "loose"  — ids may be long/arbitrary (e.g. the OpenAI Responses API emits 450+ char ids with '|').
export type ToolIdStyle = "strict" | "loose"

const STRICT_ID = /^[a-zA-Z0-9_-]{1,64}$/

/** Normalize a tool-call id to the target provider's constraints. */
export function normalizeToolCallId(id: string, style: ToolIdStyle): string {
  if (style !== "strict") return id
  if (STRICT_ID.test(id)) return id
  // A strict endpoint requires ^[A-Za-z0-9_-]{1,64}$; loose endpoints allow 450+ char ids with '|'.
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
  return cleaned || "tool_call"
}

interface Msg { role: string; content?: any; tool_calls?: any[]; tool_call_id?: string; error?: any; aborted?: boolean }

/** Remap tool-call ids consistently across assistant tool_calls AND the matching tool results. */
export function remapToolCallIds(messages: Msg[], style: ToolIdStyle): Msg[] {
  const map = new Map<string, string>()
  for (const m of messages) {
    if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) {
      if (tc?.id) { const n = normalizeToolCallId(tc.id, style); if (n !== tc.id) map.set(tc.id, n) }
    }
  }
  if (map.size === 0) return messages
  return messages.map((m) => {
    const out: Msg = { ...m }
    if (Array.isArray(out.tool_calls)) out.tool_calls = out.tool_calls.map((tc) => tc?.id && map.has(tc.id) ? { ...tc, id: map.get(tc.id) } : tc)
    if (out.role === "tool" && out.tool_call_id && map.has(out.tool_call_id)) out.tool_call_id = map.get(out.tool_call_id)!
    return out
  })
}

/** A tool call with no following tool result (e.g. after an abort) breaks replay — synthesize an
 * error result so the target provider sees a complete call/result pair. */
export function synthOrphanResults(messages: Msg[]): Msg[] {
  const answered = new Set<string>()
  for (const m of messages) if (m.role === "tool" && m.tool_call_id) answered.add(m.tool_call_id)
  const out: Msg[] = []
  for (const m of messages) {
    out.push(m)
    if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) {
      if (tc?.id && !answered.has(tc.id)) {
        out.push({ role: "tool", tool_call_id: tc.id, content: "No result provided (call was interrupted before completion)." })
        answered.add(tc.id)
      }
    }
  }
  return out
}

/** Drop assistant turns that errored/aborted — replaying them causes "reasoning without following item". */
export function skipErroredTurns(messages: Msg[]): Msg[] {
  return messages.filter((m) => !(m.role === "assistant" && (m.error || m.aborted)))
}

/** Compose the full replay transform for a target provider. */
export function transformForProvider(messages: Msg[], opts: { style: ToolIdStyle }): Msg[] {
  return synthOrphanResults(remapToolCallIds(skipErroredTurns(messages), opts.style))
}
