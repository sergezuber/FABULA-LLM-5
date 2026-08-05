// FABULA-LLM-5 — corpus map-reduce, fired by the SHAPE OF THE WORK. RULE #9: the harness decides
// deterministically — the model never chooses to load a raw corpus into one context. RULE #13: nothing
// hardcodes a volume or a filename (discoverCorpus globs the task directory; any book/document set is
// handled). RULE #14: model-agnostic — the worker calls whatever model is in the socket through the
// :1235 adapter.
//
// NOT A WORD IS READ. This plugin used to arm itself from a regex over the reader's wording, widened once
// per unseen phrasing; the owner rejected that approach (2026-07-28) and was right to. The trigger is now
// entirely lib/traversal: a turn reading file after file out of one directory, past what the MEASURED
// window holds, with more files still unread, is covering a corpus — in any language, however phrased,
// including phrasings nobody has written yet. That is the same answer Recursive Language Models
// (arXiv:2512.24601v3) reach from the other end: keep the material out of the root and every task looks
// identical at step one, so there is nothing left for a classifier to get wrong.
//
// WHY (the live failure). On a large corpus the model loads chapters one by one until the prune
// threshold trips; compaction fires, the summarizer HIJACKS (continues the analysis instead of
// summarizing), retries, fail, the engine inserts a deterministic rebuild boundary — and the model
// re-reads the chapters from scratch because per-chapter progress was never persisted. Infinite loop,
// no report ever produced. This makes the loop structurally impossible:
//   1. WATCH the turn's own tool calls and measure what it has taken in (traversalVerdict);
//   2. SPAWN A DETACHED WORKER (lib/corpus-worker.ts) that survives the engine's 5s hook timeout AND a
//      headless-process exit; the worker discovers the corpus, map-reduces it (each batch an ISOLATED
//      local-model call — the raw corpus never accumulates in one context, so compaction never triggers),
//      PERSISTS each per-batch summary to a resume-safe accumulator, synthesizes the full report, and
//      delivers it as an ANSWER over HTTP (POST /session/{id}/assistant-message) — not as a user turn,
//      which the chat would render as a narrow plain-text bubble with the machinery on show;
//   3. END the model's own turn at its next step, so the reader gets ONE answer and not two racing ones.
// fabula-attest's text-only path then verifies the report.

import type { Plugin } from "@mimo-ai/plugin"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { gate } from "./lib/manage"
import { registerChild, unregisterChild, reapOrphans } from "./lib/childreg"
import { accumulatorKey } from "./lib/corpus"
import { initTraversal, observeRead, traversalVerdict } from "./lib/traversal"
import { probeWindow } from "./lib/ctxguard"
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
import { existsSync, statSync } from "node:fs"
import { dataPath, findProgram } from "./lib/platform/paths"

const REPORT_TAG = "[fabula-corpus-report]"
const RECURSION_PREFIX = REPORT_TAG // a re-injected report must not re-trigger the intercept
// The worker script sits next to this file's lib/ sibling.
const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, "lib", "corpus-worker.ts")
// Resolve `bun` the way setup.sh / the app does (GUI-launched apps miss the shell PATH).
/**
 * The interpreter to spawn the worker with — the first candidate that EXISTS, not the first that is a
 * non-empty string.
 *
 * MEASURED 2026-08-01: this returned the first TRUTHY candidate, and candidate two is
 * `join(HOME, ".bun/bin/bun")` — a non-empty string whenever HOME is set, i.e. always. So the homebrew
 * and /usr/local fallbacks below it were unreachable code, and on a machine where bun lives only in
 * /opt/homebrew the worker would be spawned at a path that does not exist. On this machine
 * ~/.bun/bin/bun happens to be real, which is exactly why nothing ever noticed.
 *
 * An explicitly named FABULA_BUN_BIN is honoured whether or not it resolves — a caller who named an
 * interpreter has decided, and silently substituting a different one would be worse than failing.
 */
