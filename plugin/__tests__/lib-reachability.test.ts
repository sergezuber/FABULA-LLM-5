// Every exported helper must be REACHABLE from something that runs.
//
// WHY THIS EXISTS — it is the generator, not another instance. Four capabilities in this repository
// were written, documented, unit-tested and never called: `isRetrievalTool` (the guard's hot path asked
// a narrower question, so a fetch loop walked past a budget the tests asserted it shared),
// `instrrouter` (374 lines claiming a 188 KB context saving), `reprospec` and `mcpaudit` (both
// self-diagnosed in docs/research/DEFECTS-2026-07-20.md and still unwired months later). CLAUDE.md
// records the shape at least six times — "pure core green, wiring dead" — and each time an instance was
// repaired while the thing that produces instances stayed in place.
//
// The cause is mechanical. A test imports from `lib/` directly and asserts the pure function, so a
// helper with zero production callers is INDISTINGUISHABLE from a wired one: both are green, both look
// covered, and the only difference is invisible to every suite in the repo. This test makes that
// difference visible, and it is the one check that would have caught all four.
//
// It is deliberately NOT a lint rule about dead code. Unreachable is allowed — it just has to be
// DECLARED, with a reason a reader can weigh. A silent orphan is the defect; an acknowledged one is a
// decision.

import { test, expect } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const PLUGIN_DIR = join(import.meta.dir, "..")
const LIB_DIR = join(PLUGIN_DIR, "lib")

/**
 * Symbols that are knowingly unreachable, each with the reason it is allowed to stay.
 *
 * Adding a line here is a decision someone can argue with later. Leaving a symbol OUT of both this list
 * and production is the thing that has cost this project four times.
 */
const DECLARED_UNREACHABLE: Record<string, string> = {
  // The app-shutdown reap. Its caller is the SWIFT side (FabulaApp.swift), which reads the registry file
  // and kills the pids itself rather than starting a runtime to call in here — so no TypeScript path
  // reaches it, and none should. Kept because the rule it encodes ("when the app stops, everything it
  // started stops") belongs beside the registry it acts on, and because the tests exercise it against
  // real processes, which is what proves the thing actually dies.
  "childreg.ts:reapAll": "called from the app's own shutdown path in Swift, which reads the registry file directly",

  // Written for the moment a model is deliberately reloaded and the measured ceiling stops being true.
  // Nothing reloads a model mid-process today, so nothing calls it; it exists so that when something
  // does, the alternative is not `setLearnedWindow(0)` — which deliberately means "a probe reported
  // nothing useful" and must never shrink the window. Collapsing those two would make one of them wrong.
  "ctxguard.ts:clearLearnedWindow": "the explicit forget-it, kept distinct from a probe that answered nothing",

  // The UI carries its own twin of these (packages/ui/src/components/harness-steer.ts) because the
  // plugins and the frontend are separate build graphs and cannot share a module. The plugin side only
  // ever APPLIES the marker; reading it back is the frontend's job, so these two have no plugin caller
  // by design. A prefix mismatch between the twins degrades to the old error card, never to a hidden
  // failure, which is why the duplication is acceptable and this is a declaration rather than a wire.
  "steer.ts:isSteer": "read by the UI twin, which cannot import from plugin/",
  "steer.ts:steerText": "read by the UI twin, which cannot import from plugin/",

  // ── Whole modules with no consumer ────────────────────────────────────────
  "instrrouter.ts": "instruction-scope router: needs a filter inside the engine's Instruction.systemPaths that does not read its channel yet — wire or delete, do not leave claiming a 188 KB saving",
  "reprospec.ts": "spec-mining and reproduction generation: self-diagnosed in docs/research/DEFECTS-2026-07-20.md, still no caller",
  "mcpaudit.ts": "MCP supply-chain audit: its own docstring names an MCP-add flow and an `audit` tool, and neither exists",

  // ── Plugins that ship default-off: their libs are inert until a user enables them ──
  "buddy.ts:rollWithSeed": "fabula-buddy ships defaultEnabled:false — the whole plugin is inert out of the box",
  "buddy.ts:spriteFrameCount": "fabula-buddy ships defaultEnabled:false",
  "buddy.ts:renderFace": "fabula-buddy ships defaultEnabled:false",
  "daemon.ts:newDaemonState": "fabula-daemon ships defaultEnabled:false and is gated again by FABULA_DAEMON=1",
  "relay.ts:nextRung": "the six-rung ladder is the DESIGN MAP, deliberately not an automatic climb — CLAUDE.md says so in as many words",
  "memstore.ts:resolveConflict": "fabula-memory ships defaultEnabled:false with zero tools; its libs are inert by design until promoted",
  "memworth.ts:worthReport": "fabula-memory is default-off; the report has no surface to appear on yet",
  "memanchor.ts:anchorStale": "the serving path decides staleness through memserve, which withholds or re-reads the source; this predicate is the same question asked directly and is kept for the A/B harness",

  // ── Honest debt: written for a caller that was never built ─────────────────
  "witness.ts:pickLocalWitness": "the second resident does not fit on this machine (priced by planWindow, measured 2026-07-26), so nothing consults it yet",
  "witness.ts:groundingBlock": "same: the local cross-family review is proven by construction, not by a completed two-model run",
  "witness.ts:WitnessRecord": "type of the side-car record, read only where the record is written",
  "handoff.ts:handoffHistory": "no tool surfaces handoff history — save/read/list are the shipped three",
  "recheck.ts:renderGate": "the gate vocabulary reaches the artifact through renderRecheck; this renderer has no call site",
  "skillio.ts:validateSkillMd": "the registry route validates on write; this path was written for a CLI that does not exist",
  "gitdiff.ts:gitDiffAll": "the whole-tree variant: every caller wants the scoped one",
  "projectcontext.ts:parsePorcelain": "porcelain parsing kept for a status surface that was never added",
  "manifest.ts:pluginByFile": "lookup by file: every caller has the id already",
  "sandbox.ts:sandboxArgv": "argv builder used through resolveBackend, never directly",
  "execbackend.ts:backendNote": "the human-readable note has no surface printing it",
  "heartbeat.ts:isOverdue": "overdue detection reads through the ledger; this predicate has no caller",
  "risk.ts:elapsedSince": "helper of the W6 risk score, superseded by the streak clock",
  "langsteer.ts:intrudingScripts": "the diagnostic breakdown behind the steer decision; only the decision is used",
  "distillguard.ts:shouldBlockDistill": "the guard decides through blockedSelfImprovePass, which is the ONE decision covering every pass",
  "toolbelt.ts:activeTools": "the belt is applied by mask; the active list has no reader",
  "corpus.ts:DEFAULT_SUMMARY_TOKENS": "default consumed through the env knob, never referenced directly",
  "askledger.ts:LEDGER_ENV": "env NAME constant, used through askLedgerPath",
  "attest/quarantine.ts:needsQuarantine": "quarantine is applied unconditionally to fetched evidence, so the predicate is never asked",
  "graph.ts:execOrder": "topological order: the graph runs by LEVELS (execLevels), which is the parallel form",

  // ── Cross-build-graph twins: one copy per graph, neither can import the other ──
  "steer.ts:isSteer": "the UI twin (engine/packages/ui/src/components/harness-steer.ts) carries its own copy — separate build graphs cannot import from each other",
  "steer.ts:steerText": "same twin; a prefix mismatch degrades to the old error card, never to a hidden failure",
}

