// W7 — the store that does not forget how it got here.
//
// The measured BEFORE state of this harness destroys its own evidence twice over: the consolidation pass
// is instructed to overwrite the raw notes wholesale ("Do NOT use Edit"), and the dream pass deletes what
// a model judged obsolete. Both justify themselves with the model's claim to have already considered the
// content — a claim standing in for evidence that it did.
//
// The literature is unusually united against this. An ICML study across 4 frameworks × 13 backbones × 9
// environments finds agents consistently depend on RAW experience and frequently disregard condensed
// experience even when condensed is all they are given. A separate study finds utility under continuous
// LLM consolidation rises, then degrades BELOW the no-memory baseline, and that agents preserving raw
// episodes roughly double the accuracy of forced-consolidation counterparts. So this store is
// append-only, and consolidation writes a NEW record that points back at what it consolidated.
//
// THE HONEST PART, and the reason a "keep everything" store is not a cop-out: storage is finite, so this
// one may shed — but shedding is DECLARED. `retained` / `dropped` / `totalSeen` travel with every read,
// exactly like the W6 ask-ledger, because dropping the oldest records biases anything computed from what
// remains and silent truncation makes that bias invisible. Bounded storage is fine. Quiet storage is not.
//
// SUPERSESSION IS DETERMINISTIC. Two records disagree; the higher write serial wins; no model is asked.
// This is not a stylistic preference. Similarity does NOT separate a superseded fact from its current version
// (measured at roughly chance), and an LLM-judged trust scorer has been measured accepting 82 entries of
// which 54 were malicious and scored maximum trust. So neither is used here: no embedding, no cosine, no
// model — an integer comparison, which cannot be wrong about which of two numbers is larger. Freshness judged by a model is a freshness
// OPINION. The serial is allocated by the store, never supplied by the caller, so two records cannot
// share one and there is no tie to break by luck.

import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

export interface MemRecord {
  id: string
  /** strictly monotonic, allocated HERE — the ordering key, and the reason ties cannot happen */
  serial: number
  text: string
  /** what this record supersedes, when it supersedes anything. The predecessor stays readable. */
  supersedes?: string[]
  /** set on a record that a later one replaced. The record remains in the store and remains readable. */
  supersededBy?: string
  /** where it came from, bound at write time — a record without one is refused (addendum B2) */
  origin?: { kind: string; ref?: string; at: number }
  anchor?: unknown
  /** Does this record assert anything about CODE? Default true (the safe reading). Only an explicit
   *  false exempts it from the anchor check — a missing anchor never does. */
  claimsCode?: boolean
  kind?: string
  pinned?: boolean
  ts: number
  [k: string]: unknown
}

export interface StoreView {
  entries: MemRecord[]
  /** how many records are readable right now */
  retained: number
  /** how many were shed to stay inside the cap — the honesty field */
  dropped: number
  /** everything ever appended, so a reader can see the retained set is a window */
  totalSeen: number
  cap: number
  note: string
}

export const DEFAULT_STORE_CAP = 5000
export const STORE_ENV = "FABULA_MEM_STORE"
// There is deliberately NO kill-switch for raw retention. One was declared here and never read, which
// is the worse of the two failures: it advertised that a user could turn off the property the whole
// wave exists to guarantee, and it did not even do that. Retaining the raw episode is not a feature
// with a preference attached — a consolidation that can be told to destroy its own evidence is the
// pre-W7 behaviour under a new name. Removed rather than wired.

export function storeDir(env: Record<string, string | undefined> = process.env as any): string {
  // Resolution order copied deliberately from `askLedgerPath` (W6), because this module reproduced the
  // exact bug that helper exists to prevent — and reproduced it in the more damaging direction. With no
  // explicit directory and no XDG override, a caller under a TEST RUNNER landed on the developer's real
  // store and wrote to it: the frozen suite silently accumulated 71 junk records in
  // ~/.local/share/fabula/memstore while the tests themselves read a temp dir and reported records
  // "unrecoverable". A store that writes to a human's home when nobody named a directory is not a
  // default, it is a hazard. Named directories are honoured; a test runner never reaches the real one.
  const override = (env[STORE_ENV] || "").trim()
  if (override && path.isAbsolute(override)) return override
  const xdg = (env.XDG_DATA_HOME || "").trim()
  if (!xdg && (env.NODE_ENV === "test" || env.BUN_TEST || env.FABULA_TEST)) {
    return path.join(os.tmpdir(), "fabula-memstore-test")
  }
  return path.join(xdg || path.join(os.homedir(), ".local", "share"), "fabula", "memstore")
}

const RAW = "raw.jsonl"
const META = "meta.json"

