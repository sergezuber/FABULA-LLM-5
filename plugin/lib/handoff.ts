// Durable, STRUCTURED cross-agent/overnight handoff artifact (file-coordination, kept to
// a "structured + capped + threat-scanned, NEVER free-form" discipline so it composes into the
// workflow-graph instead of being deprecated). A producer (a moa candidate, an overnight scheduled run)
// leaves intel that survives the crash surfaces an in-context handoff loses — sub-agent crash, stale :4096
// re-attach, model swap, user Stop. READ is threat-scanned + untrusted-wrapped (read_handoff is in
// UNTRUSTED_TOOLS) because a handoff is attacker-INFLUENCEABLE data (it may carry web content a producer fetched).

import { promises as fs } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

// Under the engine data dir (app id "fabula"); FABULA_HANDOFF_DIR overrides for hermetic tests.
export const HANDOFF_DIR = process.env.FABULA_HANDOFF_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "fabula", "handoff")
const KEY_CAP = 64
const SUMMARY_CAP = 400
const DATA_CAP = 4000 // hard cap → never re-introduces the context-drowning / re-read surface (the #1 pain)

export interface Handoff { v: 1; session: string; from: string; summary: string; data: string; ts: number }

export function sanitizeKey(key: unknown): string | null {
  if (typeof key !== "string") return null
  const s = key.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, KEY_CAP)
  return s && s !== "." && s !== ".." ? s : null
}
export function handoffPath(key: string): string { return path.join(HANDOFF_DIR, `${key}.json`) }

export function buildHandoff(o: { session?: unknown; from?: unknown; summary?: unknown; data?: unknown }): Handoff {
  const data = typeof o.data === "string" ? o.data : JSON.stringify(o.data ?? "")
  return {
    v: 1,
    session: String(o.session ?? "").slice(0, 128),
    from: String(o.from ?? "agent").slice(0, 64),
    summary: String(o.summary ?? "").slice(0, SUMMARY_CAP),
    data: data.slice(0, DATA_CAP),
    ts: Date.now(),
  }
}
export function parseHandoff(raw: string): Handoff | null {
  try { const o = JSON.parse(raw); return o && o.v === 1 && typeof o.data === "string" ? (o as Handoff) : null } catch { return null }
}
export function renderHandoff(h: Handoff): string {
  return `handoff from ${h.from} (${new Date(h.ts).toISOString()})\nsummary: ${h.summary}\n\n${h.data}`
}

// Atomic write: a per-writer-unique tmp + rename, so two concurrent producers never leave a torn/half file
// (last rename wins cleanly; a reader always sees a complete valid JSON, never a partial one).
export async function writeHandoff(key: string, h: Handoff): Promise<void> {
  await fs.mkdir(HANDOFF_DIR, { recursive: true })
  const p = handoffPath(key)
  // W7: saving under an existing key used to destroy its predecessor outright — the record was simply
  // gone, not archived and not marked. That is the destructive-summarisation pattern the memory work is
  // built against: agents depend on raw experience and frequently disregard condensed experience even
  // when condensed is all they are given, and a store that overwrites cannot ever hand back what it
  // replaced. So the predecessor is APPENDED to a per-key history first and the successor records what
  // it supersedes. Nothing is lost; the current record is still one plain read at the same path.
  const prev = await readHandoff(key)
  if (prev) {
    const histPath = path.join(HANDOFF_DIR, `${key}.history.jsonl`)
    await fs.appendFile(histPath, JSON.stringify({ ...prev, supersededBy: h.ts, retiredAt: Date.now() }) + "\n", "utf8")
    ;(h as any).supersedes = (prev as any).id ?? prev.ts
    ;(h as any).previousVersion = prev.ts
  }
  const tmp = `${p}.${process.pid}.${Math.floor(Math.random() * 1e6)}.tmp`
  await fs.writeFile(tmp, JSON.stringify(h, null, 2), "utf8")
  await fs.rename(tmp, p)
}

/** Every version ever written under this key, oldest first, with the current one last. The history is
 *  append-only: this is what makes "the predecessor is recoverable" true rather than aspirational. */
export async function handoffHistory(key: string): Promise<Handoff[]> {
  const out: Handoff[] = []
  try {
    const raw = await fs.readFile(path.join(HANDOFF_DIR, `${key}.history.jsonl`), "utf8")
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      const h = parseHandoff(line)
      if (h) out.push(h)
    }
  } catch { /* no history yet — a key written once has none */ }
  const cur = await readHandoff(key)
  if (cur) out.push(cur)
  return out
}
export async function readHandoff(key: string): Promise<Handoff | null> {
  try { return parseHandoff(await fs.readFile(handoffPath(key), "utf8")) } catch { return null }
}
// Purge: remove handoffs created by a deleted session (orphan cleanup, called from fabula-purge-hook).
export async function removeHandoffsForSession(session: string): Promise<number> {
  let n = 0
  if (!session) return 0
  try {
    for (const f of await fs.readdir(HANDOFF_DIR)) {
      if (!f.endsWith(".json")) continue
      const p = path.join(HANDOFF_DIR, f)
      const h = parseHandoff(await fs.readFile(p, "utf8").catch(() => ""))
      if (h && h.session === session) { await fs.rm(p, { force: true }).catch(() => {}); n++ }
    }
  } catch {}
  return n
}
