// FABULA-LLM-5 — context-budget guard (pure core).
//
// Why this exists (RULE #9 / #14). A "read all chapters / every file / the whole book" task accumulates
// the entire corpus into ONE context. Whatever model is in the socket, served by whatever backend, has a
// finite window AND a finite KV-cache budget on the device; past a point the serving process runs out of
// memory and dies mid-generation — the crash surfaces to the caller as an abrupt connection reset (a red
// "the model has crashed … Exit code: null"). That is a HARNESS problem, model-agnostic: the harness must
// keep a single turn from ballooning past what the socket can hold, deterministically, regardless of which
// model is plugged in. Capping the SERVING window (LM Studio load config) removes the crash; this guard is
// the complementary half — it keeps the CONVERSATION from wanting more than the window in the first place.
//
// The efficiency contract: this mechanism is INERT until the context is genuinely near the window. Below
// the high-water mark `decide()` returns { action: "none" }, so a normal turn is byte-identical and the
// model's large static prefix stays cache-warm — no per-turn cost on ordinary work (asserted by test). It
// acts only (a) when the accumulated context crosses the high-water FRACTION of the window — plant a
// consolidate-and-shed directive so the model summarises what it has read and stops holding raw text
// before the ceiling; or (b) when the ASK itself is an unbounded bulk read — steer it to read in bounded
// batches with a running summary from the start, so the crash can never begin.

export const DEFAULT_CONTEXT_WINDOW = 131072
export const DEFAULT_HIGH_WATER = 0.75
// MEASURED on this machine, 2026-07-26: 320 134 characters of ordinary prose came back from the
// runtime as 60 332 tokens. This value was 3.5 — a 52% spread against the adapter's 4 and the loader's
// measured figure, for the same quantity. Three constants for one number cannot all be right, and this
// one made the guard believe the context was half again as full as it was, so it consolidated early.
// The adapter carries the twin (adapter_util.py CHARS_PER_TOKEN); separate languages, one measurement.
export const DEFAULT_CHARS_PER_TOKEN = 5.306

/** The per-CALL ceiling. Shares FABULA_CONTEXT_WINDOW with the adapter's overflow telemetry — one source
 *  of truth for "how big is one request" — and defaults to the local build's usual value.
 *
 *  This number does NOT bound the conversation. It is the input the shedding machinery needs in order to
 *  consolidate IN TIME, which is how an unbounded task passes through a bounded call at all. Read as a
 *  ceiling on the user it would be exactly backwards, and getting it wrong is what broke: unset, the guard
 *  assumed 131072 against a model serving 65536, never shed, the accumulated context outgrew the request,
 *  and the serving process died mid-generation (measured 2026-07-25, crash at a 67850-token prefix). */
export function contextWindow(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FABULA_CONTEXT_WINDOW)
  if (Number.isFinite(n) && n > 0) return n
  const learned = learnedWindow()
  return learned > 0 ? learned : DEFAULT_CONTEXT_WINDOW
}

/** What the SERVER says it is loaded at, learned once per process by the plugin hook (which can await)
 *  and read here synchronously. A typed constant goes stale the moment the model or its load config
 *  changes and then governs traffic it no longer describes; 0 means "not learned", and every caller falls
 *  back to the default rather than guessing. */
let LEARNED = 0
let LEARNED_AT = 0
/** How long a learned ceiling stays trusted. A model reload changes the answer, and caching it for the
 *  life of the process reintroduces exactly the staleness this mechanism exists to remove — measured
 *  2026-07-25: the model was reloaded from 65536 to 262144 and the harness kept shedding against the old
 *  figure until it was restarted by hand. Re-asking every minute costs one cheap local call. */
export const LEARNED_TTL_MS = 60_000
export function learnedWindow(now = Date.now()): number {
  return LEARNED > 0 && now - LEARNED_AT < LEARNED_TTL_MS ? LEARNED : 0
}

export function setLearnedWindow(n: number): void {
  if (Number.isFinite(n) && n > 0) { LEARNED = n; LEARNED_AT = Date.now() }
}

/** Forget the measured ceiling, so the next probe asks the runtime again.
 *
 *  Separate from `setLearnedWindow(0)` on purpose: a zero there means "a probe reported nothing useful",
 *  which must never shrink the window, while this is a caller saying the figure is no longer trustworthy
 *  — after a deliberate reload, for instance. Collapsing the two would make one of them wrong. */
export function clearLearnedWindow(): void {
  LEARNED = 0
  LEARNED_AT = 0
}
/** Fraction of the window at which we force consolidation. Must leave room for the reply + reasoning. */
export function highWater(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FABULA_CTX_HIGH_WATER)
  return Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULT_HIGH_WATER
}
/** Chars→tokens divisor for the estimate. Conservative (fires slightly EARLY is the safe direction). */
export function charsPerToken(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FABULA_CTX_CHARS_PER_TOKEN)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CHARS_PER_TOKEN
}

// Keys that carry ids/timestamps/accounting rather than prompt text — skipped so they don't inflate the
// estimate. The estimate only needs to track the real weight (message + tool-output text), where a bulk
// read's corpus actually lives.
const NOISE_KEYS = new Set([
  "id", "sessionID", "messageID", "callID", "toolCallID", "time", "ts", "cost", "tokens",
  "createdAt", "updatedAt", "role", "type", "mime", "url", "source", "sourceType",
])

