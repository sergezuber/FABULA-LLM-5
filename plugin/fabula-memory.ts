// W7 — the memory lifecycle, wired to the real turn.
//
// Every mechanism this wave built is a pure function until something calls it on a live run. That gap is
// not academic: the harness has shipped measured, tested, documented machinery before that no production
// path ever reached, and a mechanism with no caller is a comment with a test suite. This plugin is the
// caller.
//
// It does exactly two things, and they are deliberately the SAME two halves of one loop:
//
//   1. SERVE — anchored memories go into the system message, after a deterministic freshness check
//      against the real tree. A memory whose anchor no longer resolves is withheld or re-grounded; it is
//      never served with a "possibly stale" marker, because markers are the falsified design (agents
//      respond to confidence language rather than source reliability, and explicit distrust instructions
//      measurably make the outcome worse).
//   2. RECORD — when the turn's verify comes back, the outcome is written against the memories that were
//      ACTUALLY SERVED into that turn. Not against everything in the store: co-occurrence with an outcome
//      only means something if the memory was in the context that produced it. Crediting unserved
//      memories would move the counters while making them mean nothing, which is worse than leaving them
//      at zero — a number nobody can trust is more expensive than a number nobody has.
//
// The serve half is what makes the record half honest, which is why they live in one file.

import type { Plugin } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import { serveMemories } from "./lib/memserve"
import { appendRaw, currentRecords } from "./lib/memstore"
import { anchorFor } from "./lib/memanchor"
import { admitMemory } from "./lib/memgate"
import { recordOutcome } from "./lib/memworth"

/** What this session put in front of the model, so the outcome can be attributed to it and nothing else. */
const servedBySession = new Map<string, string[]>()

/** Source files this session edited, newest last. This is what an episode is ABOUT: a memory formed from
 *  a verified turn is a claim about the code that turn changed, so it must be anchored to that code or it
 *  is an unfalsifiable sentence. Without this the writer recorded no anchor at all — and since a record
 *  with no anchor is withheld at serve time, the whole memory loop ran and delivered nothing while every
 *  anchor test passed vacuously. */
const editedBySession = new Map<string, string[]>()

const EDIT_TOOLS = /^(str_replace|create_file|edit|write|apply_patch|multi_edit|notebook_edit)$/i
const SOURCE = /\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|c|h|cc|cpp|swift|sh)$/i

function noteEdit(sessionID: string, file: string) {
  const list = editedBySession.get(sessionID) ?? []
  if (!list.includes(file)) list.push(file)
  editedBySession.set(sessionID, list.slice(-20))
  while (editedBySession.size > MAX_SESSIONS) {
    const oldest = editedBySession.keys().next().value as string | undefined
    if (oldest === undefined || oldest === sessionID) break
    editedBySession.delete(oldest)
  }
}

function pathFrom(args: any): string | null {
  const p = args?.path ?? args?.file_path ?? args?.filePath ?? args?.file ?? args?.target
  return typeof p === "string" && SOURCE.test(p) ? p : null
}

/** Bounded, because this map outlives a turn and the server is long-lived — the same unbounded-channel
 *  mistake this project has already paid for once. */
const MAX_SESSIONS = 64
function remember(sessionID: string, ids: string[]) {
  servedBySession.delete(sessionID)
  servedBySession.set(sessionID, ids)
  while (servedBySession.size > MAX_SESSIONS) {
    const oldest = servedBySession.keys().next().value as string | undefined
    if (oldest === undefined || oldest === sessionID) break
    servedBySession.delete(oldest)
  }
}

const idOf = (x: any): string | null => {
  const v = x?.id ?? x?.memoryId ?? x?.key
  return typeof v === "string" && v ? v : null
}

/** Did this tool result represent a verification, and did it pass? `null` means "not a verify" — the
 *  outcome is unknown, and an unknown outcome is recorded as nothing at all rather than as a failure. */
function verifyOutcome(tool: string | undefined, output: any): boolean | null {
  if (!/verify/i.test(String(tool ?? ""))) return null
  const meta = output?.metadata ?? output?.state?.metadata ?? {}
  for (const k of ["passed", "green", "ok", "success"]) {
    if (typeof meta?.[k] === "boolean") return meta[k]
    if (typeof output?.[k] === "boolean") return output[k]
  }
  const text = String(output?.title ?? output?.output ?? output ?? "")
  if (/\bPASS(ED)?\b|✅|\ball tests? passed\b/i.test(text)) return true
  if (/\bFAIL(ED|URE)?\b|❌|\bred\b/i.test(text)) return false
  return null
}

