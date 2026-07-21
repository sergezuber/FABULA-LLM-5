// Circuit-breaker / tool-loop guardrail (pure, no SDK import → unit-testable).
// A tool-call guardrail controller adapted to the FABULA engine:
//   * In the engine, `tool.execute.after` can APPEND to the result the model sees. So here the
//     decision is always advisory text appended to the result — the "block/halt" tiers become a
//     STRONGER worded stop-instruction rather than aborting execution.
//   * Per-turn state is keyed by sessionID; the plugin resets a session on `chat.message`
//     (= new user turn).

import { toolSignature, hashResult } from "./signature"

export type GuardAction = "allow" | "warn" | "stop"
export interface GuardDecision {
  action: GuardAction
  code: string
  /** Text to append to the tool result (empty for "allow"). */
  guidance: string
  count: number
}

export interface GuardConfig {
  exactFailureWarnAfter: number   // same tool+args failed → warn
  exactFailureStopAfter: number   // … → strong stop
  sameToolFailWarnAfter: number   // same tool (any args) failed → warn
  sameToolFailStopAfter: number   // … → strong stop
  noProgressWarnAfter: number     // idempotent tool returned identical result → warn
  noProgressStopAfter: number     // … → strong stop (advisory note)
  noProgressHardBlockAfter: number // … → HARD ABORT the next identical no-progress call (throw)
  exactFailHardBlockAfter: number // identical-args repeated failure → HARD ABORT the next retry (throw)
  degenerateSearchStopAfter: number // empty/catch-all search patterns → strong "synthesize" stop
  searchBudgetPerTurn: number     // total grep/glob calls in one turn → force synthesis (thrash backstop)
  webNearDupBlockAfter: number    // near-duplicate web-search query (token-set + Jaccard) → hard block
  webSearchBudgetPerTurn: number  // DISTINCT web-search queries in one turn → force synthesis
  maxSessions: number             // LRU cap on tracked sessions (memory bound)
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  exactFailureWarnAfter: 2,
  exactFailureStopAfter: 5,
  sameToolFailWarnAfter: 3,
  sameToolFailStopAfter: 8,
  noProgressWarnAfter: 2,
  noProgressStopAfter: 5,
  noProgressHardBlockAfter: 5,
  exactFailHardBlockAfter: 5,
  degenerateSearchStopAfter: 3,
  searchBudgetPerTurn: 60,
  // Web: a REPEAT of the same (near-dup) query is blocked on the second occurrence — a repeated web
  // search returns the same results, only floods context (measured: killing redundant search does
  // not hurt success, arXiv:2605.29796). The budget counts DISTINCT queries, deliberately generous —
  // QA plateaus at ~3 searches (arXiv:2603.08877) but real agent tasks legitimately need more; the
  // budget is the thrash backstop, the near-dup block is the actual loop-killer.
  webNearDupBlockAfter: 2,
  webSearchBudgetPerTurn: 15,
  maxSessions: 256,
}

// Read-only tools — our plugin tools + native engine tools. Only these get "no-progress"
// (identical-result-repeated) detection; repeating a read with the same result is wasteful.
export const IDEMPOTENT_TOOLS = new Set<string>([
  // our plugin tools
  "view", "web_search", "web_fetch", "image_search", "places_search", "weather_fetch",
  "search_mcp_registry", "fetch_sports_data", "present_files", "places_map_display_v0",
  "recipe_display_v0", "recommend_LLM_apps", "suggest_connectors",
  // native engine read tools (names as the engine exposes them)
  "read", "grep", "glob", "list", "webfetch",
])

// Mutating tools — never treated as no-progress (a repeat may legitimately do new work).
export const MUTATING_TOOLS = new Set<string>([
  "create_file", "str_replace", "bash_tool", "ask_user_input_v0", "message_compose_v1",
  "write", "edit", "patch", "bash", "actor", "task", "todowrite", "todo", "note_append",
])

// File-read tools — a no-progress repeat here almost always means "paginated to END OF FILE and stuck".
// Their loop guidance is tailored: it tells the model it hit EOF and to read a DIFFERENT file / move on.
export const FILE_READ_TOOLS = new Set<string>(["view", "read", "cat", "open"])

