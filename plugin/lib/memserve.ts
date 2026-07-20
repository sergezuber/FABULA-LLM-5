// W7 — what actually reaches the model, and the one thing that must never accompany it.
//
// THE FALSIFIED DESIGN, stated first because it is the obvious one and it is wrong: serve the memory with
// a "possibly stale" badge and let the model weigh it. That was measured and it fails in every direction.
// Agents respond to LINGUISTIC CONFIDENCE MARKERS rather than to source reliability; attributed,
// unattributed and outright FORGED claims succeed at the same rate; passive verification tags are
// ignored; and explicit distrust instructions make the outcome WORSE, not better. A separate study found
// an LLM-judged trust scorer accepting 82 entries of which 54 were malicious and scored maximum trust.
//
// So a badge is not a weaker version of the right answer. It is a stimulus measured to degrade the
// decision, sitting next to evidence that would otherwise have been fine. This module therefore has
// exactly two permitted behaviours when an anchor no longer matches:
//
//   WITHHOLD — the memory does not reach the model at all, or
//   SERVE THE RAW EVIDENCE — the code as it is NOW, with no staleness, confidence or trust language
//   attached to it whatsoever.
//
// "Here is the current code" carries every bit of the information a badge was trying to convey, and it
// carries it in the one form the failure mode does not apply to: a fact instead of a hedge.
//
// The frozen acceptance suite permits the weaker reading (badge PLUS raw). This module implements the
// stricter one deliberately — a wave that builds exactly what its tests check has been taught to the test.

import { verifyAnchor, type Anchor } from "./memanchor"
import { worthOf, shouldDemote } from "./memworth"

export type ServeMode = "withhold" | "evidence"

export interface Servable {
  id?: string
  text?: string
  anchor?: Anchor | null
  pinned?: boolean
  kind?: string
  [k: string]: unknown
}

export interface ServeResult {
  /** what reaches the model — already free of any confidence language by construction */
  entries: Servable[]
  /** rendered block, or "" when nothing survived */
  text: string
  /** ids that did not survive the anchor check, for the log and the ledger — NOT for the model */
  withheld: string[]
  /** ids served as current code rather than as remembered prose */
  reGrounded: string[]
  reason: string
}

export const SERVE_MODE_ENV = "FABULA_MEM_STALE_MODE"

function modeFrom(env: Record<string, string | undefined> = process.env as any): ServeMode {
  const raw = String(env[SERVE_MODE_ENV] ?? "").trim().toLowerCase()
  return raw === "evidence" ? "evidence" : "withhold"
}

/**
 * The guard that makes the rule enforceable rather than aspirational.
 *
 * Every one of these is a phrase this module must never emit. It runs over its OWN output before that
 * output is returned, because the rule is easy to state and easy to break later by adding one helpful
 * word — and a rule nothing checks is a comment.
 */
const FORBIDDEN_IN_OUTPUT: RegExp[] = [
  /possibly\s+stale/i, /may\s+be\s+stale/i, /might\s+be\s+stale/i, /potentially\s+(stale|outdated|obsolete)/i,
  /\bstale\b/i, /\boutdated\b/i, /\bobsolete\b/i, /\bunverified\b/i, /\bunconfirmed\b/i,
  /may\s+(be|no\s+longer\s+be)\s+(true|accurate|current|valid|correct)/i,
  /no\s+longer\s+(be\s+)?(true|accurate|current|valid)/i,
  /\blow\s+confidence\b/i, /confidence[:=]\s*(low|0\.[0-9])/i,
  /treat\s+with\s+(caution|suspicion)/i, /do\s+not\s+(fully\s+)?trust/i, /don'?t\s+trust/i,
  /\buse\s+with\s+caution\b/i, /\bsuspect\b/i, /⚠️?\s*stale/i, /\[stale\]/i, /\(stale\)/i,
]

/** Does this text carry any of the language that must never reach the model? */
export function confidenceLanguage(text: string): string[] {
  return FORBIDDEN_IN_OUTPUT.filter((r) => r.test(String(text ?? ""))).map((r) => r.source)
}

