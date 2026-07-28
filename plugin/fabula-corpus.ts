// FABULA-LLM-5 — corpus map-reduce intercept (design: docs/research + live root-cause analysis of the
// book-analysis compaction loop). RULE #9: the harness INTERCEPTS a "read all chapters / the whole book
// and write a literary analysis" task deterministically — the model never chooses to load the raw corpus
// into one context. RULE #13: nothing hardcodes a volume or a filename (discoverCorpus globs the task
// directory; any book/document set is handled). RULE #14: model-agnostic — the worker calls whatever
// model is in the socket through the :1235 adapter.
//
// WHY (the live failure). On a large corpus the model loads chapters one by one until the prune
// threshold trips; compaction fires, the summarizer HIJACKS (continues the analysis instead of
// summarizing), retries, fail, the engine inserts a deterministic rebuild boundary — and the model
// re-reads the chapters from scratch because per-chapter progress was never persisted. Infinite loop,
// no report ever produced. This intercept makes the loop structurally impossible:
//   1. detect a corpus-analysis ask at the FIRST step of the turn (isCorpusAnalysisTask, narrow EN+RU);
//   2. CANCEL the normal agent turn;
//   3. SPAWN A DETACHED WORKER (lib/corpus-worker.ts) that survives the engine's 5s hook timeout AND a
//      headless-process exit; the worker discovers the corpus, map-reduces it (each batch an ISOLATED
//      local-model call — the raw corpus never accumulates in one context, so compaction never triggers),
//      PERSISTS each per-batch summary to a resume-safe accumulator, synthesizes the full report, and
//      and delivers it as an ANSWER over HTTP (POST /session/{id}/assistant-message) — not as a user
//      turn, which the chat would render as a narrow plain-text bubble with the machinery on show.
// fabula-attest's text-only path then verifies the report.

import type { Plugin } from "@mimo-ai/plugin"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { gate } from "./lib/manage"
import { registerChild, unregisterChild, reapOrphans } from "./lib/childreg"
import { isCorpusAnalysisTask, accumulatorKey } from "./lib/corpus"
import { initTraversal, observeRead, traversalVerdict } from "./lib/traversal"
import { probeWindow } from "./lib/ctxguard"
import { dirname, join } from "node:path"
import { readdirSync } from "node:fs"

/** The file a read-family call actually pulled into the context, or nothing. Tools are named differently
 *  across the belt and across MCP servers, so the ARGUMENT is what is read — a call carrying a file path
 *  and returning text has brought a file in, whatever it is called. */
function readTargetOf(tool: unknown, args: any): string {
  const name = String(tool ?? "")
  if (!/read|view|cat|open|file/i.test(name)) return ""
  const p = args?.file_path ?? args?.path ?? args?.filePath ?? args?.filename
  return typeof p === "string" && p.startsWith("/") ? p : ""
}

/** How many readable files that directory holds. Unknown (unreadable, gone) counts as zero, and zero
 *  never fires the verdict — an unmeasured quantity must not restructure somebody's turn. */
function countReadableFiles(dir: string, depth = 2): number {
  // RECURSIVE, because the working directory must not look smaller than a folder inside it. Counting one
  // level made a subfolder of ten outrank a tree of fifty-two, which is how a screenshots folder came to
  // stand in for a book. Bounded depth: this runs on a tool result, and walking an entire disk to answer
  // it would cost more than the decision is worth.
  try {
    let n = 0
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (depth > 0 && !e.name.startsWith(".")) n += countReadableFiles(join(dir, e.name), depth - 1)
        continue
      }
      if (/\.(md|txt|rst|org|tex|html?)$/i.test(e.name)) n++
    }
    return n
  } catch {
    return 0
  }
}
import { existsSync } from "node:fs"