// ── Search-thrash / degenerate-pattern guard ───────────────────────────────────────────────
// The #1 local-model runaway (observed live: 542 grep calls with an EMPTY pattern in one session):
// the model fires grep with an empty / catch-all pattern → it matches EVERY line → dumps whole files
// → context bloats → the model gets more confused → more empty greps. Each call varies only by `path`,
// so the per-(tool,args)-signature LoopGuard never trips. We catch it at the PATTERN level (reject
// before execution) + a per-turn search budget, both counted per-TOOL (not per-signature).
export const SEARCH_TOOLS = new Set<string>(["grep", "glob", "codesearch", "code_search", "ripgrep", "rg"])

// ── web/MCP search class (2026-07-17) ────────────────────────────────────────
// Measured live: 20+ consecutive web-search calls with paraphrased queries sailed past BOTH guards —
// the (tool,args) signature never repeated byte-identically, and the search class above only knows
// code-search names. The literature names this exact pathology: near-identical tool-call reruns are
// the top agent failure mode ("Step repetition", 15.7% of failures, arXiv:2503.13657; "Duplicate
// Step" defined as HIGHLY SIMILAR reruns, arXiv:2605.20251), redundant search grows to ~50% of calls
// under outcome-trained agents (arXiv:2605.29796), and killing it does not hurt success (accuracy
// +2.2pp with 40% fewer searches, ibid.; 94.8% of quality at 62.6% of calls, arXiv:2606.13814).
// Detector shape follows the measured best hybrid (arXiv:2511.10650): a cheap STRUCTURAL stage
// (normalized token-set key) confirmed by a cheap SIMILARITY stage (Jaccard) — embeddings alone
// were precision 0.16 there, and we add zero model calls. Tools are classified by NAME PATTERN so
// arbitrary MCP prefixes (`web-search-internet_searxng_web_search`) are covered.

/** Search-like tools OUTSIDE the code-search set — web/registry/MCP searches, any server prefix. */
export function isWebSearchTool(tool: string): boolean {
  if (SEARCH_TOOLS.has(tool)) return false
  return /(^|[_-])search(es)?([_-]|$)/i.test(tool)
}

/** The query string of a search-like call, wherever the schema puts it. Undefined → unknown schema,
 *  stay out of the way (never block what we can't read). */
export function searchQueryOf(args: any): string | undefined {
  const q = args?.query ?? args?.q ?? args?.text ?? args?.keywords ?? args?.search
  return typeof q === "string" && q.trim() ? q : undefined
}

/** Structural stage: normalized token-SET key. Case, punctuation, token order and duplicates are
 *  not "a different search" — «Ошо книга "Дзен"» and `ошо дзен книга` collapse to one key. */
export function normalizeQueryKey(q: string): string {
  const tokens = q
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2)
  return [...new Set(tokens)].sort().join(" ")
}

/** Non-query primitive args (page, offset, category, …), stable-serialized. Two calls with the same
 *  words but a different page are legitimately different requests — never near-dup them. */
