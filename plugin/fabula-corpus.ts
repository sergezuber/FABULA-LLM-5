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
//      re-injects it into the chat over HTTP (POST /session/{id}/message on the live server).
// fabula-attest's text-only path then verifies the report.

import type { Plugin } from "@mimo-ai/plugin"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { gate } from "./lib/manage"
import { isCorpusAnalysisTask } from "./lib/corpus"

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
  try { child.unref() } catch {} // parent does not wait for the child
}

export const FabulaCorpus: Plugin = async (pluginInput) =>
  process.env.FABULA_CORPUS === "0" ? {} : gate("corpus", {
    // Intercept ONLY on the first step of a turn, and ONLY for an explicit corpus-analysis ask.
    "session.userQuery.pre": async (input: any, output: any) => {
      try {
        if (input?.step !== 1) return // not the first step — let the normal turn run
        const text = typeof input?.query === "string" ? input.query : ""
        if (!isCorpusAnalysisTask(text)) return // narrow trigger — ordinary tasks never intercepted
        if (text.startsWith(RECURSION_PREFIX)) return // never re-intercept our own re-inject
        output.cancel = true
        output.cancelReason = "corpus map-reduce intercept — processing in the background"
        const sid = input?.sessionID
        if (sid) spawnWorker(pluginInput, sid, text)
      } catch {}
    },
  })