/** Test seams: an underscore prefix is this repo's convention for "production must not call this". */
const isTestSeam = (name: string) => name.startsWith("_")

/** Files whose exports are consumed by something outside this scan (the engine, scripts, the app). */
const EXTERNAL_CONSUMERS = [
  join(PLUGIN_DIR, "..", "scripts"),
  join(PLUGIN_DIR, "..", "app"),
]

function listFiles(dir: string, filter: (f: string) => boolean): string[] {
  try {
    return readdirSync(dir).filter(filter).map((f) => join(dir, f))
  } catch {
    return []
  }
}

const isProdTs = (f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts")

/** Everything that could legitimately call a helper: the plugins, the other helpers, scripts, the app. */
function productionCorpus(): { file: string; text: string }[] {
  const files = [
    ...listFiles(PLUGIN_DIR, (f) => f.startsWith("fabula-") && isProdTs(f)),
    ...listFiles(LIB_DIR, isProdTs),
    ...listFiles(join(LIB_DIR, "attest"), isProdTs),
    ...EXTERNAL_CONSUMERS.flatMap((d) => listFiles(d, isProdTs)),
  ]
  return files.map((file) => ({ file, text: readFileSync(file, "utf8") }))
}

/** Exported names of a module, by declaration — not by re-export, which would count nothing as used. */
function exportsOf(text: string): string[] {
  const out = new Set<string>()
  // FUNCTIONS, CONSTANTS and CLASSES only — the things that DO something. A `type` or `interface` is a
  // contract, routinely exported so the module's own signatures can name it, and flagging those buries
  // the one signal worth reading (a helper nobody calls) under dozens that mean nothing.
  const re = /^export\s+(?:async\s+)?(?:function|const|class|enum)\s+([A-Za-z_$][\w$]*)/gm
  for (const m of text.matchAll(re)) out.add(m[1])
  return [...out]
}

/**
 * Is `name` used anywhere in production, other than where it is declared?
 *
 * The definition line is excluded deliberately: a symbol that appears only in its own `export` is
 * exactly the thing being hunted, and a naive substring search would call it used.
 */
function usedInProduction(name: string, ownFile: string, corpus: { file: string; text: string }[]): boolean {
  const word = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`)
  const decl = new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|class|interface|type|enum)\\s+${name.replace(/[$]/g, "\\$")}\\b`)
  for (const { file, text } of corpus) {
    for (const line of text.split("\n")) {
      if (!word.test(line)) continue
      if (file === ownFile && decl.test(line)) continue // its own declaration proves nothing
      return true
    }
  }
  return false
}