/** Field names the raw episodic trace travels under, across the call sites that produce these records. */
const RAW_FIELDS = [
  "raw", "rawTrace", "rawEvidence", "evidence", "episode", "source", "sourceText",
  "excerpt", "quote", "trace", "transcript",
]

/**
 * What a served record is allowed to CARRY.
 *
 * Raw is the authoritative store and the escalation evidence — it is not cross-task retrieval material.
 * Low-level raw traces induce measurably NEGATIVE transfer across domains (only the high-level insight
 * generalises), so a raw trace from another task must not ride along inside a served record even when
 * nothing renders it: whatever holds the object can read it, and "nothing prints it today" is not a
 * property, it is a coincidence waiting to be broken by the next renderer.
 */
function project(c: Servable, sameTask: boolean): Servable {
  if (sameTask) return c
  const out: Servable = { ...c }
  for (const f of RAW_FIELDS) delete (out as any)[f]
  return out
}

function taskOf(x: any): string | undefined {
  if (!x || typeof x !== "object") return undefined
  return x.task ?? x.taskID ?? x.taskId
}


/** Worth carried ON the record wins over the store: a caller that measured this run already knows more
 *  about it than a file written before the run started. Unmeasured is NEUTRAL — never zero, because a
 *  memory nobody has scored yet must not be ranked below one measured to be useless. */
function worthRatio(c: Servable, opts: any): number | null {
  const h = (c as any).helped, u = (c as any).hurt
  if (Number.isFinite(h) && Number.isFinite(u) && h + u > 0) return h / (h + u)
  const v = worthOf(c, opts)
  return v.ratio
}

/** How many entries the caller will take, if it said. */
function limitOf(ctx: any): number | null {
  if (!ctx || typeof ctx !== "object") return null
  for (const k of ["limit", "maxEntries", "k", "topK"]) {
    const v = ctx[k]
    if (Number.isFinite(v) && v > 0) return Math.floor(v)
  }
  return null
}

/** Demotion by measured worth — out of what gets SERVED, never out of the store. A memory that has been
 *  in context for five runs and helped in fewer than a third of them stops being offered; it stays
 *  readable, because a utility signal is not evidence that something never happened. */
function demoted(c: Servable, opts: any): boolean {
  const h = (c as any).helped, u = (c as any).hurt
  if (Number.isFinite(h) && Number.isFinite(u) && h + u >= 5) return h / (h + u) < 0.34
  return shouldDemote(c, opts)
}

function ctxRoot(ctx: any): string | undefined {
  if (typeof ctx === "string") return ctx
  if (ctx && typeof ctx === "object") return ctx.root ?? ctx.dir ?? ctx.cwd ?? ctx.directory ?? ctx.repo ?? ctx.worktree
  return undefined
}

/**
 * Decide what reaches the model.
 *
 * A memory whose anchor still matches is served as it is. A memory whose anchor has moved is withheld by
 * default; with `evidence` mode it is replaced by the code as it stands now — the raw source, unlabelled.
 * Nothing in either path emits a hedge.
 */
