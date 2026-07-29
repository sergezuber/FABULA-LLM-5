// When the summariser will not summarise, the run must not die with it.
//
// MEASURED 2026-07-28: "Compaction failed: the summarizer kept continuing the task instead of
// summarizing". Given a conversation full of instructions to read chapters, the model followed those
// instead of the one instruction it was actually given. The harness noticed — that part works — retried
// once, was hijacked again, and then killed the turn. Everything the run had read was lost, and the
// reader was left with a red error at the point they were waiting for an answer.
//
// A summary written by a model is better prose. A summary assembled from what demonstrably happened is
// worse prose that is always available, and it cannot be hijacked because no model is asked. Losing
// eloquence beats losing the work, so this is what compaction falls back to rather than giving up.
//
// Nothing here is a guess: every line comes from something the conversation actually contains.

export interface FallbackMessage {
  role: string
  parts?: Array<{ type?: string; text?: string; tool?: string; state?: { input?: Record<string, unknown> } }>
}

/** How many of each kind to name before saying "and N more" — enough to be useful, short enough to read. */
export const LIST_LIMIT = 12

function listOf(items: string[], limit = LIST_LIMIT): string {
  const seen = [...new Set(items.filter(Boolean))]
  if (!seen.length) return ""
  const shown = seen.slice(0, limit)
  const rest = seen.length - shown.length
  return shown.map((s) => `- ${s}`).join("\n") + (rest > 0 ? `\n- …and ${rest} more` : "")
}

/**
 * Assemble a summary from what the conversation shows. PURE.
 *
 * Deliberately factual and dull: the user's own words, the files touched, the tools used, the last thing
 * said. A later turn reading this knows what was done and what was asked, which is what a summary is for.
 */
export function mechanicalSummary(messages: readonly FallbackMessage[]): string {
  const msgs = messages ?? []
  const userTexts: string[] = []
  const files: string[] = []
  const tools: string[] = []
  let lastAssistant = ""

  for (const m of msgs) {
    for (const p of m.parts ?? []) {
      if (p?.type === "text" && p.text) {
        if (m.role === "user") userTexts.push(String(p.text).trim())
        else lastAssistant = String(p.text).trim() || lastAssistant
      }
      if (p?.type === "tool" && p.tool) {
        tools.push(String(p.tool))
        const input = p.state?.input ?? {}
        for (const key of ["path", "file_path", "filePath", "pattern", "command"]) {
          const v = (input as Record<string, unknown>)[key]
          if (typeof v === "string" && v.trim()) { files.push(v.trim()); break }
        }
      }
    }
  }

  const out: string[] = [
    "# Summary of the conversation so far",
    "",
    "_Assembled from what the conversation contains, because the summariser could not be persuaded to",
    "summarise. Factual rather than eloquent; nothing here is inferred._",
    "",
  ]

  const asked = userTexts.filter((t) => t && !t.startsWith("<system-reminder>"))
  out.push("## What was asked")
  out.push(asked.length ? listOf(asked.map((t) => (t.length > 240 ? t.slice(0, 240) + "…" : t))) : "- (nothing recorded)")
  out.push("")

  out.push("## What was done")
  const counts = tools.reduce<Record<string, number>>((a, t) => ((a[t] = (a[t] ?? 0) + 1), a), {})
  const summaryOfTools = Object.entries(counts).map(([t, n]) => `${t} ×${n}`)
  out.push(summaryOfTools.length ? listOf(summaryOfTools) : "- (no tools were used)")
  out.push("")

  if (files.length) {
    out.push("## Files and targets touched")
    out.push(listOf(files))
    out.push("")
  }

  if (lastAssistant) {
    out.push("## Where it stood")
    out.push(lastAssistant.length > 800 ? lastAssistant.slice(0, 800) + "…" : lastAssistant)
    out.push("")
  }

  out.push("Continue from here. The detail above is what is known; anything not listed was not recorded.")
  return out.join("\n")
}

// ── is continuing still justified? ────────────────────────────────────────────────────────────────
//
// NOT A COUNT. "At most N fallbacks" is a decision taken before the situation exists, and it is wrong in
// both directions: a turn that keeps freeing room is stopped for no reason, and a turn that frees nothing
// is allowed N pointless rounds first. The question is not how many times this has happened — it is
// whether the last compaction ACHIEVED anything.
//
// A compaction exists to make room. If the summary that replaces a slice of conversation is not
// materially smaller than the slice it replaced, the cycle freed nothing, and the next one will free
// nothing either: the context that triggered compaction is still there, so compaction fires again, and
// the turn churns. Measured live 2026-07-28: one question produced ten compactions and fifty-one
// messages this way, the model still generating long after the answer had been delivered.
//
// So the criterion is local, measured, and needs no memory of earlier rounds: room made → continue,
// however many times; no room made → this path is spent, end the turn. Same principle as the loop guard
// (identical work producing identical results is not progress) and the think-only bound (a step that
// changed something does not spend the budget).

/** Fraction of the replaced material a summary must fall under to count as having made room. POLICY, and
 *  the only number here: it says what "materially smaller" means, not how many attempts are allowed. */
export const ROOM_MADE_RATIO = 0.5

/** Did this compaction actually free space? PURE — takes the sizes, decides nothing about counts.
 *  Unknown sizes answer TRUE (fail-open): a measurement that could not be taken must never end a turn. */
export function compactionMadeRoom(replacedChars: number, summaryChars: number, ratio = ROOM_MADE_RATIO): boolean {
  if (!(replacedChars > 0) || !(summaryChars >= 0)) return true
  return summaryChars < replacedChars * ratio
}

/** Size of the material a compaction pass replaced, in characters. Counts the whole serialised shape —
 *  tool arguments and results are what actually fills a context, not just the prose a reader notices. */
export function replacedSize(messages: readonly unknown[]): number {
  let n = 0
  for (const m of messages) {
    try {
      n += JSON.stringify(m)?.length ?? 0
    } catch {
      /* a message that cannot be serialised contributes what we can see of it: nothing */
    }
  }
  return n
}
