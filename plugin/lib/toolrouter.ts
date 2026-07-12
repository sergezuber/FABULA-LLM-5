// Context OS §7 — the deterministic TOOL router core (pure, zero deps). RULE #9: the harness
// decides what the model sees; nothing here relies on model initiative. (Not to be confused
// with lib/router.ts — the workflow-graph local→cloud escalation router.)
//
// Pipeline per task text:
//   1. verbatim guaranteed-include — a tool id / parameter name appearing verbatim in the task
//      text pins that tool selected, always (a task saying «grep» trivially needs grep);
//   2. hybrid retrieval — RRF fusion of a BM25 arm (id + params + tags + utterances +
//      description) and an optional dense arm (max-cosine over utterance/description
//      embeddings, supplied by the caller — this module stays embedding-agnostic);
//   3. profile quantization — argmax over PROFILE scores (sum of member-tool scores), NOT
//      per-tool top-k: the output is a PROFILE ID from a closed registry, keeping the
//      front-of-prompt tool bytes quantized so cross-task KV-cache reuse survives (design K3);
//   4. hysteresis — the session keeps its current profile unless the challenger beats it by a
//      margin; with no signal at all the router falls back to the WIDEST profile (never block).
//
// BM25 here is the classic Okapi formula over tiny docs (~125), brute force — microseconds.

export type ToolCard = {
  id: string
  description: string
  params?: readonly string[]
  tags?: readonly string[]
  utterances?: readonly string[]
}

export type Profile = {
  id: string
  /** member tool ids (T1 delta; T0 is implicitly in every profile) */
  tools: readonly string[]
}

// ---------- tokenization ----------

/** Lowercase word tokens; splits snake/kebab/camel so `str_replace` matches «replace». */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-zа-яё0-9])([A-ZА-ЯЁ])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/)
    .filter((t) => t.length > 1)
}

/** The searchable document for one tool card. */
export function cardDocument(c: ToolCard): string[] {
  return [
    ...tokenize(c.id),
    ...tokenize(c.id), // id counts double — exact-intent words dominate
    ...(c.params ?? []).flatMap(tokenize),
    ...(c.tags ?? []).flatMap(tokenize),
    ...(c.utterances ?? []).flatMap(tokenize),
    ...tokenize(c.description),
  ]
}

// ---------- BM25 (Okapi) ----------

export type Bm25Index = {
  cards: ToolCard[]
  docs: string[][]
  df: Map<string, number>
  avgLen: number
}

export function buildIndex(cards: readonly ToolCard[]): Bm25Index {
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

/** Reciprocal-rank fusion of ranked arms. Each arm: Map<toolId, score> (higher = better).
 *  Standard k=60. Empty arms contribute nothing. */
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

/** Word-bounded verbatim match: `_` counts as a word character, so `place` does NOT match
 *  inside `str_replace`, while a standalone `old_str` DOES match (tokenize would split it). */
export function mentionedVerbatim(rawLower: string, needleLower: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9_])${escapeRegex(needleLower)}(?:[^a-z0-9_]|$)`).test(rawLower)
}

/** Tool ids / parameter names appearing VERBATIM in the task text.
 *  Design §7 rule: verbatim mention ⇒ always selected — the router may never hide it. */
export function verbatimIncludes(cards: readonly ToolCard[], taskText: string): Set<string> {
  const words = new Set(tokenize(taskText))
  const raw = taskText.toLowerCase()
  const out = new Set<string>()
  for (const c of cards) {
    const id = c.id.toLowerCase()
    if (id.length > 2 && mentionedVerbatim(raw, id)) {
      out.add(c.id)
      continue
    }
    // multi-token ids: ALL tokens present as words → include («str replace» matches str_replace)
    const idTokens = tokenize(c.id)
    if (idTokens.length > 1 && idTokens.every((t) => words.has(t))) {
      out.add(c.id)
      continue
    }
    for (const p of c.params ?? []) {
      const pl = p.toLowerCase()
      if (pl.length > 3 && (words.has(pl) || mentionedVerbatim(raw, pl))) {
        out.add(c.id)
        break
      }
    }
  }
  return out
}

// ---------- profile quantization + hysteresis ----------

export type RouteDecision = {
  profileId: string
  /** fused per-tool scores (diagnostics / ContextBundle manifest) */
  scores: Map<string, number>
  /** verbatim-pinned tools (must be visible regardless of profile membership) */
  pinned: Set<string>
  profileScores: Record<string, number>
  reason: "verbatim+scores" | "scores" | "hysteresis-hold" | "fallback-widest"
}

/** Sum of member-tool fused scores (pinned members count extra), normalized by sqrt(size)
 *  so a bulky profile can't win on mass alone. */
export function profileScore(p: Profile, fused: Map<string, number>, pinned: Set<string>): number {
  let s = 0
  for (const t of p.tools) {
    s += fused.get(t) ?? 0
    if (pinned.has(t)) s += 1
  }
  return p.tools.length ? s / Math.sqrt(p.tools.length) : 0
}

/**
 * Route a task text to a profile id from a CLOSED registry.
 * - hysteresis: the incumbent (`current`) survives unless a challenger beats it by `margin`;
 * - no signal at all → the WIDEST profile (correctness over leanness, never block a task);
 * - a pinned tool outside the top profile narrows the pool to profiles covering ALL pins
 *   (when none cover, the full pool stays and the widest-fallback covers correctness).
 */
export function route(
  cards: readonly ToolCard[],
  profiles: readonly Profile[],
  taskText: string,
  opts: { current?: string; margin?: number; denseArm?: Map<string, number>; index?: Bm25Index } = {},
): RouteDecision {
  if (!profiles.length) throw new Error("route: empty profile registry")
  const margin = opts.margin ?? 0.15
  const index = opts.index ?? buildIndex(cards)
  const pinned = verbatimIncludes(cards, taskText)
  const arms = [bm25Scores(index, taskText)]
  if (opts.denseArm?.size) arms.push(opts.denseArm)
  const fused = rrfFuse(arms)

  const profileScores: Record<string, number> = {}
  for (const p of profiles) profileScores[p.id] = profileScore(p, fused, pinned)

  const widest = [...profiles].sort((a, b) => b.tools.length - a.tools.length)[0]

  const covering = profiles.filter((p) => [...pinned].every((t) => p.tools.includes(t)))
  const pool = pinned.size && covering.length ? covering : profiles

  const best = [...pool].sort((a, b) => profileScores[b.id] - profileScores[a.id] || b.tools.length - a.tools.length)[0]
  const bestScore = profileScores[best.id]

  if (bestScore <= 0) {
    return { profileId: widest.id, scores: fused, pinned, profileScores, reason: "fallback-widest" }
  }
  if (opts.current && opts.current !== best.id) {
    // Hysteresis: hold the incumbent unless the challenger's ADVANTAGE exceeds `margin` as a
    // fraction of the challenger's own score. Well-defined at incumbent=0 (margin ≥ 1 always
    // holds; margin < 1 lets real signal displace a signal-less incumbent).
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