const REPORT_TAG = "[fabula-corpus-report]"
const RECURSION_PREFIX = REPORT_TAG // a re-injected report must not re-trigger the intercept
// The worker script sits next to this file's lib/ sibling.
const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, "lib", "corpus-worker.ts")
// Resolve `bun` the way setup.sh / the app does (GUI-launched apps miss the shell PATH).
function bunBin(): string {
  const cands = [process.env.FABULA_BUN_BIN, join(process.env.HOME || "", ".bun", "bin", "bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun", "bun"]
  for (const c of cands) if (c) return c
  return "bun"
}

/** Did a previous attempt hand this session's task back to the model? The worker writes the marker
 *  beside its accumulator (same key), so the answer survives the process boundary between the two. */
function handedBack(sessionID: string, dir: string | undefined): boolean {
  try {
    const base = process.env.XDG_DATA_HOME
      ? join(process.env.XDG_DATA_HOME, "fabula", "corpus")
      : join(process.env.HOME || "/tmp", ".local", "share", "fabula", "corpus")
    return existsSync(join(base, `${accumulatorKey(sessionID, dir || process.cwd())}.handback.json`))
  } catch { return false }
}

/** Spawn the detached worker. Fire-and-forget by design: the engine's hook timeout (5s) makes awaiting
 *  a minutes-long map-reduce inside the hook impossible, and a headless `bin/fabula run` exits on cancel
 *  (killing any in-process work). A detached child with stdio ignored outlives both. */
function spawnWorker(pluginInput: any, sessionID: string, taskText: string): void {
  const dir = pluginInput?.directory || process.cwd()
  const serverUrl = String(pluginInput?.serverUrl || "http://127.0.0.1:4096")
  const taskB64 = Buffer.from(taskText, "utf8").toString("base64")
  const child = spawn(bunBin(), [WORKER, dir, sessionID, taskB64, serverUrl, REPORT_TAG], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  })
  child.on("error", () => {}) // never let a spawn failure crash the turn (fail-open)
  // REGISTER IT. Detaching is what lets the work outlive the turn; it is also what puts the child beyond
  // `pkill -P <engine>`, which reaches only DIRECT children. One worker left over from a closed session
  // kept driving the model for hours and cost a live run — see lib/childreg.ts. Surviving the turn is the
  // point; surviving the app never is.
  if (child.pid) registerChild(child.pid, `corpus-worker ${sessionID}`)
  child.on("exit", () => { if (child.pid) unregisterChild(child.pid) })
  try { child.unref() } catch {} // parent does not wait for the child
}

// A NEW engine is starting, so anything registered by a dead one is an orphan by definition. Reaping at
// load is what would have prevented the incident: the leftover worker survived app restarts.
try {
  const r = reapOrphans()
  if (r.reaped.length)
    console.error(`[fabula-corpus] reaped ${r.reaped.length} orphaned worker(s): ${r.reaped.map((x) => x.label).join(", ")}`)
} catch { /* a safety net must never stop the plugin loading */ }

/** What the turn has actually read, per session. Cleared when a new turn starts. */
const traces = new Map<string, { state: ReturnType<typeof initTraversal>; task: string; fired: boolean }>()

export const FabulaCorpus: Plugin = async (pluginInput) =>
  process.env.FABULA_CORPUS === "0" ? {} : gate("corpus", {
    // WATCH WHAT THE TURN IS DOING. This is the trigger that owes nothing to the wording of the ask: a
    // turn reading file after file out of one directory, past what the measured window holds, with more
    // files still unread, is covering a corpus — in any language, however it was phrased, including
    // phrasings nobody has written yet. The word-matching detector below is kept only as a fast path
    // that saves the reader those first few reads; it is no longer what guarantees coverage.
    "tool.execute.after": async (input: any, output: any) => {
      try {
        const sid = input?.sessionID
        const t = sid && traces.get(sid)
        if (!t || t.fired) return
        const file = readTargetOf(input?.tool, output?.args ?? input?.args)
        if (!file) return
        observeRead(t.state, { dir: dirname(file), path: file, chars: String(output?.output ?? "").length })
        // The window is MEASURED from the runtime, never assumed; unmeasured decides nothing.
        const windowTokens = await probeWindow().catch(() => 0)
        const v = traversalVerdict(t.state, { windowTokens, filesInDir: countReadableFiles, taskRoot: pluginInput?.directory })
        if (!v.offload) return
        t.fired = true
        console.error(`[fabula-corpus] traversal: ${v.reason}`)
        spawnWorker({ ...pluginInput, directory: v.dir }, sid, t.task || "")
      } catch {}
    },
    // Intercept ONLY on the first step of a turn.
    "session.userQuery.pre": async (input: any, output: any) => {
      try {
        if (input?.step !== 1) return // not the first step — let the normal turn run
        const text = typeof input?.query === "string" ? input.query : ""
        if (text.startsWith(RECURSION_PREFIX)) return // never re-intercept our own re-inject
        // Start watching this turn regardless of how it was phrased. Whether the fast path below fires or
        // not, the traversal watcher above is now armed and will catch the same work by its shape.
        if (input?.sessionID) traces.set(input.sessionID, { state: initTraversal(), task: text, fired: false })
        if (!isCorpusAnalysisTask(text)) return // fast path only; the watcher is the guarantee
        // When the pipeline cannot own a task (corpus too small, no model reachable, nothing summarized)
        // it hands the ORIGINAL text back so the model answers it normally — and that text still matches
        // this detector. Without a record of the hand-back the next turn intercepts it again, falls back
        // again, and never terminates. The worker leaves the marker; honouring it ends the cycle after
        // exactly one attempt, per session and corpus, with nothing shown to the reader.
        const sid = input?.sessionID
        if (sid && handedBack(sid, pluginInput?.directory)) return
        output.cancel = true
        output.cancelReason = "corpus map-reduce intercept — processing in the background"
        if (sid) spawnWorker(pluginInput, sid, text)
      } catch {}
    },
  })