export function searchExtrasOf(args: any): string {
  if (!args || typeof args !== "object") return ""
  const skip = new Set(["query", "q", "text", "keywords", "search"])
  const parts: string[] = []
  for (const k of Object.keys(args).sort()) {
    if (skip.has(k)) continue
    const v = (args as Record<string, unknown>)[k]
    if (v == null) continue
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${v}`)
  }
  return parts.join("&")
}

/** Similarity confirmation between two token-set keys. */
export function tokenJaccard(a: string, b: string): number {
  const A = new Set(a.split(" ").filter(Boolean))
  const B = new Set(b.split(" ").filter(Boolean))
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter += 1
  return inter / (A.size + B.size - inter)
}
const WEB_NEAR_DUP_JACCARD = 0.8
// Tools whose pattern is a REGEX (so catch-all metacharacters are degenerate). glob uses globs where
// `*`/`**` are legitimate, so glob is checked only for an EMPTY pattern.
export const REGEX_SEARCH_TOOLS = new Set<string>(["grep", "codesearch", "code_search", "ripgrep", "rg"])

const CATCH_ALL_PATTERNS = new Set<string>([
  ".", "^", "$", "^$", ".*", ".+", ".?", "^.*$", "^.*", ".*$", "()", "(.*)", "(.+)",
  "\\s", "\\s*", "\\S", "\\S*", "\\w", "\\w*", "[\\s\\S]*", "[\\s\\S]", "[^]*", "|", ".|.",
])

/** Empty / whitespace-only / non-string pattern. */
export function isEmptyPattern(p: unknown): boolean {
  return typeof p !== "string" || p.trim() === ""
}

/** True for empty / whitespace / pure catch-all regex patterns that match (almost) every line.
 *  A real search always carries literal content (a name, keyword, symbol); these only flood context. */
export function isDegeneratePattern(p: unknown): boolean {
  if (isEmptyPattern(p)) return true
  const t = (p as string).trim()
  if (CATCH_ALL_PATTERNS.has(t)) return true
  // only regex metacharacters / whitespace, no literal alphanumeric to anchor the search
  if (!/[A-Za-z0-9_]/.test(t) && /^[\s.^$*+?|()\[\]{}\\-]+$/.test(t)) return true
  return false
}

/** No-progress guidance, tailored for file reads (the #1 stuck-loop shape: re-reading a file at EOF). */
export function noProgressGuidance(tool: string, count: number): string {
  if (FILE_READ_TOOLS.has(tool)) {
    return `\`${tool}\` returned the SAME content ${count} times — you have reached the END of this file (or already ` +
      `have it in context). There is no more to read here. Do NOT read this file again. Read a DIFFERENT file, or use ` +
      `what you already have to take the next step / write your answer.`
  }
  return `\`${tool}\` returned the same result ${count} times. The data is already in context — use it and move on, or ` +
    `change the query/path. Do not repeat this call.`
}

interface TurnState {
  exactFail: Map<string, number>
  sameToolFail: Map<string, number>
  noProgress: Map<string, { hash: string; count: number }>
  searchCalls: number       // total grep/glob calls this turn (per-tool thrash budget)
  degenerateSearch: number  // empty/catch-all search patterns this turn
  webQueries: Map<string, number> // canonical web-search query key (+extras) → call count this turn
  touched: number // for LRU eviction ordering
}

/** Heuristic failure classifier (fallback path). */
export function classifyFailure(tool: string, result: string | null | undefined, metadata?: any): boolean {
  if (metadata && typeof metadata === "object") {
    if (metadata.error || metadata.failed === true) return true
    if (typeof metadata.exit === "number" && metadata.exit !== 0) return true
    if (typeof metadata.exitCode === "number" && metadata.exitCode !== 0) return true
  }
  if (typeof result !== "string") return false   // defensive: a non-string output must not crash .slice()
  const head = result.slice(0, 500)
  if (head.startsWith("Error") || head.startsWith("error:")) return true
  const lower = head.toLowerCase()
  if (lower.includes('"error"') || lower.includes('"failed"')) return true
  return false
}

export class LoopGuard {
  private cfg: GuardConfig
  private sessions = new Map<string, TurnState>()
  private clock = 0

  constructor(cfg: Partial<GuardConfig> = {}) {
    this.cfg = { ...DEFAULT_GUARD_CONFIG, ...cfg }
  }

  /** New user turn → clear this session's per-turn counters. */
  resetTurn(sessionID: string): void {
    this.sessions.set(sessionID, this.fresh())
  }