test("every exported helper in lib/ is reachable from production, or declared unreachable with a reason", () => {
  const corpus = productionCorpus()
  const orphans: string[] = []

  for (const file of [...listFiles(LIB_DIR, isProdTs), ...listFiles(join(LIB_DIR, "attest"), isProdTs)]) {
    const base = file.slice(LIB_DIR.length + 1)
    if (DECLARED_UNREACHABLE[base]) continue // the whole module is declared, with its reason
    const text = readFileSync(file, "utf8")
    for (const name of exportsOf(text)) {
      if (isTestSeam(name)) continue
      if (DECLARED_UNREACHABLE[`${base}:${name}`]) continue
      if (!usedInProduction(name, file, corpus)) orphans.push(`${base}:${name}`)
    }
  }

  // The message has to be actionable, because the person who trips it did not write the orphan.
  expect(orphans, orphans.length
    ? `these exports have no production caller — wire them, delete them, or add them to DECLARED_UNREACHABLE with the reason:\n  ${orphans.join("\n  ")}`
    : "").toEqual([])
})

test("no module is an ISLAND — internally cohesive, externally dead", () => {
  // The per-symbol check above accepts a reference from anywhere, including the symbol's own file. That
  // is right for a live module's internal helpers — and it is exactly how `lib/attest/attestation.ts`
  // stayed invisible: written, tested, and never called from ANY other file, while its own exports
  // referenced each other and made the whole thing look used. The question that catches an island is
  // asked of the MODULE, not the symbol: does anything outside these bytes reach in?
  const corpus = productionCorpus()
  const islands: string[] = []

  for (const file of [...listFiles(LIB_DIR, isProdTs), ...listFiles(join(LIB_DIR, "attest"), isProdTs)]) {
    const base = file.slice(LIB_DIR.length + 1)
    if (DECLARED_UNREACHABLE[base]) continue
    const text = readFileSync(file, "utf8")
    const names = exportsOf(text)
    if (!names.length) continue
    // A module can be reached WITHOUT a symbol reference: the worker modules are spawned as detached
    // processes, so production names their PATH and never imports them. `fabula-ops.ts` builds
    // `lib/jobpostrun.ts` exactly that way, and calling it dead would be wrong in the loud direction.
    const stem = base.replace(/\.ts$/, "")
    const byPath = corpus.some((c) => c.file !== file && c.text.includes(stem))
    if (byPath) continue

    // A name declared in SEVERAL modules proves nothing when found elsewhere — `sha256` is defined in
    // five files here, so matching it anywhere made an untouched module look alive. Only names that are
    // unique in this codebase can testify that someone reached in.
    const declaredElsewhere = new Set<string>()
    for (const c of corpus) {
      if (c.file === file) continue
      for (const n of exportsOf(c.text)) declaredElsewhere.add(n)
    }
    const unique = names.filter((n) => !declaredElsewhere.has(n))
    if (!unique.length) continue // nothing here can speak either way; say nothing rather than guess

    const outside = corpus.filter((c) => c.file !== file)
    if (!unique.some((n) => usedInProduction(n, file, outside))) islands.push(base)
  }

  expect(islands, islands.length
    ? `nothing outside these modules uses any of their exports — wire one entry point, delete them, or declare them in DECLARED_UNREACHABLE:\n  ${islands.join("\n  ")}`
    : "").toEqual([])
})

test("the check can actually fail — a symbol nobody calls is reported", () => {
  // Guards the guard: if `usedInProduction` ever returned true unconditionally, the test above would
  // pass forever while proving nothing, which is the exact failure mode it exists to prevent.
  const corpus = [{ file: "/x/fake.ts", text: "export function loneliestFunction() {}\n" }]
  expect(usedInProduction("loneliestFunction", "/x/fake.ts", corpus)).toBe(false)
  expect(usedInProduction("loneliestFunction", "/other.ts", corpus)).toBe(true)
})

test("a declared-unreachable module names WHY, not just that it is allowed", () => {
  for (const [k, reason] of Object.entries(DECLARED_UNREACHABLE)) {
    expect(reason.length, `${k} needs a reason a reader can weigh`).toBeGreaterThan(30)
  }
})