export function serveMemories(candidates: Servable[] | null | undefined, ctx?: any): ServeResult {
  const list = (candidates || []).filter((c) => c && typeof c === "object")
  const root = ctxRoot(ctx)
  const mode = modeFrom((ctx && typeof ctx === "object" && ctx.env) || undefined)
  const entries: Servable[] = []
  const withheld: string[] = []
  const reGrounded: string[] = []
  const here = taskOf(ctx)
  const same = (c: Servable) => {
    const t = taskOf(c)
    // A record with no task of its own is not "from another task" — it is unscoped, and treating it as
    // foreign would quietly drop every memory written before tasks were tracked.
    return !t || !here || t === here
  }

  for (const c of list) {
    // A pinned constraint is not a claim about code and has no anchor to move; it is served regardless.
    // This is the one exemption, and it exists because a compaction pass dropping a hard constraint took
    // measured violation rates from 0% to 30%.
    if (c.pinned || c.kind === "constraint") {
      entries.push(project(c, same(c)))
      continue
    }
    // A record that DECLARES it makes no claim about code has nothing that can go stale, so there is
    // nothing to check. The declaration is load-bearing and must be explicit: an ABSENT anchor is not the
    // same statement as "this is not about code". Treating a missing field as the exemption would turn
    // every unanchored claim into a served one and gut M3/M4 — which is precisely what happened when the
    // production writer recorded no anchor at all: every record was withheld and the model received an
    // empty memory block, with the anchor mechanism vacuously "satisfied".
    if ((c as any).claimsCode === false) {
      entries.push(project(c, same(c)))
      continue
    }
    if (demoted(c, (ctx && typeof ctx === "object" && { dir: ctx.worthDir, env: ctx.env }) || {})) {
      withheld.push(String(c.id ?? ""))
      continue
    }
    const v = verifyAnchor((c.anchor as Anchor) ?? null, root)
    if (v.ok) {
      entries.push(project(c, same(c)))
      continue
    }
    if (mode === "evidence") {
      const now = currentEvidence(c, root)
      if (now !== null) {
        // Served as the code, not as a remembered claim about it. No adjective anywhere.
        entries.push({ ...project(c, same(c)), text: now, kind: "evidence" })
        reGrounded.push(String(c.id ?? ""))
        continue
      }
    }
    withheld.push(String(c.id ?? ""))
  }

  // Rank by measured worth before any budget is applied: when only some entries fit, the ones that have
  // actually helped are the ones that should be there. Unmeasured entries sit at neutral so a brand-new
  // memory is not outranked by a measured-useless one.
  const wOpts = (ctx && typeof ctx === "object" && { dir: ctx.worthDir, env: ctx.env }) || {}
  const ranked = entries
    .map((e, i) => ({ e, i, r: e.pinned || e.kind === "constraint" ? 2 : (worthRatio(e, wOpts) ?? 0.5) }))
    .sort((a, b) => (b.r - a.r) || (a.i - b.i))
    .map((x) => x.e)
  const lim = limitOf(ctx)
  const kept = lim === null ? ranked : ranked.slice(0, lim)
  entries.length = 0
  entries.push(...kept)

  const text = entries.map((e) => String(e.text ?? "")).filter(Boolean).join("\n\n")
  // Self-check on what THIS MODULE ADDS, never on what a memory happens to say.
  //
  // The first version scanned the whole rendered block, and that was a live footgun rather than a
  // safeguard: a perfectly legitimate memory whose own text contains "stale", "unverified" or "obsolete"
  // made this throw — and the caller swallows the throw, so the ENTIRE memory block silently vanished for
  // that turn. The engine's own dream pass is instructed to write "[unverified]" into memory, so the
  // failure was reachable by design, not by accident. The rule being enforced is "the server must not
  // ATTACH hedging to a memory"; the memory's own words are content, and content is not the server's
  // voice. So the check runs over the difference: the rendered block minus every entry's own text.
  const ownText = new Set(entries.map((e) => String(e.text ?? "")))
  const added = text
    .split("\n\n")
    .filter((chunk) => !ownText.has(chunk))
    .join("\n\n")
  const leaked = confidenceLanguage(added)
  if (leaked.length) {
    throw new Error(
      `memserve emitted confidence language (${leaked.join(", ")}). A staleness marker beside a memory is the ` +
        `stimulus measured to make the decision worse — withhold it or serve the current code instead.`,
    )
  }
  return {
    entries,
    text,
    withheld,
    reGrounded,
    reason:
      withheld.length || reGrounded.length
        ? `${entries.length} served; ${withheld.length} withheld and ${reGrounded.length} replaced by current source, because their anchors no longer match`
        : `${entries.length} served; every anchor still matches`,
  }
}

