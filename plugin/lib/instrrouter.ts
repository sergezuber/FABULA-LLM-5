// Context OS — the deterministic INSTRUCTION router core (pure, zero deps). RULE #9: the harness
// decides which instruction files reach the model per task — nothing here relies on model
// initiative. This is the instruction-side mirror of lib/toolrouter.ts: cards describe instruction
// SOURCES (AGENTS.md variants), profiles are CONSENT/SCOPE sets (which cards the session may load),
// and `route()` picks one profile per task text. The selected profile is stamped on a per-ROOT-
// session channel that the engine's Instruction.systemPaths() reads to FILTER the unconditional
// ancestor findUp — so a session analyzing an external book no longer drags in 188 KB of host
// operational rules that never applied to it.
//
// Pipeline per task text (mirrors toolrouter.ts):
//   1. verbatim guaranteed-include — a marker phrase ("прочти все главы", "literary analysis",
//      "modify the engine") appearing verbatim pins the candidate profile;
//   2. hybrid retrieval — RRF fusion of a BM25 arm over instruction-card documents;
//   3. profile quantization — argmax over PROFILE scores (sum of member-card scores);
//   4. hysteresis — the session keeps its current profile unless a challenger beats it by a
//      margin; with no signal at all the router falls back to the WIDEST profile.
//
// CRITICAL FAIL-OPEN INVARIANT: a missing scope entry = LEGACY behavior (every discovered
// instruction file loads). No profile ever BLOCKS a task; an unknown signal degrades to `general`
// (= today). This is non-negotiable: the scope router is an optimization to fit the context
// budget, not a gate that can strand a session without its operating rules.

export type InstructionCard = {
  /** Stable short id, e.g. "host-fabula-rules", "external-book-rules", "global-rules". */
  id: string
  /** Human label for diagnostics + the manifest. */
  description: string
  /** Capability tags shared with the session timeline / README, e.g. ["rules", "engine"]. */
  tags?: readonly string[]
  /** Phrases RU + EN that select this card — verbatim and BM25-indexed. */
  utterances?: readonly string[]
}

export type ScopeProfile = {
  id: string
  /** Member card ids — T0 (global) is implicit, every profile inherits it. */
  cards: readonly string[]
}

// ---------- tokenization (shared with toolrouter — repeated locally to stay zero-dep) ----------

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-zа-яё0-9])([A-ZА-ЯЁ])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/)
    .filter((t) => t.length > 1)
}

export function cardDocument(c: InstructionCard): string[] {
  return [
    ...tokenize(c.id),
    ...tokenize(c.id),
    ...(c.tags ?? []).flatMap(tokenize),
    ...(c.utterances ?? []).flatMap(tokenize),
    ...tokenize(c.description),
  ]
}

// ---------- BM25 (Okapi) — same formula as toolrouter.ts ----------

export type Bm25Index = {
  cards: InstructionCard[]
  docs: string[][]
  df: Map<string, number>
  avgLen: number
}

export function buildIndex(cards: readonly InstructionCard[]): Bm25Index {
  const docs = cards.map(cardDocument)
  const df = new Map<string, number>()
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1)
  const avgLen = docs.length ? docs.reduce((s, d) => s + d.length, 0) / docs.length : 0
  return { cards: [...cards], docs, df, avgLen }
}

export function bm25Scores(index: Bm25Index, query: string, k1 = 1.2, b = 0.75): Map<string, number> {
  const q = [...new Set(tokenize(query))]
  const N = index.docs.length
  const out = new Map<string, number>()
  for (let i = 0; i < N; i++) {
    const doc = index.docs[i]
    if (!doc.length) continue
    const tf = new Map<string, number>()
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    for (const term of q) {
      const f = tf.get(term)
      if (!f) continue
      const n = index.df.get(term) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / index.avgLen))
    }
    if (score > 0) out.set(index.cards[i].id, score)
  }
  return out
}

