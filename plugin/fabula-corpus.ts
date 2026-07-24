// FABULA-LLM-5 — corpus map-reduce intercept (design: docs/research + live root-cause analysis of the
// book-analysis compaction loop). RULE #9: the harness INTERCEPTS a "read all chapters / the whole book
// and write a literary analysis" task deterministically — the model never chooses to load the raw corpus
// into one context. RULE #13: nothing hardcodes a volume or a filename (discoverCorpus globs the task
// directory; any book/document set is handled). RULE #14: model-agnostic — map steps + synthesize call
// whatever model is in the socket through the :1235 adapter.
//
// WHY (the live failure). On a large corpus the model loads chapters one by one until the prune
// threshold trips; compaction fires, the summarizer HIJACKS (continues the analysis instead of
// summarizing), retries, fails, the engine inserts a deterministic rebuild boundary — and the model
// re-reads the chapters from scratch because per-chapter progress was never persisted. Infinite loop,
// no report ever produced. This intercept makes the loop structurally impossible:
//   1. detect a corpus-analysis ask at the FIRST step of the turn (isCorpusAnalysisTask, narrow EN+RU);
//   2. CANCEL the normal agent turn (the engine exposes no "run my code instead of the LLM" hook —
//      cancel + out-of-band work + re-inject is the only clean path, already proven in fabula-attest);
//   3. discover the corpus (glob .md/.txt, chapter pattern), plan batches;
//   4. map: each batch is an ISOLATED call to the local model (role + STOP + that batch's chapters only),
//      the per-batch summary is threat-scanned + PERSISTED to a resume-safe accumulator;
//   5. reduce: synthesize the full report from the summaries (small context — no raw corpus);
//   6. re-inject the finished report into the chat (noReply — the report is final, the model does not
//      "answer" it). fabula-attest's text-only path then verifies the report. compaction never triggers
//      because no single context ever holds the raw corpus.

import type { Plugin } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import { chatBody, extractText } from "./lib/moa"
import { scanThreats } from "./lib/threatscan"
import { wrapUntrusted } from "./lib/untrusted"
import {
  isCorpusAnalysisTask,
  discoverCorpus,
  planBatches,
  chapterSummaryPrompt,
  synthesizeReportPrompt,
  cleanAnswer,
  accumulatorKey,
  seedAccumulator,
  markDone,
  pendingBatches,
  doneSummaries,
  clearAccumulator,
  DEFAULT_SUMMARY_TOKENS,
  DEFAULT_SYNTH_TOKENS,
  DEFAULT_CHAPTER_CAP,
  type CorpusFile,
} from "./lib/corpus"

const BASE = (process.env.FABULA_CORPUS_URL || process.env.FABULA_GRAPH_URL || "http://localhost:1235/v1").replace(/\/+$/, "")
const TIMEOUT_MS = Math.max(30000, parseInt(process.env.FABULA_CORPUS_TIMEOUT_MS || "0", 10) || 240000)
const BATCH_MAX_FILES = Math.max(1, parseInt(process.env.FABULA_CORPUS_BATCH_SIZE || "4", 10) || 4)
const BATCH_MAX_CHARS = Math.max(2048, parseInt(process.env.FABULA_CORPUS_BATCH_CHARS || "60000", 10) || 60000)
const CHAPTER_CAP = Math.max(1024, parseInt(process.env.FABULA_CORPUS_CHAPTER_CAP || "0", 10) || DEFAULT_CHAPTER_CAP)
const SUMMARY_TOKENS = Math.max(200, parseInt(process.env.FABULA_CORPUS_SUMMARY_TOKENS || "0", 10) || DEFAULT_SUMMARY_TOKENS)
const SYNTH_TOKENS = Math.max(400, parseInt(process.env.FABULA_CORPUS_SYNTH_TOKENS || "0", 10) || DEFAULT_SYNTH_TOKENS)
// A corpus smaller than this is NOT intercepted (fall back to the normal agent turn).
const MIN_CORPUS_FILES = Math.max(2, parseInt(process.env.FABULA_CORPUS_MIN || "2", 10) || 2)

let cachedModel = ""
async function localModel(): Promise<string> {
  if (process.env.FABULA_CORPUS_MODEL || process.env.FABULA_GRAPH_MODEL) return process.env.FABULA_CORPUS_MODEL || process.env.FABULA_GRAPH_MODEL!
  if (cachedModel) return cachedModel
  try {
    const r = await fetch(`${BASE}/models`)
    const j: any = await r.json()
    cachedModel = String(j?.data?.[0]?.id || "")
  } catch { cachedModel = "" }
  return cachedModel
}

/** One isolated call to the local model: single user message, temperature 0.4, non-streaming,
 *  /no_think appended so a reasoning build keeps its answer in `content`. Mirrors fabula-graph.callProv. */