function bunBin(): string {
  const named = process.env.FABULA_BUN_BIN
  if (named) return named
  return findProgram("bun") // the search order is the platform's answer; PATH is the last resort
}

/** Did a previous attempt hand this session's task back to the model? The worker writes the marker
 *  beside its accumulator (same key), so the answer survives the process boundary between the two. */
function handedBack(sessionID: string, dir: string | undefined): boolean {
  try {
    const base = dataPath("corpus")
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
  // `shell` is decided by what the named program IS, not by which platform this is.
  //
  // The interpreter is whatever the operator named. On Windows a perfectly ordinary answer to "which
  // program runs my script" is a `.cmd` or `.bat` — that is how most tooling ships its entry point there
  // — and those are not executables the operating system can start directly: a plain spawn fails with
  // "not found" for a file that plainly exists. Handing exactly those to a shell is the difference
  // between honouring the operator's choice and silently ignoring it. Everything else is spawned
  // directly, as before, because routing a real executable through a shell would put a second grammar
  // between the harness and its own arguments.
  const bin = bunBin()
  const workerArgs = [WORKER, dir, sessionID, taskB64, serverUrl, REPORT_TAG]
  // Going through a shell means QUOTING IT OURSELVES. Spawning with `shell` switched on hands the
  // whole line to that shell verbatim and turns OFF the automatic quoting that a direct spawn does —
  // so a program living under a path with a space in it (which is where these paths ordinarily live)
  // is read as a command plus stray words, and nothing starts. Measured: the worker never launched and
  // the argv file never appeared, for eighteen seconds, with nothing said.
  const viaShell = /\.(cmd|bat)$/i.test(bin)
  const q = (a: string) => `"${String(a).replace(/"/g, '""')}"`
  // `detached` is asked for on the direct path and NOT on the shell path, and the difference is
  // measured rather than stylistic. Detaching plus a shell plus discarded output starts nothing at all
  // on the platform that needs the shell: the same stand-in launches from a plain spawn and never
  // launches from a detached shell one — eighteen seconds, no file, no error, because the output is
  // discarded by design. `unref` is what actually lets the turn finish without waiting, and it applies
  // to both; detaching only adds a separate process group, which is a smaller benefit than the work
  // starting at all.
  // The command interpreter is NAMED, rather than asked for through a `shell` option. Whether a runtime
  // honours that option is a property of the runtime, not of the platform, and when it does not the
  // spawn fails with "not found" for a file that plainly exists — into an error handler that swallows it
  // by design, so nothing anywhere says the work never started. Naming the interpreter removes the
  // question. `/d` skips autorun scripts, `/s` keeps the quoting of the line that follows.
  const child = viaShell
    ? spawn(process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", `"${[bin, ...workerArgs].map(q).join(" ")}"`], {
        stdio: "ignore",
        env: { ...process.env },
        windowsVerbatimArguments: true,
      } as any)
    : spawn(bin, workerArgs, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      })
  // FAIL-OPEN, BUT NOT SILENT. A turn must not crash because a worker could not start — and until now
  // that was the whole handler, so a spawn that never happened looked exactly like one that did: no
  // report, no marker, nothing to read. The turn still survives; the reason is now written where the
  // rest of this plugin's decisions are written.
  child.on("error", (e: any) => {
    console.error(`[fabula-corpus] worker did not start: ${e?.message ?? e} (interpreter: ${bin})`)
  })
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

/** What the turn has actually read, per session. Cleared when a new turn starts.
 *  `fired` — the verdict has been reached, so stop measuring.
 *  `owned` — a worker really started, so the model's own turn should end at its next step. */
const traces = new Map<string, { state: ReturnType<typeof initTraversal>; task: string; fired: boolean; owned: boolean; declined?: boolean }>()