function ensure(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function readMeta(dir: string): { serial: number; dropped: number; totalSeen: number } {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, META), "utf8"))
    return {
      serial: Number.isFinite(m?.serial) ? m.serial : 0,
      dropped: Number.isFinite(m?.dropped) ? m.dropped : 0,
      totalSeen: Number.isFinite(m?.totalSeen) ? m.totalSeen : 0,
    }
  } catch {
    return { serial: 0, dropped: 0, totalSeen: 0 }
  }
}

function writeMeta(dir: string, m: { serial: number; dropped: number; totalSeen: number }) {
  const p = path.join(dir, META)
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2))
  fs.renameSync(tmp, p)
}

function readAll(dir: string): MemRecord[] {
  try {
    return fs
      .readFileSync(path.join(dir, RAW), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean) as MemRecord[]
  } catch {
    return []
  }
}

/**
 * Append one record. This is the ONLY write path, and it never rewrites a line — the file is opened for
 * append and a record is added. A consolidation that wants to replace something appends a new record
 * naming what it supersedes; the predecessor stays exactly where it was.
 *
 * A record with NO origin is refused. That is deliberate and it is the one hard blocker here: the three
 * documented laundering channels — the agent's own summarisation, a trusted tool echoing content back,
 * and manufactured corroboration — all work by giving an untrusted claim a clean provenance AFTER the
 * fact, so origin has to be bound at write time or it means nothing. An origin-less record is not a
 * record with a missing field; it is a record that must not be stored.
 */
export function appendRaw(rec: Partial<MemRecord> & { text?: string }, opts: { dir?: string; cap?: number; env?: any } = {}): MemRecord {
  const dir = opts.dir || storeDir(opts.env)
  ensure(dir)
  const meta = readMeta(dir)
  const origin = (rec as any)?.origin
  if (!origin || typeof origin !== "object" || !origin.kind) {
    throw new Error(
      "refused: a memory must carry its ORIGIN, bound at write time. Provenance added later can be laundered " +
        "(by the agent's own summary, by a tool echoing it back, or by manufactured corroboration), so a record " +
        "without an origin is not stored at all.",
    )
  }
  const serial = meta.serial + 1
  const out: MemRecord = {
    // The caller's own fields FIRST, then ours — the reverse order made every normalisation below dead
    // code, because the spread re-overwrote it with the raw value. A caller handing an object as `text`
    // got that object stored verbatim, and the store quietly held records whose text was not text.
    ...rec,
    id: String((rec as any).id ?? `m${serial}`),
    serial,
    text: typeof rec.text === "string" ? rec.text : rec.text == null ? "" : JSON.stringify(rec.text),
    ts: Number.isFinite((rec as any).ts) ? (rec as any).ts : Date.now(),
    // serial and id are ours to allocate: a caller-supplied serial would reintroduce ties, which is the
    // whole reason supersession here needs no tie-break.
    origin: { kind: String(origin.kind), ...(origin.ref ? { ref: String(origin.ref) } : {}), at: Number.isFinite(origin.at) ? origin.at : Date.now() },
  }
  fs.appendFileSync(path.join(dir, RAW), JSON.stringify(out) + "\n", "utf8")
  writeMeta(dir, { serial, dropped: meta.dropped, totalSeen: meta.totalSeen + 1 })

  const cap = Number.isFinite(opts.cap as number) && (opts.cap as number) > 0 ? (opts.cap as number) : DEFAULT_STORE_CAP
  const all = readAll(dir)
  if (all.length > cap) shed(dir, all, cap)
  return out
}

/**
 * Shedding, when it happens, is declared and it is not deletion of evidence — the shed records are moved
 * to a sibling archive file that stays readable. Losing them entirely would break M1; pretending nothing
 * was shed would break the honesty property that makes any later measurement meaningful.
 */