function collectText(node: any, out: string[], depth: number): void {
  if (node == null || depth > 6) return
  if (typeof node === "string") { out.push(node); return }
  if (Array.isArray(node)) { for (const x of node) collectText(x, out, depth + 1); return }
  if (typeof node === "object") {
    for (const k in node) {
      if (NOISE_KEYS.has(k)) continue
      collectText((node as any)[k], out, depth + 1)
    }
  }
}

/** Sum of string-leaf lengths across every message's parts — a robust estimate of the real prompt text,
 *  wherever the engine stashes tool outputs (file contents, the bulk of a "read everything" turn). */
export function estimateChars(messages: any[]): number {
  if (!Array.isArray(messages)) return 0
  const out: string[] = []
  for (const m of messages) collectText(m?.parts ?? m, out, 0)
  let n = 0
  for (const s of out) n += s.length
  return n
}
export function estimateTokens(messages: any[], env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(estimateChars(messages) / charsPerToken(env))
}

export function nearCeiling(tokens: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return tokens >= contextWindow(env) * highWater(env)
}

// A bulk-read ask: a read/review/analyse-style verb over an ALL/EVERY/ENTIRE/WHOLE quantifier of a plural
// corpus noun, EN + RU. Deliberately requires the quantifier — "read the config file" must NOT trigger;
// "read all chapters" / "review every file" / "прочти все главы" must. RU alternatives avoid \w (which is
// ASCII-only in JS regex without the u flag and would not match Cyrillic) by using explicit stems.
const BULK_READ =
  /\b(read|analyz|analys|review|summari[sz]e|go through|process|study)\w*[^.?!]{0,48}\b(all|every|entire|whole|each)\b[^.?!]{0,32}\b(chapters?|files?|books?|codebase|documents?|pages?|sections?|modules?)\b|\b(all|every|entire|whole)\s+(the\s+)?(chapters?|files?|book|documents?|pages?)\b|прочти?\s+вс[её]|прочита[а-яё]*\s+вс[её]|вс[еёх]\s+глав[а-яё]*|кажд[а-яё]*\s+глав[а-яё]*|всю\s+книг[а-яё]*|весь\s+код\b|всю\s+кодов[а-яё]*|вс[еёх]\s+файл[а-яё]*|весь\s+файл|по\s+вс[её]м\s+глав[а-яё]*/i

export function isBulkReadAsk(text: string): boolean {
  if (typeof text !== "string" || !text) return false
  return BULK_READ.test(text)
}

export const CONSOLIDATE_MARKER = "[fabula: consolidate]"
export const BOUNDED_MARKER = "[fabula: read in batches]"

export function consolidationDirective(pct: number): string {
  return (
    `\n\n${CONSOLIDATE_MARKER} The working context is now ~${pct}% of this socket's window. ` +
    `Before reading anything more: write a COMPACT running summary of what you have found so far ` +
    `(the conclusions, not the raw text), then continue from that summary. Do NOT re-read or keep large ` +
    `raw passages you have already processed — holding the whole corpus in context at once exhausts the ` +
    `serving budget and ends the turn. Consolidate, then proceed on the summary.`
  )
}
export function boundedReadDirective(): string {
  return (
    `\n\n${BOUNDED_MARKER} This asks you to read a large body of material. Read it in BOUNDED BATCHES, ` +
    `not all at once: process a handful of items, write a compact running summary of the findings, then ` +
    `move to the next batch keeping only the summary — never accumulate the entire corpus in one context. ` +
    `Produce the final analysis from the accumulated summary. (Reading everything into a single context at ` +
    `once exhausts the serving budget and ends the turn before you finish.)`
  )
}

export type CtxAction = "none" | "consolidate" | "bounded"
export interface CtxDecision {
  action: CtxAction
  tokens: number
  pct: number
}

/** The whole policy in one pure function so tests hit it directly. Consolidation (already near the
 *  ceiling) takes precedence over the bulk-read steer — if the context is already large, shed NOW. */
export function decide(messages: any[], lastUserText: string, env: NodeJS.ProcessEnv = process.env): CtxDecision {
  const tokens = estimateTokens(messages, env)
  const pct = Math.round((tokens / contextWindow(env)) * 100)
  if (nearCeiling(tokens, env)) return { action: "consolidate", tokens, pct }
  if (isBulkReadAsk(lastUserText)) return { action: "bounded", tokens, pct }
  return { action: "none", tokens, pct }
}

/** Ask the serving API what the loaded model's per-call ceiling is, and hand it to the guard. Called from
 *  the plugin hook, which can await; failure is silent and leaves the default in place — a probe that
 *  cannot answer must never make the guard shed early or late, only leave it as it was. */
export async function probeWindow(fetchImpl: typeof fetch = fetch, url = process.env.FABULA_MODEL_API || "http://localhost:1234/api/v0/models"): Promise<number> {
  if (learnedWindow() > 0) return learnedWindow()
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 1500)
    const r = await fetchImpl(url, { signal: ctl.signal })
    clearTimeout(t)
    if (!r.ok) return 0
    const data: any = await r.json()
    for (const m of data?.data ?? []) {
      if (m?.state === "loaded") {
        const n = Number(m.loaded_context_length)
        if (Number.isFinite(n) && n > 0) { setLearnedWindow(n); return n }
      }
    }
  } catch { /* a probe that cannot answer changes nothing */ }
  return 0
}