export const FabulaCorpus: Plugin = async (pluginInput) =>
  process.env.FABULA_CORPUS === "0" ? {} : gate("corpus", {
    // WATCH WHAT THE TURN IS DOING. This is the whole trigger, and it owes nothing to the wording of the
    // ask: a turn reading file after file out of one directory, past what the measured window holds, with
    // more files still unread, is covering a corpus. No text is inspected anywhere in this decision.
    "tool.execute.after": async (input: any, output: any) => {
      try {
        const sid = input?.sessionID
        const t = sid && traces.get(sid)
        if (!t || t.fired) return
        const file = readTargetOf(input?.tool, output?.args ?? input?.args)
        if (!file) return
        // WHAT THE FILE ACTUALLY WEIGHED, not what is left of it. A result large enough to be held outside
        // the context (fabula-handle) reaches this hook already replaced by its descriptor, and measuring
        // that would report a hundred-thousand-character chapter as a few hundred — the traversal would
        // then never see a corpus precisely BECAUSE the corpus was too big to append.
        const chars = Number(output?.metadata?.fabulaHandle?.chars) || String(output?.output ?? "").length
        observeRead(t.state, { dir: dirname(file), path: file, chars })
        // The window is MEASURED from the runtime, never assumed; unmeasured decides nothing.
        const windowTokens = await probeWindow().catch(() => 0)
        const v = traversalVerdict(t.state, { windowTokens, filesInDir: countReadableFiles, taskRoot: pluginInput?.directory })
          if (!v.offload) {
            // A DECLINE IS A DECISION, and it was the only one here that said nothing. The mechanism
            // announced itself when it acted and stayed silent when it did not, so "the corpus was never
            // taken over" and "it was taken over and the worker never started" produced the same evidence:
            // none at all. Once per turn, so an ordinary turn reading a few files stays quiet.
            if (!t.declined) {
              t.declined = true
              console.error(`[fabula-corpus] traversal declined: ${v.reason} (window ${windowTokens})`)
            }
            return
          }
        // When the pipeline cannot own a task (corpus too small, no model reachable, nothing summarized)
        // it hands the ORIGINAL text back so the model answers it normally — and the model then reads the
        // same files again, which looks like the same traversal. Without a record of the hand-back the
        // next turn fires again, falls back again, and never terminates. The worker leaves the marker;
        // honouring it ends the cycle after exactly one attempt, per session and corpus.
        // STOP WATCHING EITHER WAY, but only OWN the turn when a worker really started. A suppressed
        // trigger that still cancelled the model's next step would silence the turn and put nothing in
        // its place — the reader's task simply dropped, which is the worst outcome on offer.
        t.fired = true
          if (handedBack(sid, v.dir)) {
            // The last silent exit. A previous attempt handed this task back, so nothing runs — correct,
            // and it produced no evidence at all, indistinguishable from a worker that started and
            // vanished. Both were reached during one investigation and only one of them was true.
            console.error(`[fabula-corpus] already handed back for this session and corpus; no worker started (${v.dir})`)
            return
          }
        t.owned = true
        console.error(`[fabula-corpus] traversal: ${v.reason}`)
        spawnWorker({ ...pluginInput, directory: v.dir }, sid, t.task || "")
      } catch {}
    },
    // Two jobs, neither of which reads the query for meaning.
    //   step 1 — start watching this turn, and remember the reader's own words so the pipeline can serve
    //            the actual ask. They are CARRIED, never classified.
    //   later  — once the pipeline has taken the work over, end the model's own turn. Leaving it running
    //            would have two producers writing one answer: the model appending chapters it can no
    //            longer fit while the worker composes the report the reader will actually be shown.
    "session.userQuery.pre": async (input: any, output: any) => {
      try {
        const sid = input?.sessionID
        if (input?.step === 1) {
          const text = typeof input?.query === "string" ? input.query : ""
          if (text.startsWith(RECURSION_PREFIX)) return // never watch our own re-inject
          if (sid) traces.set(sid, { state: initTraversal(), task: text, fired: false, owned: false })
          return
        }
        if (!sid) return
        const t = traces.get(sid)
        if (!t?.owned) return
        traces.delete(sid) // the turn is over; a later one starts its own trace at step 1
        output.cancel = true
        output.cancelReason = "corpus map-reduce — the material is being covered in the background"
      } catch {}
    },
  })
