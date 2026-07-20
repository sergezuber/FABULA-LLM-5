// W7 — binding a memory to something that can be CHECKED.
//
// Every memory system in the current literature detects staleness probabilistically, because their
// domains have no oracle, so they must compare embeddings and hope — and the measured result is that a
// superseded fact and its current version are NOT separable that way (AUROC ~0.59, barely above chance).
// This module therefore uses no embedding and no cosine at all: it hashes bytes and compares them. A coding harness is not in that position. `git` is a deterministic, sub-millisecond oracle
// for "has this code changed since the memory was written", and this module is the whole of the
// argument: bind the memory to the code, re-check the binding, and never ask a model whether a fact is
// still true.
//
// TWO decisions in here are load-bearing and were made against easier alternatives.
//
// 1. BOUND AT WRITE TIME, never re-derived. An anchor computed when the memory is SERVED would always
//    match, which is a mechanism that reports perfect freshness and detects nothing. Worse, an anchor
//    re-derived later can be laundered: the three documented channels that scrub the origin of an
//    untrusted memory — the agent's own summarisation, a trusted tool echoing content back, and
//    manufactured corroboration — all work by giving a claim a fresh provenance after the fact. The sha
//    recorded at write time is the one thing none of them can forge, because it is a statement about a
//    file that either did or did not contain those bytes.
//
// 2. THE SYMBOL, NOT THE FILE. Hashing the whole file blob is one line of code and it makes the
//    mechanism useless: on an actively edited file every memory about it invalidates on every unrelated
//    commit, staleness fires constantly, and a signal that fires constantly is one that gets switched
//    off within a week. So when a memory names a symbol we hash THAT SPAN, and a change elsewhere in the
//    file does not invalidate it. The file blob is kept alongside as evidence and used as the fallback
//    when no symbol can be located.
//
// What this is NOT: a parser. `symbolSpan` is a deliberately modest heuristic over text, and it says so
// where it gives up. A missed span degrades to file-level anchoring — noisier, never wrong.

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

/** How the anchor was scoped. `symbol` is the good case; `file` means we could not locate the span and
 *  fell back, which is worth knowing when reading why something reported stale. */
export type AnchorKind = "symbol" | "file"

export interface Anchor {
  /** repo-relative path, POSIX separators — an anchor must mean the same thing on two machines */
  path: string
  /** the symbol this memory is about, when it names one */
  symbol?: string
  /** git's blob sha of the WHOLE file at write time. Always present: it is the evidence half. */
  sha: string
  /** sha256 of the symbol's span at write time. Present only when the span was located. */
  symbolSha?: string
  kind: AnchorKind
  /** when the binding was made — write time, by definition */
  writtenAt: number
}

export interface AnchorVerdict {
  ok: boolean
  /** why, in one line, for a log and for the record that gets stored next to the decision */
  reason: string
  /** what specifically no longer matches — the useful half when ok is false */
  changed?: "missing" | "symbol" | "file" | "symbol-gone"
}

/**
 * git's own blob object id, computed without shelling out.
 *
 * `git hash-object` is sha1 over the header `blob <bytelength>\0` followed by the content, so this is
 * byte-identical to what git would report — verified against the real command in the tests. Computing it
 * natively matters: an anchor check runs on the serve path, and spawning a process there would put tens
 * of milliseconds in front of every memory, which is how a correctness mechanism becomes a latency
 * problem and then an off switch.
 */
export function gitBlobSha(content: Buffer | string): string {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8")
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex")
}