// ---------- RRF fusion ----------

export function rrfFuse(arms: readonly Map<string, number>[], k = 60): Map<string, number> {
  const fused = new Map<string, number>()
  for (const arm of arms) {
    const ranked = [...arm.entries()].sort((a, b) => b[1] - a[1])
    ranked.forEach(([id], rank) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank + 1))
    })
  }
  return fused
}

// ---------- verbatim guaranteed-include ----------

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function mentionedVerbatim(rawLower: string, needleLower: string): boolean {
  if (!needleLower) return false
  const re = new RegExp(`(?:^|[^a-zа-яё0-9_])${escapeRegex(needleLower)}(?:[^a-zа-яё0-9_]|$)`)
  return re.test(rawLower)
}

/** Cards whose id or a multi-token utterance appears verbatim in the task text. */
export function verbatimIncludes(cards: readonly InstructionCard[], taskText: string): Set<string> {
  const raw = taskText.toLowerCase()
  const out = new Set<string>()
  for (const c of cards) {
    const id = c.id.toLowerCase()
    if (id.length > 2 && mentionedVerbatim(raw, id)) {
      out.add(c.id)
      continue
    }
    for (const u of c.utterances ?? []) {
      const ul = u.toLowerCase()
      // multi-token utterances → whole-phrase verbatim
      if (tokenize(ul).length > 1 && mentionedVerbatim(raw, ul)) {
        out.add(c.id)
        break
      }
    }
  }
  return out
}

// ---------- profile quantization + hysteresis ----------

export type ScopeDecision = {
  profileId: string
  scores: Map<string, number>
  pinned: Set<string>
  profileScores: Record<string, number>
  reason: "verbatim+scores" | "scores" | "hysteresis-hold" | "fallback-widest"
}

export function profileScore(p: ScopeProfile, fused: Map<string, number>, pinned: Set<string>): number {
  let s = 0
  for (const t of p.cards) {
    s += fused.get(t) ?? 0
    if (pinned.has(t)) s += 1
  }
  return p.cards.length ? s / Math.sqrt(p.cards.length) : 0
}

/**
 * Route the task text to a profile id from a CLOSED registry.
 * Hysteresis: the incumbent survives unless beaten by `margin` of the challenger's own score.
 * No signal → the WIDEST profile (load everything, never block — correctness over leanness).
 */
export function route(
  cards: readonly InstructionCard[],
  profiles: readonly ScopeProfile[],
  taskText: string,
  opts: { current?: string; margin?: number; index?: Bm25Index } = {},
): ScopeDecision {
  if (!profiles.length) throw new Error("route: empty profile registry")
  const margin = opts.margin ?? 0.15
  const index = opts.index ?? buildIndex(cards)
  const pinned = verbatimIncludes(cards, taskText)
  const fused = rrfFuse([bm25Scores(index, taskText)])

  const profileScores: Record<string, number> = {}
  for (const p of profiles) profileScores[p.id] = profileScore(p, fused, pinned)

  // WIDEST = the profile that loads the most cards (most permissive). The fallback when there is
  // no signal — preserving legacy "load everything" behavior. Ties broken in favor of `general`
  // so the explicit fail-open profile name is returned (and its exclude-set = ∅ is applied) rather
  // than an incidental profile that happens to load the same card count but is NOT documented as a
  // pure fail-open (e.g. fabula-coding loads 2 cards too, but it's a deliberate coding scope, not
  // a catch-all — general is the honest "I don't know" answer).
  const widest = [...profiles].sort(
    (a, b) => b.cards.length - a.cards.length || (b.id === "general" ? 1 : 0) - (a.id === "general" ? 1 : 0),
  )[0]

  const covering = profiles.filter((p) => [...pinned].every((t) => p.cards.includes(t)))
  const pool = pinned.size && covering.length ? covering : profiles

  const best = [...pool].sort((a, b) => profileScores[b.id] - profileScores[a.id] || b.cards.length - a.cards.length)[0]
  const bestScore = profileScores[best.id]

  if (bestScore <= 0) {
    return { profileId: widest.id, scores: fused, pinned, profileScores, reason: "fallback-widest" }
  }
  if (opts.current && opts.current !== best.id) {
    const inc = profileScores[opts.current] ?? 0
    if (bestScore - inc <= margin * bestScore + 1e-9) {
      return { profileId: opts.current, scores: fused, pinned, profileScores, reason: "hysteresis-hold" }
    }
  }
  return {
    profileId: best.id,
    scores: fused,
    pinned,
    profileScores,
    reason: pinned.size ? "verbatim+scores" : "scores",
  }
}