export const FabulaMemory: Plugin = async (input: any) =>
  gate("memory", {
    "experimental.chat.system.transform": async (i: any, output: any) => {
      if (!output || !Array.isArray(output.system)) return
      try {
        const sessionID = String(i?.sessionID ?? i?.session?.id ?? input?.sessionID ?? "default")
        const candidates = currentRecords()
        if (!candidates.length) return
        const served = serveMemories(candidates, { root: input?.directory || process.cwd() })
        if (served.text) output.system.push(served.text)
        remember(sessionID, served.entries.map(idOf).filter(Boolean) as string[])
      } catch {
        // Memory must never break a turn. A store that cannot be read is a turn without memory, which is
        // the pre-W7 behaviour and is survivable; a thrown error here would not be.
      }
    },

    "tool.execute.after": async (i: any, output: any) => {
      try {
        // Record every source edit as it happens: at verify time the tool arguments are long gone, and an
        // anchor derived after the fact could be laundered — it would describe the tree as it is now
        // rather than as it was when the claim was made.
        if (EDIT_TOOLS.test(String(i?.tool ?? ""))) {
          const f = pathFrom(i?.args ?? i?.arguments ?? i?.input)
          if (f) noteEdit(String(i?.sessionID ?? i?.session?.id ?? input?.sessionID ?? "default"), f)
          return
        }
        const ok = verifyOutcome(i?.tool, output)
        if (ok === null) return
        const sessionID = String(i?.sessionID ?? i?.session?.id ?? input?.sessionID ?? "default")
        const ids = servedBySession.get(sessionID) ?? []

        // A verified turn is itself an episode worth remembering, and this is where memory is FORMED.
        // Capturing it here rather than on a timer is the whole point of M5: the store learns from work
        // whose outcome an external verifier decided, not from whatever happened to be in context when a
        // threshold tripped. Capture is append-only and always allowed — it is not promotion, which stays
        // behind the gate and is off by default.
        const root = input?.directory || process.cwd()
        const edited = editedBySession.get(sessionID) ?? []
        // Anchor to the LAST file this turn changed. One anchor, not many: a record whose validity depends
        // on several files going stale together is a record nobody can reason about, and the last edit is
        // the one the verify actually exercised.
        const anchor = edited.length ? anchorFor(edited[edited.length - 1], undefined, root) : null
        const title = String(output?.title ?? output?.output ?? "").trim().slice(0, 200)
        const episode = appendRaw(
          {
            text:
              `verify ${ok ? "GREEN" : "RED"}` +
              (edited.length ? ` after editing ${edited[edited.length - 1]}` : "") +
              (title ? ` — ${title}` : ""),
            kind: "episode",
            ...(anchor ? { anchor } : {}),
            // A turn that changed no code asserts nothing about code, and says so rather than simply
            // lacking an anchor — the absence of a field is not a statement.
            ...(anchor ? {} : { claimsCode: false }),
            origin: { kind: "verify", ref: sessionID, at: Date.now() },
          },
          {},
        )
        // THE GATE, on the real write path. Capture above is unconditional — raw is never gated, because
        // an episode nobody kept cannot be re-judged later. What the gate decides is PROMOTION: whether
        // this episode becomes something the harness will serve back. It reads an outcome produced
        // OUTSIDE the model (the project's own verifier), never recurrence, never a vote, never the
        // model's opinion of its own work.
        //
        // Default is SHADOW: the decision is journalled and nothing is promoted. That is not timidity —
        // it is the same discipline the escalation ledger shipped under. A promotion policy that starts
        // acting before anyone has read a single one of its decisions is a policy nobody has evidence
        // for. FABULA_MEM_PROMOTE=1 turns the journal into action.
        // `verified` is the key the gate actually reads. The first wiring passed `helped`, which it does not
        // look at, so the gate journalled "no external verifier outcome" on every single green turn — wired,
        // running, and structurally incapable of ever admitting anything. A gate that always refuses is not
        // a conservative gate, it is a disconnected one wearing a verdict.
        const verdict = admitMemory({ ...episode, verified: ok }, {})
        if (verdict.promoted) appendRaw({ ...episode, id: `${episode.id}-promoted`, kind: "promoted", claimsCode: false, origin: { kind: "promotion", ref: episode.id, at: Date.now() } }, {})

        if (ok) editedBySession.delete(sessionID)

        // The outcome is attributed to what was actually in the turn: the episode itself, plus the
        // memories that were served INTO it. Never to the rest of the store — a memory that was not in
        // the context cannot have co-occurred with the result, and crediting it would move the counters
        // while making them mean nothing.
        recordOutcome([episode.id, ...ids], ok)
      } catch {
        // A counter that fails to move is a measurement gap. A counter that breaks the run is a defect.
      }
    },
  })