/** Read the code an anchor points at, as it is NOW. Returns null when it cannot be read. */
function currentEvidence(c: Servable, root?: string): string | null {
  const a = c.anchor as Anchor | undefined
  if (!a || !a.path) return null
  try {
    const fs = require("node:fs") as typeof import("node:fs")
    const path = require("node:path") as typeof import("node:path")
    const abs = path.isAbsolute(a.path) ? a.path : path.join(root || process.cwd(), a.path)
    const text = fs.readFileSync(abs, "utf8")
    if (a.symbol) {
      const { symbolSpan } = require("./memanchor") as typeof import("./memanchor")
      const span = symbolSpan(text, a.symbol)
      if (span) return `${a.path}:${span.start + 1}\n${text.split("\n").slice(span.start, span.end + 1).join("\n")}`
    }
    return `${a.path}\n${text}`
  } catch {
    return null
  }
}

/** The block form, for the injection path. Empty string when nothing survives — never a placeholder
 *  sentence explaining that something was withheld, which would be a badge by another route. */
export function memoryBlock(candidates: Servable[] | null | undefined, ctx?: any): string {
  return serveMemories(candidates, ctx).text
}

/** Lines that must survive a budget cut. A hard constraint is not a nice-to-have detail that a summary
 *  can gist: it is the sentence whose absence changes what the agent is allowed to do. Measured cost of
 *  losing one to compaction: constraint violations went 0% with the rule in context to 30% average once
 *  it was compacted away — and 0% again whenever the rule happened to survive the summary. So survival
 *  is the whole variable, and it is not left to chance. */
const PIN_MARKERS = [
  /\bHARD CONSTRAINT\b/,
  /\bMUST NOT\b|\bNEVER\b(?!\s+mind)/,
  /^\s*[-*]?\s*PINNED\b/i,
  /\bdo not compact\b/i,
]

/** Is this line a constraint that outranks the budget? */
export function isPinnedLine(line: string): boolean {
  return PIN_MARKERS.some((r) => r.test(line))
}

/**
 * Fit text to a byte budget WITHOUT dropping pinned constraints.
 *
 * The naive form — `text.slice(0, cap)` — is what this replaces, and it fails in the one way that
 * matters: it is positional, so whether a hard constraint reaches the model depends on where in the file
 * someone happened to type it. A rule written at the bottom of MEMORY.md is invisible; the same rule
 * three lines higher is honoured. That is not a policy, it is an accident.
 *
 * Pinned lines are emitted VERBATIM and never paraphrased — a constraint that has been "helpfully"
 * reworded is a different constraint, and the reader has no way to tell which one they are being asked
 * to obey. If the pins alone exceed the budget, the pins still all go: dropping a constraint to satisfy
 * a byte count is the exact trade this function exists to refuse, and the overage is declared instead.
 */
export const PIN_ENV = "FABULA_MEM_PIN"

export function pinAwareTruncate(text: string, cap: number, env: Record<string, string | undefined> = process.env as any): string {
  const src = String(text ?? "")
  // §5: the kill-switch has to restore the BEFORE behaviour EXACTLY, not approximately — the pre-W7
  // injection is a positional slice with a truncation marker, and "close enough" would mean nobody can
  // fall back cleanly when this misbehaves.
  if (String(env?.[PIN_ENV] ?? "1").trim() === "0") {
    return src.length > cap ? src.slice(0, cap) + "\n… (truncated)" : src
  }
  if (!Number.isFinite(cap) || cap <= 0 || src.length <= cap) return src
  const lines = src.split("\n")
  const pins = lines.filter(isPinnedLine)
  if (!pins.length) return src.slice(0, cap) + "\n… (truncated)"

  const pinBlock = "\n\n## Pinned constraints (kept verbatim past the context budget)\n" + pins.join("\n")
  const room = cap - pinBlock.length
  if (room <= 0) {
    // The constraints alone do not fit. They still all go — and the reader is told the rest was dropped,
    // rather than being handed a silently shortened rule set.
    return pins.join("\n") + `\n… (the rest of the memory was dropped: the pinned constraints alone exceed the ${cap}-character budget)`
  }
  const kept: string[] = []
  let used = 0
  for (const l of lines) {
    if (isPinnedLine(l)) continue // it is already in the pin block; do not spend budget twice
    if (used + l.length + 1 > room) break
    kept.push(l)
    used += l.length + 1
  }
  return kept.join("\n") + "\n… (truncated)" + pinBlock
}