  /** Forget a session entirely (e.g. on session.deleted). */
  dropSession(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  /**
   * Record a completed tool call and return an advisory decision.
   * `result` is the tool's output string (output.output in the after-hook).
   */
  observe(
    sessionID: string,
    tool: string,
    args: any,
    result: string | null | undefined,
    metadata?: any,
    failed?: boolean,
  ): GuardDecision {
    const st = this.touch(sessionID)
    const sig = toolSignature(tool, args)
    const isFail = failed ?? classifyFailure(tool, result, metadata)

    if (isFail) {
      // reset no-progress tracking for this signature on failure
      st.noProgress.delete(sig)
      const exact = (st.exactFail.get(sig) ?? 0) + 1
      st.exactFail.set(sig, exact)
      const same = (st.sameToolFail.get(tool) ?? 0) + 1
      st.sameToolFail.set(tool, same)

      if (exact >= this.cfg.exactFailureStopAfter) {
        return mk("stop", "repeated_exact_failure_stop", exact,
          `STOP: \`${tool}\` failed ${exact} times with identical arguments. Do not retry it unchanged. ` +
          `Inspect the error above, change the arguments/approach, or report the blocker.`)
      }
      if (same >= this.cfg.sameToolFailStopAfter) {
        return mk("stop", "same_tool_failure_stop", same,
          `STOP: \`${tool}\` failed ${same} times this turn. Stop using this tool path; choose a different approach or tool.`)
      }
      if (exact >= this.cfg.exactFailureWarnAfter) {
        return mk("warn", "repeated_exact_failure_warning", exact,
          `\`${tool}\` has failed ${exact} times with identical arguments — this looks like a loop. ` +
          `Diagnose the error and change strategy instead of retrying it unchanged.`)
      }
      if (same >= this.cfg.sameToolFailWarnAfter) {
        return mk("warn", "same_tool_failure_warning", same, failureRecoveryHint(tool, same))
      }
      return mk("allow", "allow", exact, "")
    }

    // success path
    st.exactFail.delete(sig)
    st.sameToolFail.delete(tool)
    // args matter: a multiplexer's READ operation is idempotent even when the tool as a whole mutates.
    if (!isIdempotent(tool, args)) {
      st.noProgress.delete(sig)
      return mk("allow", "allow", 0, "")
    }

    const rhash = hashResult(result ?? "")
    const prev = st.noProgress.get(sig)
    const count = prev && prev.hash === rhash ? prev.count + 1 : 1
    st.noProgress.set(sig, { hash: rhash, count })

    if (count >= this.cfg.noProgressStopAfter) {
      return mk("stop", "idempotent_no_progress_stop", count, "STOP: " + noProgressGuidance(tool, count))
    }
    if (count >= this.cfg.noProgressWarnAfter) {
      return mk("warn", "idempotent_no_progress_warning", count, noProgressGuidance(tool, count))
    }
    return mk("allow", "allow", count, "")
  }

  /**
   * Read-only PRE-execution check (call from `tool.execute.before`, before the tool runs → no
   * mutation). Returns a "stop" decision when this EXACT (tool, args) signature has already hit a
   * hard-block threshold this turn — i.e. an idempotent read that keeps returning the same result,
   * or an identical call that keeps failing. The plugin THROWS on a stop, which aborts the redundant
   * call. This is the teeth the advisory note lacks: weak local models ignore appended text and keep
   * re-reading; aborting the call physically breaks the loop and forces a different next step.
   */
  peekBlock(sessionID: string | undefined, tool: string, args: any): GuardDecision | null {
    if (!sessionID) return null
    const st = this.sessions.get(sessionID)
    if (!st) return null
    const sig = toolSignature(tool, args)
    const np = st.noProgress.get(sig)
    if (np && np.count >= this.cfg.noProgressHardBlockAfter) {
      return mk("stop", "idempotent_no_progress_block", np.count, "LOOP BLOCKED: " + noProgressGuidance(tool, np.count))
    }
    const ef = st.exactFail.get(sig) ?? 0
    if (ef >= this.cfg.exactFailHardBlockAfter) {
      return mk("stop", "exact_failure_block", ef,
        `LOOP BLOCKED: \`${tool}\` already failed ${ef} times with these exact arguments. Retrying it unchanged ` +
        `will fail again. Change the arguments or the approach, or report the blocker — do not repeat this call.`)
    }
    return null
  }

  /**
   * PRE-execution search-abuse guard (call from `tool.execute.before` for grep/glob/…). Returns a
   * "stop" decision — the plugin THROWS on it, aborting the call BEFORE it runs — when:
   *  (a) the pattern is empty / catch-all → it would match every line, dump the whole tree and bloat
   *      context (the exact local-model death-spiral). Rejected on the FIRST call; the message escalates.
   *  (b) the turn exceeded the search budget → stop grepping and synthesize.
   * Counters are per-turn (reset on chat.message) and per-TOOL, so degenerate searches that vary only by
   * `path` — which slip past the signature-based `peekBlock` — are caught here.
   */
  peekSearch(sessionID: string | undefined, tool: string, args: any): GuardDecision | null {
    if (!sessionID) return null
    // Web/MCP search class: near-duplicate queries are blocked at the repeated PATH itself
    // (arXiv:2607.01641 — a bound is effective only when it constrains the repeated path), and a
    // distinct-query budget forces synthesis (tool-removal-style enforcement, arXiv:2603.08877).
    if (isWebSearchTool(tool)) {
      const q = searchQueryOf(args)
      if (q === undefined) return null
      const st = this.touch(sessionID)
      const extras = searchExtrasOf(args)
      const key = normalizeQueryKey(q) + (extras ? ` §${extras}` : "")
      // similarity confirmation: fold into an existing near-identical key (same extras only)
      let canonical = key
      if (!st.webQueries.has(key)) {
        for (const existing of st.webQueries.keys()) {
          const [eWords, eExtras = ""] = existing.split(" §")
          const [kWords, kExtras = ""] = key.split(" §")
          if (eExtras === kExtras && tokenJaccard(eWords, kWords) >= WEB_NEAR_DUP_JACCARD) { canonical = existing; break }
        }
      }
      const n = (st.webQueries.get(canonical) ?? 0) + 1
      st.webQueries.set(canonical, n)
      if (n >= this.cfg.webNearDupBlockAfter) {
        return mk("stop", "web_search_duplicate", n,
          `LOOP BLOCKED: this is a repeat of a search you already ran this turn (same or near-identical query — ` +
          `"${q.slice(0, 120)}"). Re-searching returns the SAME results and only floods context. Either use what the ` +
          `earlier search already returned and write your answer, or search for something MATERIALLY different ` +
          `(other entities, another angle, a different source). Do not re-issue paraphrases of this query.`)
      }
      if (st.webQueries.size > this.cfg.webSearchBudgetPerTurn) {
        return mk("stop", "web_search_budget_exceeded", st.webQueries.size,
          `LOOP BLOCKED: ${st.webQueries.size} distinct web searches this turn — far past the point of diminishing ` +
          `returns. STOP searching; synthesize what you have gathered and produce the answer now. If something truly ` +
          `essential is missing, name it explicitly in your answer instead of searching again.`)
      }
      return null
    }
    if (!SEARCH_TOOLS.has(tool)) return null
    const st = this.touch(sessionID)
    st.searchCalls += 1

    const pattern = args?.pattern ?? args?.query ?? args?.regex
    const degenerate = REGEX_SEARCH_TOOLS.has(tool) ? isDegeneratePattern(pattern) : isEmptyPattern(pattern)
    if (degenerate) {
      const n = (st.degenerateSearch += 1)
      if (n >= this.cfg.degenerateSearchStopAfter) {
        return mk("stop", "degenerate_search_thrash", n,
          `LOOP BLOCKED: \`${tool}\` was called ${n} times with an empty/catch-all pattern — that matches every line and ` +
          `only floods context. STOP searching: you already have enough. Synthesize your findings and write the answer NOW, ` +
          `or grep for a SPECIFIC literal term (a function/struct/error/env name).`)
      }
      return mk("stop", "degenerate_search_pattern", n,
        `\`${tool}\` rejected: an empty or catch-all pattern (\`${String(pattern)}\`) matches every line and floods context. ` +
        `Provide a SPECIFIC search term — a literal substring or anchored regex (e.g. \`func NewServer\`, \`panic(\`, \`os.Getenv\`). ` +
        `If you already have enough, stop searching and synthesize.`)
    }

    if (st.searchCalls > this.cfg.searchBudgetPerTurn) {
      return mk("stop", "search_budget_exceeded", st.searchCalls,
        `LOOP BLOCKED: ${st.searchCalls} searches this turn — far past what any task needs. STOP searching; you have more than ` +
        `enough material. Synthesize your findings and produce the answer now — do not issue more grep/glob calls.`)
    }
    return null
  }

  /** Append a decision's guidance to a tool result (no-op for "allow"). */
  static apply(result: string, d: GuardDecision): string {
    if (d.action === "allow" || !d.guidance) return result
    const label = d.action === "stop" ? "TOOL LOOP — HARD STOP" : "Tool loop warning"
    return (result || "") + `\n\n[${label}: ${d.code}; count=${d.count}; ${d.guidance}]`
  }

  // ── internals ──
  private fresh(): TurnState {
    return { exactFail: new Map(), sameToolFail: new Map(), noProgress: new Map(), searchCalls: 0, degenerateSearch: 0, webQueries: new Map(), touched: ++this.clock }
  }
  private touch(sessionID: string): TurnState {
    let st = this.sessions.get(sessionID)
    if (!st) { st = this.fresh(); this.sessions.set(sessionID, st) }
    st.touched = ++this.clock
    if (this.sessions.size > this.cfg.maxSessions) this.evictOldest()
    return st
  }
  private evictOldest(): void {
    let oldestKey: string | undefined
    let oldest = Infinity
    for (const [k, v] of this.sessions) if (v.touched < oldest) { oldest = v.touched; oldestKey = k }
    if (oldestKey !== undefined) this.sessions.delete(oldestKey)
  }
}

/**
 * Whether a tool participates in no-progress (identical-result-repeated) detection.
 *
 * This used to answer on the strength of the tool's NAME: a deny-list of "mutating" tools was exempt, and
 * of the rest only an explicit allow-list was covered. Both halves were holes, and one of them cost a
 * measured 97% of a machine.
 *
 * `task` sat in the mutating deny-list, so it was exempt outright — but `task` is a MULTIPLEXER: `list`
 * reads, `done` mutates. Its read operations inherited the write exemption, and one checkpoint-writer
 * issued the byte-identical call `task {"action":"list"}` 456 times in a single session, unchecked,
 * consuming 62.6M input tokens against the main agent's 2.1M. The same shape applies to `actor`, `todo`
 * and any MCP tool that selects its operation by argument. The allow-list was the second hole: a tool
 * absent from it — every future tool, every MCP tool — had no protection at all, so the DEFAULT was
 * "unprotected".
 *
 * The fix is not a longer list, nor a repeat-count threshold. The literature is explicit that counting is
 * the wrong signal ("frequent edge traversals alone are not reliable indicators of cycles",
 * arXiv:2511.10650) and that the criterion is PROGRESS — a bad cycle "yields no additional insights or
 * progress" — while their own semantic detectors reach only F1 0.72 / precision 0.62, far too noisy to
 * gate real work on. We do not need that general problem: the guard already holds an EXACT oracle for the
 * provable subset. Byte-identical arguments producing a byte-identical result is a proof, not an estimate,
 * that the call yielded no new information — whatever the tool is called, whether or not it can mutate,
 * and however many tools are added later. So detection is the DEFAULT and the name decides nothing.
 *
 * A mutating tool is no exception: writing the same bytes to the same path a second time, or re-running a
 * command that prints exactly what it printed before, is equally uninformative. Where a repeat really does
 * new work, the RESULT differs and the oracle stays silent by construction — which is what the CONTROL
 * cases in the test file assert.
 *
 * The one principled exemption is a tool whose PURPOSE is to wait: for a sleep/poll an unchanged result is
 * precisely the intended outcome, so repetition is progress-neutral by design and blocking it would break
 * every legitimate wait loop.
 */
export const WAITING_TOOLS = new Set<string>(["sleep", "wait"])

/**
 * Operation verbs that SELECT A READ on a multiplexer tool. An OPEN vocabulary, and it fails SAFE by
 * construction: a verb missing here does not break anything and cannot cause a wrong block — the call
 * simply falls back to the tool-name classification below, exactly as before. There is no tuned number
 * here and no value that stops working once exceeded.
 */
const READ_OPERATION_VERBS = new Set<string>([
  "list", "get", "read", "show", "view", "search", "find", "status", "describe", "query", "peek", "count",
])

/**
 * The operation a multiplexer call selects, if its arguments name one.
 *
 * Looks one level INTO a nested payload as well as at the top, because both shapes reach here: the model
 * commonly emits the flat `{action:"list"}`, while the engine's own schema for `task`/`actor` is
 * `{operation:{action:"list"}}` — and arg-repair now wraps the former into the latter before the tool
 * runs, so by the time the after-hook records the call the verb usually sits one level down. Reading only
 * the top level would have made this whole classification dead on the shape that actually arrives.
 */
function selectedOperation(args: any): string | null {
  if (!args || typeof args !== "object") return null
  const OP_KEYS = ["action", "operation", "op", "cmd", "command", "mode"]
  for (const key of OP_KEYS) {
    const v = (args as any)[key]
    if (typeof v === "string" && v) return v.toLowerCase()
  }
  for (const key of OP_KEYS) {
    const nested = (args as any)[key]
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const inner of OP_KEYS) {
        const v = (nested as any)[inner]
        if (typeof v === "string" && v) return v.toLowerCase()
      }
    }
  }
  return null
}