async function callLocal(model: string, prompt: string, maxTokens: number): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatBody(model, prompt + "\n\n/no_think", maxTokens)),
      signal: ctrl.signal,
    })
    if (!r.ok) throw new Error(`local model HTTP ${r.status}`)
    return extractText(await r.json())
  } finally { clearTimeout(t) }
}

/** Re-inject a finished report back into the chat as a user turn with noReply (the report is final). */
async function reInjectReport(client: any, sessionID: string, report: string): Promise<void> {
  if (!client?.session?.prompt) return
  await client.session.prompt({
    path: { id: sessionID },
    body: { parts: [{ type: "text", text: report }], noReply: true },
  })
}

/** Re-inject the original task as a plain user turn (the edge-case fallback when the corpus is too small
 *  to intercept — we already cancelled the normal turn, so we must hand the task back to the model). */
async function reInjectFallbackTask(client: any, sessionID: string, taskText: string): Promise<void> {
  if (!client?.session?.prompt) return
  // noReply=false so the model actually picks the task up on its next turn
  await client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text: taskText }] } })
}

/** The out-of-band map-reduce pipeline. Runs after the normal turn is cancelled; persists progress to
 *  the accumulator so an interruption mid-map is resumable on the next intercept of the same task. */
async function runCorpusPipeline(client: any, dir: string, sessionID: string, taskText: string): Promise<void> {
  const cwd = dir || process.cwd()
  const key = accumulatorKey(sessionID, cwd)
  const disc = discoverCorpus(cwd)
  // Fail-open: too few files (or none) is NOT a corpus-analysis task the intercept should own — hand it
  // back to the model so the user still gets an answer.
  if (disc.files.length < MIN_CORPUS_FILES) {
    await reInjectFallbackTask(client, sessionID, taskText)
    return
  }
  const model = await localModel()
  if (!model) { await reInjectFallbackTask(client, sessionID, taskText); return }
  const batches = planBatches(disc.files, { maxFiles: BATCH_MAX_FILES, maxBatchChars: BATCH_MAX_CHARS })
  seedAccumulator(key, taskText, batches)
  // MAP — resume-safe: only batches with at least one not-done file run.
  for (const batch of pendingBatches(key, batches)) {
    try {
      let out = await callLocal(model, chapterSummaryPrompt(batch, taskText, CHAPTER_CAP), SUMMARY_TOKENS)
      const scan = scanThreats(out)
      if (scan.injection) out = wrapUntrusted(scan.cleaned, "corpus-batch", undefined)
      markDone(key, batch, out)
    } catch (e: any) {
      // a failed batch is marked done with an honest note — never silently lost, never blocks the rest.
      markDone(key, batch, `(batch failed: ${e?.message || "unknown"})`)
    }
  }
  // REDUCE — synthesize the full report from the per-batch summaries.
  const summaries = doneSummaries(key)
  if (summaries.length === 0) {
    await reInjectFallbackTask(client, sessionID, taskText)
    clearAccumulator(key)
    return
  }
  let report: string
  try {
    report = cleanAnswer(await callLocal(model, synthesizeReportPrompt(summaries, taskText), SYNTH_TOKENS))
    if (!report.trim()) report = summaries.map((s) => s.text).join("\n\n---\n\n")
  } catch {
    report = summaries.map((s) => s.text).join("\n\n---\n\n")
  }
  clearAccumulator(key) // clean exit; a re-run seeds fresh
  await reInjectReport(client, sessionID, `[fabula-corpus-report]\n\nАнализ построен map-reduce по ${disc.files.length} файлам корпуса (${batches.length} батч${batches.length === 1 ? "" : "ей"}), синтезирован из их аналитических резюме.\n\n${report}`)
}

export const FabulaCorpus: Plugin = async (pluginInput) =>
  process.env.FABULA_CORPUS === "0" ? {} : gate("corpus", {
    // Intercept ONLY on the first step of a turn, and ONLY for an explicit corpus-analysis ask.
    "session.userQuery.pre": async (input: any, output: any) => {
      try {
        if (input?.step !== 1) return // not the first step — let the normal turn run
        const text = typeof input?.query === "string" ? input.query : ""
        if (!isCorpusAnalysisTask(text)) return // narrow trigger — ordinary tasks never intercepted
        // Recursion guard: our own re-injected report/fallback must not re-trigger the intercept.
        if (text.startsWith("[fabula-corpus-report]")) return
        output.cancel = true
        output.cancelReason = "corpus map-reduce intercept — processing in the background"
        // Out-of-band: the turn is already cancelled; the pipeline runs to completion and re-injects.
        const sid = input?.sessionID
        const dir = pluginInput?.directory
        if (sid) void runCorpusPipeline((pluginInput as any)?.client, dir, sid, text).catch(() => {})
      } catch {}
    },
  })
