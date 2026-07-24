// FABULA-LLM-5 — corpus map-reduce worker (standalone, detached). Spawned by fabula-corpus.ts as a
// DETACHED child process so a long map-reduce (minutes on a 28-chapter book) survives the engine's
// 5-second hook timeout AND the headless `bin/fabula run` exit. The worker re-injects the finished
// report back into the chat over HTTP (POST to the engine's /session/{id}/message) so it lands in the
// live server even after the spawning turn ended.
//
// Invocation:  bun plugin/lib/corpus-worker.ts <cwd> <sessionID> <taskText> <serverUrl> [reportTag]
// All args are strings; taskText is passed base64-encoded by the spawner to survive shell quoting.
// The worker is fully self-contained: it imports only the pure core (corpus.ts) + node:fetch.

import { discoverCorpus, planBatches, chapterSummaryPrompt, synthesizeReportPrompt, cleanAnswer, accumulatorKey, seedAccumulator, markDone, pendingBatches, doneSummaries, clearAccumulator, synthTokensFor } from "./corpus"
import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

// ── arg parsing (robust: taskText may contain shell-hostile chars, so accept it base64'd) ──────────
const [_node, _script, cwdArg, sessionID, taskB64, serverUrlArg, reportTagArg] = process.argv
const cwd = cwdArg || process.cwd()
const serverUrl = (serverUrlArg || "http://127.0.0.1:4096").replace(/\/+$/, "")
const reportTag = reportTagArg || "[fabula-corpus-report]"
if (!sessionID) { console.error("[corpus-worker] no sessionID"); process.exit(1) }
let taskText = ""
try { taskText = Buffer.from(taskB64 || "", "base64").toString("utf8") } catch { taskText = taskB64 || "" }

const BASE = (process.env.FABULA_CORPUS_URL || process.env.FABULA_GRAPH_URL || "http://localhost:1235/v1").replace(/\/+$/, "")
const TIMEOUT_MS = Math.max(30000, parseInt(process.env.FABULA_CORPUS_TIMEOUT_MS || "0", 10) || 240000)
const BATCH_MAX_FILES = Math.max(1, parseInt(process.env.FABULA_CORPUS_BATCH_SIZE || "4", 10) || 4)
const BATCH_MAX_CHARS = Math.max(2048, parseInt(process.env.FABULA_CORPUS_BATCH_CHARS || "60000", 10) || 60000)
const CHAPTER_CAP = Math.max(1024, parseInt(process.env.FABULA_CORPUS_CHAPTER_CAP || "0", 10) || 8000)
const SUMMARY_TOKENS = Math.max(200, parseInt(process.env.FABULA_CORPUS_SUMMARY_TOKENS || "0", 10) || 900)
// NB the synthesis budget is NOT a constant — it scales with how many batches the report must cover
// (synthTokensFor), so a book does not get a three-file-sized report cut off mid-heading.
const MIN_FILES = Math.max(2, parseInt(process.env.FABULA_CORPUS_MIN || "2", 10) || 2)

// ── heartbeat file: the spawner + any watchdog can see the worker is alive + how far it got ───────
const HB_DIR = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "fabula", "corpus") : join(process.env.HOME || "/tmp", ".local", "share", "fabula", "corpus")
const HB = join(HB_DIR, `${accumulatorKey(sessionID, cwd)}.heartbeat.json`)
function hb(state: string, extra: Record<string, unknown> = {}): void {
  try { writeFileSync(HB, JSON.stringify({ state, ts: Date.now(), sessionID, cwd, ...extra })) } catch {}
}

// ── local model (the socket, any model in it) ─────────────────────────────────────────────────────
async function localModel(): Promise<string> {
  if (process.env.FABULA_CORPUS_MODEL || process.env.FABULA_GRAPH_MODEL) return process.env.FABULA_CORPUS_MODEL || process.env.FABULA_GRAPH_MODEL!
  try { return String((await (await fetch(`${BASE}/models`)).json())?.data?.[0]?.id || "") }
  catch { return "" }
}
async function callLocal(model: string, prompt: string, maxTokens: number): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt + "\n\n/no_think" }], max_tokens: maxTokens, temperature: 0.4, stream: false }),
      signal: ctrl.signal,
    })
    if (!r.ok) throw new Error(`local model HTTP ${r.status}`)
    const j: any = await r.json()
    return j.choices?.[0]?.message?.content || j.choices?.[0]?.message?.reasoning_content || ""
  } finally { clearTimeout(t) }
}

