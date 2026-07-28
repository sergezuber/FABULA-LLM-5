// What is happening, not what was said.
//
// The corpus intercept used to fire on the WORDING of the ask: a regex looking for "read all chapters",
// then a wider one looking for "in full", "what is it about", "critical description". Every widening was
// a guess about how the next person would phrase the same request, and the owner was right to reject it
// (2026-07-28) — the mechanism must understand the situation, and a phrase is not a situation.
//
// The situation IS measurable, and it needs no language at all. An agent covering a corpus leaves an
// unmistakable trace in its own tool calls: it reads file after file from ONE directory, the material it
// has taken in keeps growing against a window that does not, and there are still more files it has not
// reached. That trace is identical whether the ask was Russian, English, formal, casual, or a single
// word — and it never appears when somebody asks about one config file.
//
// This is the trigger the research points at. Recursive Language Models (arXiv:2512.24601v3) do not
// classify the ask either; they keep the material out of the root entirely so that every task looks the
// same from the first step. What is measured here is the moment that stops being possible — the point
// where continuing to append would put more into the window than the window holds.
//
// NO CONSTANT DECIDES IT. The window arrives from the caller, which measures it from the runtime. The
// figures written down here are POLICY — how much of a window is prudent to spend on raw material, and
// how many files make a traversal rather than a coincidence — named once so a reader can find and argue
// with them instead of discovering them inlined in arithmetic.

/** How much of the window raw material may occupy before covering it needs a different shape. POLICY. */
export const MATERIAL_SHARE = 0.35

/** Distinct files from one directory that make a traversal rather than two unrelated reads. POLICY. */
export const MIN_FILES = 4

/** Characters assumed per token. POLICY, deliberately low — under-counting fires later, never sooner. */
export const CHARS_PER_TOKEN = 2.5

export interface ReadEvent {
  /** The directory the file came from. Files from different directories are different traversals. */
  dir: string
  /** Absolute path, so the same file read twice counts once. */
  path: string
  /** Size of what actually entered the context. */
  chars: number
}

export interface DirTrace {
  paths: Set<string>
  chars: number
}

/** Per-turn observation. A plain object so a caller can hold one per session without ceremony. */
export interface TraversalState {
  byDir: Map<string, DirTrace>
}

export function initTraversal(): TraversalState {
  return { byDir: new Map() }
}

/** Record one file having been read into the context. Idempotent per path: re-reading the same file
 *  does not make a traversal look wider than it is. */
export function observeRead(st: TraversalState, ev: ReadEvent): TraversalState {
  if (!ev?.dir || !ev?.path) return st
  const t = st.byDir.get(ev.dir) ?? { paths: new Set<string>(), chars: 0 }
  if (t.paths.has(ev.path)) return st
  t.paths.add(ev.path)
  t.chars += Math.max(0, Number(ev.chars) || 0)
  st.byDir.set(ev.dir, t)
  return st
}

export interface Verdict {
  /** True when appending is no longer the right shape for this material. */
  offload: boolean
  /** The directory being traversed, when there is one. */
  dir?: string
  /** Words for the log. A decision nobody can read is a decision nobody can check. */
  reason: string
  /** What was measured, so the log carries the evidence and not just the conclusion. */
  filesRead?: number
  filesRemaining?: number
  materialTokens?: number
  budgetTokens?: number
}

export interface VerdictOpts {
  /** The window as MEASURED from the runtime. Zero or absent means unknown — and unknown never fires. */
  windowTokens: number
  /** How many files that directory holds in total. Absent means unknown. */
  filesInDir?: (dir: string) => number
  materialShare?: number
  minFiles?: number
  charsPerToken?: number
}

/**
 * Decide whether the material being taken in has outgrown the shape being used to take it. PURE.
 *
 * Three conditions, and all three are required — each one alone produces a false positive that would be
 * worse than the defect this replaces:
 *
 *  · ENOUGH FILES. Two files from a directory is a person answering a question about two files. A
 *    traversal is a pattern, and a pattern needs more than a pair to exist.
 *  · ENOUGH MATERIAL. Four tiny files are not a corpus, whatever they are named. The test is against
 *    the real window, so the same four files decide differently on different machines — which is
 *    correct, because the constraint being respected is the machine's, not the file's.
 *  · MORE TO COME. If everything has already been read, changing shape now buys nothing and would
 *    discard work already done. The trigger is for a traversal still in progress.
 *
 * Unknown window, unknown directory size, no reads: silent. An unmeasured quantity never fires a
 * mechanism — guessing here would mean intercepting somebody's ordinary work on a hunch.
 */
export function traversalVerdict(st: TraversalState, o: VerdictOpts): Verdict {
  const window = Number(o?.windowTokens) || 0
  if (!(window > 0)) return { offload: false, reason: "window not measured; nothing decided" }
  const share = o.materialShare ?? MATERIAL_SHARE
  const minFiles = o.minFiles ?? MIN_FILES
  const cpt = Math.max(1, o.charsPerToken ?? CHARS_PER_TOKEN)
  const budget = Math.floor(window * share)

  // THE WINDOW IS SHARED, SO THE OVERFLOW IS COUNTED ACROSS THE WHOLE TURN. Measuring each directory
  // against the budget separately asks the wrong question: nothing is running out of room per-folder,
  // the turn is running out of room. Counting per-directory also meant the verdict landed on whichever
  // folder happened to cross first — measured live 2026-07-28, that was a screenshots subfolder the
  // agent had wandered into, while 52 chapters sat unread in the folder above it.
  let material = 0
  for (const t of st.byDir.values()) material += t.chars
  const materialTokens = Math.ceil(material / cpt)
  if (materialTokens <= budget) {
    return { offload: false, reason: `~${materialTokens} tokens read, within a ${budget}-token budget`, materialTokens, budgetTokens: budget }
  }

  // THE TARGET IS THE BIGGEST JOB, not the first one to trip the counter. Where the turn ran out of room
  // is arithmetic about the machine; WHICH body of material is worth covering differently is a question
  // about the work, and the honest answer is the largest one still unfinished. Ranking by bytes already
  // read would answer "whichever folder held the fattest files" — a folder of images beats a book on
  // that measure and is almost never the thing being studied.
  let target: { dir: string; read: number; remaining: number; scope: number } | undefined
  let blocked: Verdict | undefined
  for (const [dir, t] of st.byDir) {
    const read = t.paths.size
    if (read < minFiles) continue
    const total = o.filesInDir?.(dir)
    // Unknown total is treated as "no more to come" — the conservative reading. Firing on a guess would
    // mean restructuring a turn without knowing whether anything is left to restructure it for.
    const remaining = typeof total === "number" && total > read ? total - read : 0
    if (remaining <= 0) {
      blocked ??= {
        offload: false,
        reason: `${dir}: ${read} file(s) read, ~${materialTokens} tokens, but nothing left to read`,
        filesRead: read,
        filesRemaining: 0,
        materialTokens,
        budgetTokens: budget,
      }
      continue
    }
    const scope = read + remaining
    if (!target || scope > target.scope) target = { dir, read, remaining, scope }
  }
  if (!target) return blocked ?? { offload: false, reason: "no directory shows a traversal" }
  return {
    offload: true,
    dir: target.dir,
    reason: `${target.dir}: ${target.read} of ${target.scope} file(s) read, ~${materialTokens} tokens taken in against a ${budget}-token budget, ${target.remaining} still unread — appending the rest would not fit`,
    filesRead: target.read,
    filesRemaining: target.remaining,
    materialTokens,
    budgetTokens: budget,
  }
}