// ---------- card registry + closed profile set (the substrate the engine filters by) ----------

/** The card set described for the LIVE deployment. Cards carry stable ids; profile membership lists
 *  which cards each scope ADDS on top of the implicit global baseline.
 *
 *  The intent encoded here, deliberately:
 *  - `host-fabula-rules` = the big operational rule book that lives at the FABULA worktree root.
 *    It is RELEVANT only when the agent works INSIDE the FABULA repo — never when a session is
 *    opened elsewhere (a book analysis, a foreign project). Loading it unconditionally is exactly
 *    the static-prefix bloat that wedged one analysis session into an infinite compaction loop.
 *  - `external-doc-rules` = the AGENTS.md / CLAUDE.md / CONTEXT.md the session's OWN directory
 *    tree provides, when any. Those rules DO belong to the task regardless of where the user
 *    pointed the session.
 *  - `global-rules` = `~/.config/fabula/AGENTS.md` (neutral engine defaults) — implicit, included
 *    by every profile so nothing the user explicitly placed in their global config is dropped.
 */
export const INSTRUCTION_CARDS: InstructionCard[] = [
  {
    id: "host-fabula-rules",
    description: "FABULA engine contributor rules: the operational rule book (AGENTS.md at the FABULA worktree).",
    tags: ["rules", "engine", "fabula"],
    utterances: [
      // EN — agent talks about working ON the engine/repo itself
      "the engine", "modify the engine", "engine build", "fabula engine",
      "the adapter", "lmstudio adapter", "the plugin", "plugin contract",
      "opencode", "mimocode", "the receipt", "proof of done",
      "build the engine", "engine typecheck", "engine package",
      // RU — same intent
      "почини движок", "движок", "обнови", "перепроектируй", "обвязку",
      "запусти тесты движка", "проверь плагин", "адаптер", "тул-роутер",
      "Коран-озеро",
    ],
  },
  {
    id: "external-doc-rules",
    description: "Instruction files (AGENTS.md/CLAUDE.md/CONTEXT.md) found in the session's OWN directory tree.",
    tags: ["rules", "docs"],
    utterances: [
      "analyze the book", "read all chapters", "literary analysis",
      "review the document", "summarize the text", "external book",
      "прочти все главы", "прочитай книгу", "анализ текста", "уровень литературы",
      "анализ романа", "перескажи", "главы книги", "проанализируй стиль",
    ],
  },
]

export type InstrScope = "fabula-coding" | "external-doc" | "general"

/**
 * The CLOSED profile registry. `general` is the widest — it loads EVERYTHING (legacy behavior).
 *  - `fabula-coding` keeps the host rules (T0: global implicit).
 *  - `external-doc` keeps the session-tree instructions but DROPS the host rules — this is the
 *    profile that frees a non-FABULA session from the 188 KB static-prefix tax.
 *  - `general` loads everything — the fail-open fallback.
 */
export const INSTR_PROFILES: ScopeProfile[] = [
  { id: "fabula-coding", cards: ["host-fabula-rules", "external-doc-rules"] },
  { id: "external-doc", cards: ["external-doc-rules"] },
  { id: "general", cards: ["host-fabula-rules", "external-doc-rules"] },
]