// ── re-inject the finished report into the chat over HTTP ─────────────────────────────────────────
async function reInject(text: string, noReply: boolean): Promise<void> {
  // The engine speaks the same wire format the SDK builds. directory header scopes the request to
  // the right project (the spawning session's cwd), matching how the SDK client rewrites requests.
  const headers: Record<string, string> = { "content-type": "application/json" }
  const enc = encodeURIComponent(cwd)
  try {
    const r = await fetch(`${serverUrl}/session/${sessionID}/message?directory=${enc}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ parts: [{ type: "text", text }], noReply }),
    })
    if (!r.ok) console.error(`[corpus-worker] re-inject HTTP ${r.status}`)
  } catch (e: any) { console.error(`[corpus-worker] re-inject failed: ${e?.message}`) }
}

// ── main pipeline ─────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  hb("start", { taskText: taskText.slice(0, 200) })
  const disc = discoverCorpus(cwd)
  hb("discover", { files: disc.files.length, matched: disc.matched, fallback: disc.fallback })
  if (disc.files.length < MIN_FILES) {
    // Too small to own — hand the task back to the model as a normal user turn.
    await reInject(taskText, false)
    hb("fallback-too-small", { files: disc.files.length })
    return 0
  }
  const model = await localModel()
  if (!model) { await reInject(taskText, false); hb("fallback-no-model"); return 0 }
  const batches = planBatches(disc.files, { maxFiles: BATCH_MAX_FILES, maxBatchChars: BATCH_MAX_CHARS })
  const key = accumulatorKey(sessionID, cwd)
  seedAccumulator(key, taskText, batches)
  hb("seeded", { batches: batches.length })

  // MAP — resume-safe: only batches with at least one not-done file run.
  let done = 0
  for (const batch of pendingBatches(key, batches)) {
    hb("map", { done, total: batches.length, current: batch.map((f) => f.name) })
    try {
      // Sanitize per batch, not only at the end: an unsanitized summary carries the model's reasoning
      // into the accumulator, from where it is quoted verbatim into the synthesize prompt AND into the
      // raw-summaries fallback report. Cleaning only the final answer leaves both paths polluted.
      const out = cleanAnswer(await callLocal(model, chapterSummaryPrompt(batch, taskText, CHAPTER_CAP), SUMMARY_TOKENS))
      markDone(key, batch, out)
      done++
    } catch (e: any) {
      markDone(key, batch, `(batch failed: ${e?.message || "unknown"})`)
      done++
    }
  }

  // REDUCE — synthesize the full report from the per-batch summaries.
  hb("reduce", { summaries: doneSummaries(key).length })
  const summaries = doneSummaries(key)
  if (summaries.length === 0) { await reInject(taskText, false); clearAccumulator(key); hb("fallback-no-summaries"); return 0 }
  let report: string
  try {
    report = cleanAnswer(await callLocal(model, synthesizeReportPrompt(summaries, taskText), synthTokensFor(summaries.length, process.env)))
    if (!report.trim()) report = summaries.map((s) => s.text).join("\n\n---\n\n")
  } catch { report = summaries.map((s) => s.text).join("\n\n---\n\n") }
  clearAccumulator(key)
  // Provenance line, in the language the task was written in — a hardcoded language would prepend a
  // foreign sentence to every report for everyone else. Cyrillic in the ask is the same signal the
  // detector already keys on, so this stays a locale matcher rather than a hardcoded default.
  const n = disc.files.length
  const b = batches.length
  const header = /[Ѐ-ӿ]/.test(taskText)
    ? `${reportTag}\n\nАнализ собран map-reduce по ${n} файлам корпуса (${b} батч${b === 1 ? "" : "ей"}) и синтезирован из их резюме.\n\n`
    : `${reportTag}\n\nBuilt by map-reduce over ${n} corpus file${n === 1 ? "" : "s"} (${b} batch${b === 1 ? "" : "es"}), synthesized from their summaries.\n\n`
  await reInject(header + report, true) // noReply: the report is final, the model does not "answer" it
  hb("done", { reportChars: report.length })
  return 0
}

main().then((code) => process.exit(code)).catch((e) => { console.error(`[corpus-worker] fatal: ${e?.message}`); hb("fatal", { error: String(e?.message) }); process.exit(1) })