const DECL = [
  // one pattern per family, each requiring the NAME to follow the keyword — a bare mention of the
  // symbol elsewhere in the file must not be mistaken for its declaration.
  (s: string) => new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${s}\\b`),
  (s: string) => new RegExp(`^\\s*(?:export\\s+)?(?:abstract\\s+)?class\\s+${s}\\b`),
  (s: string) => new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${s}\\b`),
  (s: string) => new RegExp(`^\\s*(?:export\\s+)?(?:interface|type|enum)\\s+${s}\\b`),
  (s: string) => new RegExp(`^\\s*(?:async\\s+)?def\\s+${s}\\b`), // python
  (s: string) => new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${s}\\b`), // go
  (s: string) => new RegExp(`^\\s*(?:pub\\s+)?fn\\s+${s}\\b`), // rust
  (s: string) => new RegExp(`^\\s*${s}\\s*[:(]`), // object method / bare declaration
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Locate the line range a symbol occupies. Returns null when it cannot be found — which is a normal
 * outcome, not an error, and the caller falls back to file scope.
 *
 * The extent is decided by the shape of the declaration line: braces are followed to balance, a trailing
 * colon takes the indented block beneath it, and anything else is a single line. This is enough for the
 * question actually being asked — "did the code this memory is about change" — and it is honest about
 * being a heuristic rather than pretending to parse nine languages.
 */
export function symbolSpan(text: string, symbol: string): { start: number; end: number } | null {
  if (!text || !symbol) return null
  const sym = escapeRe(symbol)
  const lines = text.split("\n")
  let start = -1
  for (let i = 0; i < lines.length && start < 0; i++) {
    for (const p of DECL) if (p(sym).test(lines[i]!)) { start = i; break }
  }
  if (start < 0) return null

  const head = lines[start]!
  const opens = (head.match(/\{/g) || []).length
  const closes = (head.match(/\}/g) || []).length
  if (opens > closes) {
    let depth = opens - closes
    for (let i = start + 1; i < lines.length; i++) {
      // Brace counting is confused by braces inside strings and comments. For "did this span change"
      // that costs a slightly wrong boundary at worst, never a wrong ANSWER: the same rule runs at write
      // time and at check time, so both hash the same span.
      depth += (lines[i]!.match(/\{/g) || []).length - (lines[i]!.match(/\}/g) || []).length
      if (depth <= 0) return { start, end: i }
    }
    return { start, end: lines.length - 1 }
  }
  if (/:\s*(?:#.*)?$/.test(head)) {
    const indent = (head.match(/^\s*/) || [""])[0]!.length
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]!
      if (!l.trim()) continue
      if ((l.match(/^\s*/) || [""])[0]!.length <= indent) return { start, end: i - 1 }
    }
    return { start, end: lines.length - 1 }
  }
  return { start, end: start }
}

function spanText(text: string, span: { start: number; end: number }): string {
  return text.split("\n").slice(span.start, span.end + 1).join("\n")
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")

function resolve(input: any, maybeSymbol?: any, maybeRoot?: any): { abs: string; rel: string; symbol?: string; root: string } | null {
  // Call sites across the harness spell this several ways; refusing a spelling would read as "no anchor"
  // and silently disable the mechanism, which is the failure this whole module exists to prevent.
  let p: string | undefined
  let symbol: string | undefined
  let root: string | undefined
  if (input && typeof input === "object") {
    p = input.path ?? input.file ?? input.abs
    symbol = input.symbol ?? input.name
    root = input.root ?? input.dir ?? input.cwd
  } else if (typeof input === "string") {
    p = input
    if (typeof maybeSymbol === "string") symbol = maybeSymbol
    else if (maybeSymbol && typeof maybeSymbol === "object") {
      symbol = maybeSymbol.symbol ?? maybeSymbol.name
      root = maybeSymbol.root ?? maybeSymbol.dir ?? maybeSymbol.cwd
    }
    if (typeof maybeRoot === "string") root = maybeRoot
  }
  if (!p) return null
  // (root, relPath, symbol) — the one form where the FIRST argument is the root
  if (typeof input === "string" && typeof maybeSymbol === "string" && typeof maybeRoot === "string") {
    const asRootFirst = path.join(input, maybeSymbol)
    if (!path.isAbsolute(maybeSymbol) && fs.existsSync(asRootFirst) && !fs.existsSync(path.isAbsolute(p) ? p : path.join(input, p))) {
      return { abs: asRootFirst, rel: maybeSymbol.split(path.sep).join("/"), symbol: maybeRoot, root: input }
    }
  }
  root = root || (path.isAbsolute(p) ? path.dirname(p) : process.cwd())
  const abs = path.isAbsolute(p) ? p : path.join(root, p)
  const rel = path.relative(root, abs).split(path.sep).join("/")
  return { abs, rel, symbol, root }
}

/**
 * Bind a memory to code. Returns null when the file cannot be read — a memory about a file that does not
 * exist has nothing to be anchored to, and inventing an anchor for it would be worse than having none.
 */
export function anchorFor(input: any, maybeSymbol?: any, maybeRoot?: any): Anchor | null {
  const r = resolve(input, maybeSymbol, maybeRoot)
  if (!r) return null
  let raw: Buffer
  try { raw = fs.readFileSync(r.abs) } catch { return null }
  const text = raw.toString("utf8")
  const sha = gitBlobSha(raw)
  const span = r.symbol ? symbolSpan(text, r.symbol) : null
  return {
    path: r.rel,
    ...(r.symbol ? { symbol: r.symbol } : {}),
    sha,
    ...(span ? { symbolSha: sha256(spanText(text, span)) } : {}),
    kind: span ? "symbol" : "file",
    writtenAt: Date.now(),
  }
}

/**
 * Does the anchor still describe the tree? Pure file I/O and hashing — no model call, no network, and
 * the same answer every time for the same bytes. That determinism is the point: a freshness check a
 * model performs is a freshness OPINION, and the measured accuracy of those opinions is why this module
 * exists.
 */
export function verifyAnchor(anchor: Anchor | null | undefined, root?: string): AnchorVerdict {
  if (!anchor || typeof anchor !== "object" || !anchor.path) {
    return { ok: false, reason: "no anchor: a memory with nothing to check against cannot be shown current.", changed: "missing" }
  }
  const base = root || process.cwd()
  const abs = path.isAbsolute(anchor.path) ? anchor.path : path.join(base, anchor.path)
  let raw: Buffer
  try { raw = fs.readFileSync(abs) } catch {
    return { ok: false, reason: `${anchor.path} no longer exists.`, changed: "missing" }
  }
  const text = raw.toString("utf8")

  if (anchor.kind === "symbol" && anchor.symbol && anchor.symbolSha) {
    const span = symbolSpan(text, anchor.symbol)
    if (!span) return { ok: false, reason: `${anchor.symbol} is no longer declared in ${anchor.path}.`, changed: "symbol-gone" }
    if (sha256(spanText(text, span)) !== anchor.symbolSha) {
      return { ok: false, reason: `${anchor.symbol} in ${anchor.path} has changed since this was recorded.`, changed: "symbol" }
    }
    // The file may well have moved on around it; that is exactly what symbol scope is for and is NOT a
    // mismatch. Saying so in the reason keeps the log honest about what was and was not checked.
    return { ok: true, reason: `${anchor.symbol} in ${anchor.path} is unchanged since this was recorded (the rest of the file was not checked).` }
  }

  if (gitBlobSha(raw) !== anchor.sha) {
    return { ok: false, reason: `${anchor.path} has changed since this was recorded.`, changed: "file" }
  }
  return { ok: true, reason: `${anchor.path} is byte-identical to when this was recorded.` }
}

/** The inverted spelling, because half the call sites ask the question the other way round. */
export function anchorStale(anchor: Anchor | null | undefined, root?: string): boolean {
  return !verifyAnchor(anchor, root).ok
}