/** Which cards each profile EXCLUDES relative to loading nothing — the deny list the engine reads
 *  to filter `Instruction.systemPaths()`. Computed from INSTR_PROFILES so the registry stays the
 *  single source of truth. T0 (global) is NEVER excluded (it is implicit everywhere — see your
 *  global `~/.config/fabula/AGENTS.md` always loads). */
export function excludedCardsFor(profileId: string, allCardIds: readonly string[]): Set<string> {
  const profile = INSTR_PROFILES.find((p) => p.id === profileId)
  if (!profile) return new Set() // unknown → fail open → exclude nothing (legacy behavior)
  const kept = new Set(profile.cards)
  return new Set(allCardIds.filter((id) => !kept.has(id)))
}

// ---------- per-session channel + capped LRU writer (mirror beltwire) ----------

export const INSTR_CHANNEL_KEY = "__FABULA_SESSION_INSTR_SCOPE__"

export type InstrEntry = {
  profileId: InstrScope
  /** Cards explicitly excluded by this scope — engine Instruction.systemPaths() reads this set. */
  excludedCardIds: readonly string[]
  /** Hint: which instruction-file PATHS the entry excludes (resolved by the plugin from cards).
   *  Carried for diagnostics + so the engine does not need to re-resolve cards → paths. */
  excludedPaths?: readonly string[]
  reason: string
  watermark?: string
}

export function instrChannel(): Map<string, InstrEntry> {
  const g = globalThis as Record<string, unknown>
  if (!(g[INSTR_CHANNEL_KEY] instanceof Map)) g[INSTR_CHANNEL_KEY] = new Map<string, InstrEntry>()
  return g[INSTR_CHANNEL_KEY] as Map<string, InstrEntry>
}

const CHANNEL_MAX_SESSIONS = (() => {
  const n = Number(process.env.FABULA_INSTR_CHANNEL_MAX)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 32
})()

function capChannel<V>(m: Map<string, V>, keep: string): void {
  while (m.size > CHANNEL_MAX_SESSIONS) {
    const oldest = m.keys().next().value as string | undefined
    if (oldest === undefined || oldest === keep) break
    m.delete(oldest)
  }
}

/** Drop the channel entry for a session — call when the engine says the session is gone.
 *  Mirrors beltwire.dropSessionChannels. */
export function dropInstrScopeChannel(sessionID: string): void {
  instrChannel().delete(sessionID)
}

/** The ONLY supported writer (a direct `.set()` would skip the LRU cap). */
export function setInstrEntry(sessionID: string, entry: InstrEntry): void {
  const m = instrChannel()
  m.delete(sessionID) // re-insert so this session is the most recent, never the eviction candidate
  m.set(sessionID, entry)
  capChannel(m, sessionID)
}

export function instrScopeFor(sessionID: string): InstrEntry | undefined {
  return instrChannel().get(sessionID)
}

export function instrRouterOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.FABULA_INSTR_ROUTER === "1"
}

/** Extract the task text from a chat.message output payload (same shape as beltwire.taskTextFrom). */
export function taskTextFrom(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((p: any) => p && p.type === "text" && !p.synthetic && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n")
    .trim()
}

/** PURE decision step (unit-tested): route the task text and produce the scope entry. */
export function decideInstrScope(
  taskText: string,
  current?: string,
  opts: { allCardIds?: readonly string[] } = {},
): { entry: InstrEntry; reason: string } {
  const cards = INSTRUCTION_CARDS
  const profiles = INSTR_PROFILES
  const decision = route(cards, profiles, taskText, { current })
  const all = opts.allCardIds ?? cards.map((c) => c.id)
  const excluded = [...excludedCardsFor(decision.profileId, all)]
  return {
    entry: {
      profileId: decision.profileId as InstrScope,
      excludedCardIds: excluded,
      reason: decision.reason,
    },
    reason: decision.reason,
  }
}