export function isIdempotent(tool: string, args?: any): boolean {
  // A MULTIPLEXER decides by its ARGUMENT, not its name. `task` is one: `list` reads, `done` mutates —
  // and because the whole tool sat in the mutating deny-list, its READ operations inherited the write
  // exemption. Measured cost of that inheritance: one checkpoint-writer issued the byte-identical call
  // `task {"action":"list"}` 456 times in a single session, unchecked, burning 62.6M input tokens against
  // the main agent's 2.1M — ~97% of the machine — so the actual work crawled. The same shape applies to
  // `actor`, `todo`, and any MCP tool that selects its operation by argument, including ones not written
  // yet, which is why this asks the ARGUMENT rather than growing a list of tool names.
  const op = selectedOperation(args)
  if (op && READ_OPERATION_VERBS.has(op)) return true

  // Everything else keeps the previous classification EXACTLY. In particular a mutating call stays exempt,
  // and that is not an oversight: an identical RESULT proves the agent learned nothing new, but it does
  // NOT prove the world stood still. `note_append` answers a constant "Appended" while the file it writes
  // grows on every call — real progress behind an unchanging reply. A first version of this change treated
  // the result hash as a universal progress oracle and was refuted by exactly that case in this repo's own
  // suite; the oracle is exact for reads, and reads only.
  if (WAITING_TOOLS.has(tool)) return false
  if (MUTATING_TOOLS.has(tool)) return false
  return IDEMPOTENT_TOOLS.has(tool)
}

