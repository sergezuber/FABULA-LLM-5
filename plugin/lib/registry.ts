// FABULA Proof Registry — pure core (no IO). Content-addressing, receipt parsing, the search index,
// and source resolution. The plugin (fabula-registry.ts) does the git/fs/network IO on top of this;
// everything decision-shaped lives here so it is unit-tested without a git repo or network.
//
// A "receipt" is the fabula-receipt/v0 JSON already minted by fabula-receipt.ts. The registry never
// invents a verdict — it only addresses, stores, finds and re-verifies what a green run left behind.

import { createHash } from "node:crypto"

export type ReceiptV0 = {
  version: string
  mintedAt?: number
  model?: { id?: string; host?: string }
  task?: string
  base?: string
  gates?: { id: string; forced?: string }[]
  artifact?: { kind?: string; files?: number; bytes?: number; patch?: string }
  verification?: { cmd?: string; exitCode?: number; passed?: boolean; outputTail?: string }
  replay?: string
}

// Content-addressed id = sha256 of the two things that make a receipt re-verifiable: the patch bytes
// and the exact verification command. Same fix + same check ⇒ same id, so the registry dedupes across
// machines and a receipt's id can't be forged without changing what it proves.
export function receiptId(patch: string, verifyCmd: string): string {
  return createHash("sha256").update(patch, "utf8").update("\n--verify--\n").update(verifyCmd, "utf8").digest("hex")
}

// Sharded store path keeps any one directory small: proofs/ab/cd/<rest>.
export function receiptStorePath(id: string): string {
  return `proofs/${id.slice(0, 2)}/${id.slice(2, 4)}/${id.slice(4)}`
}

export function parseReceipt(text: string): { ok: true; receipt: ReceiptV0 } | { ok: false; error: string } {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: "not valid JSON: " + (e instanceof Error ? e.message : String(e)) }
  }
  if (!j || typeof j !== "object") return { ok: false, error: "receipt is not an object" }
  const r = j as ReceiptV0
  if (typeof r.version !== "string" || !r.version.startsWith("fabula-receipt/"))
    return { ok: false, error: "not a fabula receipt (missing/foreign version field)" }
  if (!r.verification || typeof r.verification.cmd !== "string")
    return { ok: false, error: "receipt has no captured verification command — cannot be re-verified" }
  return { ok: true, receipt: r }
}

export type IndexEntry = {
  id: string
  task: string
  model: string
  host: string
  gates: string[]
  passed: boolean
  base: string
  mintedAt: number
}

export function indexEntry(id: string, r: ReceiptV0): IndexEntry {
  return {
    id,
    task: (r.task || "").replace(/^"+|"+$/g, "").slice(0, 300),
    model: r.model?.id || "unknown",
    host: r.model?.host || "unknown",
    gates: (Array.isArray(r.gates) ? r.gates : []).map((g) => g?.id).filter(Boolean),
    passed: r.verification?.passed === true,
    base: r.base || "",
    mintedAt: typeof r.mintedAt === "number" ? r.mintedAt : 0,
  }
}

// Every whitespace-separated term must be present (AND) across task/model/host/gate text.
export function matchesQuery(e: IndexEntry, q: string): boolean {
  const hay = `${e.task} ${e.model} ${e.host} ${e.gates.join(" ")}`.toLowerCase()
  return q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t))
}

export function searchIndex(
  entries: IndexEntry[],
  query: string,
  opts?: { model?: string; limit?: number },
): IndexEntry[] {
  const model = opts?.model?.toLowerCase()
  const out = entries
    .filter((e) => (query.trim() ? matchesQuery(e, query) : true))
    .filter((e) => (model ? e.model.toLowerCase().includes(model) : true))
    .sort((a, b) => b.mintedAt - a.mintedAt)
  return typeof opts?.limit === "number" && opts.limit >= 0 ? out.slice(0, opts.limit) : out
}

// Upsert an index entry by id (a republish of the same content-addressed receipt replaces, not duplicates).
export function upsertIndex(entries: IndexEntry[], next: IndexEntry): IndexEntry[] {
  const rest = entries.filter((e) => e.id !== next.id)
  return [next, ...rest]
}

export type Source =
  | { kind: "id"; id: string }
  | { kind: "file"; path: string }
  | { kind: "http"; url: string }

// What a `verify_receipt` argument points at: a 64-hex content id (look up in the local store),
// an http(s) URL, or a filesystem path (bare or file://).
export function resolveSource(input: string): Source {
  const s = input.trim()
  if (/^https?:\/\//i.test(s)) return { kind: "http", url: s }
  if (/^[0-9a-f]{64}$/i.test(s)) return { kind: "id", id: s.toLowerCase() }
  if (/^file:\/\//i.test(s)) return { kind: "file", path: s.replace(/^file:\/\//i, "") }
  return { kind: "file", path: s }
}

// Turn a configured git remote into a browsable https URL for the stored receipt, so publish can
// return a real link (not a fabricated one). Returns null when the remote shape is unrecognized.
export function publicUrl(remote: string | undefined, id: string): string | null {
  if (!remote) return null
  const store = receiptStorePath(id)
  const gh = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?\/?$/i)
  if (gh) return `https://github.com/${gh[1]}/${gh[2]}/tree/main/${store}`
  if (/^https?:\/\//i.test(remote)) return `${remote.replace(/\.git$|\/$/g, "")}/tree/main/${store}`
  return null
}