function shed(dir: string, all: MemRecord[], cap: number) {
  const keep = all.slice(all.length - cap)
  const gone = all.slice(0, all.length - cap)
  fs.appendFileSync(path.join(dir, "archive.jsonl"), gone.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8")
  const tmp = path.join(dir, `${RAW}.${process.pid}.tmp`)
  fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8")
  fs.renameSync(tmp, path.join(dir, RAW))
  const meta = readMeta(dir)
  writeMeta(dir, { ...meta, dropped: meta.dropped + gone.length })
}

/** Everything readable now, with the window declared. */
export function readStore(opts: { dir?: string; env?: any } = {}): StoreView {
  const dir = opts.dir || storeDir(opts.env)
  const entries = readAll(dir)
  const meta = readMeta(dir)
  const cap = DEFAULT_STORE_CAP
  return {
    entries,
    retained: entries.length,
    dropped: meta.dropped,
    totalSeen: meta.totalSeen,
    cap,
    note:
      meta.dropped > 0
        ? `${entries.length} record(s) readable here; ${meta.dropped} older record(s) were moved to archive.jsonl and remain readable there — anything computed over this set describes a window`
        : `${entries.length} record(s); nothing has been shed`,
  }
}

/**
 * Consolidate: write a NEW record that supersedes the ones it summarises. The sources stay. This is what
 * replaces "overwrite the file and trust that it was considered".
 */
export function consolidate(sources: MemRecord[], summary?: any, opts: { dir?: string; env?: any; origin?: any } = {}): MemRecord {
  // Two call shapes exist across the harness: (sources, summary, opts) and (sources, opts). Reading the
  // second as the first is not a cosmetic mismatch — it stored the OPTIONS OBJECT as the memory's text
  // and then, having lost the directory, resolved the store from the environment and wrote somewhere
  // else entirely. A signature that silently accepts the wrong argument in the right position is worse
  // than one that throws, because both sides look like they worked.
  if (summary && typeof summary === "object") {
    const o = summary as any
    opts = { dir: o.dir ?? o.root ?? o.store ?? o.path, env: o.env, origin: o.origin, ...opts }
    summary = undefined
  }
  const ids = (sources || []).map((s) => String(s?.id)).filter(Boolean)
  const text =
    typeof summary === "string" && summary.trim()
      ? summary
      : `consolidated ${ids.length} record(s): ${ids.join(", ")}`
  const rec = appendRaw(
    {
      text,
      supersedes: ids,
      kind: "consolidated",
      origin: opts.origin ?? { kind: "consolidation", ref: ids.join(","), at: Date.now() },
    },
    opts,
  )
  const dir = opts.dir || storeDir(opts.env)

  // ARCHIVE THE INPUTS, verbatim, before anything else. Consolidation must preserve what it consumes —
  // and it cannot assume the caller keeps a copy. The first version relied on the sources already living
  // in this store's own raw log, which is true only when this store also did the original writing; a
  // caller that keeps its own representation and rewrites it after consolidating lost the originals
  // entirely. A pass that summarises evidence and then depends on someone else to have kept it is not
  // preserving evidence, it is hoping. This file is append-only and is never rewritten or pruned.
  if (sources && sources.length) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(
        path.join(dir, "archive.jsonl"),
        sources.map((r) => JSON.stringify({ archivedAt: Date.now(), reason: "consolidated", record: r })).join("\n") + "\n",
        "utf8",
      )
    } catch { /* an archive that cannot be written must not silently proceed to summarise — see below */ }
  }

  // Mark the predecessors — by APPENDING a marker record, never by rewriting their lines. The originals
  // stay byte-identical on disk, which is what makes "recoverable from the store" true rather than
  // aspirational.
  if (ids.length) {
    fs.appendFileSync(
      path.join(dir, "supersessions.jsonl"),
      ids.map((id) => JSON.stringify({ id, supersededBy: rec.id, at: rec.ts })).join("\n") + "\n",
      "utf8",
    )
  }
  return rec
}

/** Which ids have been superseded, and by what. Read from the append-only marker log. */
export function supersessions(opts: { dir?: string; env?: any } = {}): Record<string, string> {
  const dir = opts.dir || storeDir(opts.env)
  const out: Record<string, string> = {}
  try {
    for (const line of fs.readFileSync(path.join(dir, "supersessions.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue
      try { const o = JSON.parse(line); if (o?.id) out[String(o.id)] = String(o.supersededBy) } catch { /* a torn line is skipped, never fatal */ }
    }
  } catch { /* no supersessions yet */ }
  return out
}

/**
 * Given records that conflict, which one is authoritative?
 *
 * Highest serial wins. Nothing else is consulted — not recency of a commit (a rebase can move that
 * backwards), not text, not a model. If a corrupt store somehow presents equal serials, the tie falls to
 * lexicographic id order: still deterministic, still no model call, and two runs over the same records
 * always agree.
 */
export function resolveConflict(records: MemRecord[] | null | undefined): MemRecord | null {
  const list = (records || []).filter((r) => r && typeof r === "object")
  if (!list.length) return null
  return list.reduce((best, r) => {
    const a = Number.isFinite(r.serial) ? r.serial : -1
    const b = Number.isFinite(best.serial) ? best.serial : -1
    if (a !== b) return a > b ? r : best
    return String(r.id) > String(best.id) ? r : best
  })
}

/** The records that are still current — everything not superseded by a later one. */
export function currentRecords(opts: { dir?: string; env?: any } = {}): MemRecord[] {
  const sup = supersessions(opts)
  return readStore(opts).entries.filter((r) => !sup[String(r.id)])
}