function failureRecoveryHint(tool: string, count: number): string {
  const common =
    `\`${tool}\` has failed ${count} times this turn — this looks like a loop. Do not switch to text-only; ` +
    `keep using tools, but diagnose before retrying: inspect the latest error and verify your assumptions. `
  if (tool === "bash" || tool === "bash_tool") {
    return common +
      "For shell failures run a small diagnostic (`pwd && ls -la`), then try an absolute path, a simpler command, " +
      "a different working directory, or a direct file tool (view/create_file/str_replace)."
  }
  return common +
    "Try different arguments, a narrower query/path, an absolute path when relevant, or a different tool. " +
    "If the blocker is external, report it after one diagnostic attempt instead of repeating the same failing call."
}

function mk(action: GuardAction, code: string, count: number, guidance: string): GuardDecision {
  return { action, code, count, guidance }
}

// Proactive END-OF-FILE hint for paginated reads (used by fabula-reliability's after-hook). In lib/ so the
// plugin file exports ONLY its Plugin factory. When a paginated read (offset>1) returns a short final page,
// tell the model plainly there is no more — kills "re-read the same last page forever" loops on weak models.
export function eofNotice(tool: string, args: any, out: string): string | null {
  if (!FILE_READ_TOOLS.has(tool) || typeof out !== "string") return null
  const offset = Number(args?.offset ?? args?.start_line ?? (Array.isArray(args?.view_range) ? args.view_range[0] : 0))
  if (!(offset > 1)) return null
  const limit = Number(args?.limit ?? args?.count ?? 0)
  const lines = out.length ? out.split("\n").length : 0
  const shortPage = (limit > 0 && lines < limit) || lines <= 5
  if (!shortPage) return null
  return `\n\n[END OF FILE — this read reached the end of the file (a short final page at offset ${offset}). ` +
    `There is no more content here. Do NOT read this file again at the same or a higher offset. Move to the ` +
    `next file, or use what you already have to continue.]`
}
