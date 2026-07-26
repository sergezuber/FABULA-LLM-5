// FABULA-LLM-5 — corpus map-reduce worker (standalone, detached). Spawned by fabula-corpus.ts as a
// DETACHED child process so a long map-reduce (minutes on a 28-chapter book) survives the engine's
// 5-second hook timeout AND the headless `bin/fabula run` exit. The worker re-injects the finished
// report back into the chat over HTTP (POST to the engine's /session/{id}/message) so it lands in the
// live server even after the spawning turn ended.
//
// Invocation:  bun plugin/lib/corpus-worker.ts <cwd> <sessionID> <taskText> <serverUrl> [reportTag]
// All args are strings; taskText is passed base64-encoded by the spawner to survive shell quoting.
// The worker is fully self-contained: it imports only the pure core (corpus.ts) + node:fetch.

import { discoverCorpus, planBatches, chapterSummaryPrompt, synthesizeReportPrompt, cleanAnswer, accumulatorKey, seedAccumulator, markDone, pendingBatches, doneSummaries, emptyBatchCount, clearAccumulator, synthTokensFor } from "./corpus"
import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

// ── arg parsing (robust: taskText may contain shell-hostile chars, so accept it base64'd) ──────────
const [_node, _script, cwdArg, sessionID, taskB64, serverUrlArg, reportTagArg] = process.argv
const cwd = cwdArg || process.cwd()
const serverUrl = (serverUrlArg || "http://127.0.0.1:4096").replace(/\/+$/, "")
let usedModel = ""
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
const usageTotal = { input: 0, output: 0, reasoning: 0 }
const SYNTH_HARD_CAP = Math.max(2000, parseInt(process.env.FABULA_CORPUS_SYNTH_HARD_CAP || "0", 10) || 16000)
const MIN_FILES = Math.max(2, parseInt(process.env.FABULA_CORPUS_MIN || "2", 10) || 2)

// ── heartbeat file: the spawner + any watchdog can see the worker is alive + how far it got ───────
const HB_DIR = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "fabula", "corpus") : join(process.env.HOME || "/tmp", ".local", "share", "fabula", "corpus")
const HB = join(HB_DIR, `${accumulatorKey(sessionID, cwd)}.heartbeat.json`)
const HANDBACK = join(HB_DIR, `${accumulatorKey(sessionID, cwd)}.handback.json`)
function hb(state: string, extra: Record<string, unknown> = {}): void {
  try { writeFileSync(HB, JSON.stringify({ state, ts: Date.now(), sessionID, cwd, ...extra })) } catch {}
}

// ── local model (the socket, any model in it) ─────────────────────────────────────────────────────
async function localModel(): Promise<string> {
  if (process.env.FABULA_CORPUS_MODEL || process.env.FABULA_GRAPH_MODEL) return process.env.FABULA_CORPUS_MODEL || process.env.FABULA_GRAPH_MODEL!
  try { return String((await (await fetch(`${BASE}/models`)).json())?.data?.[0]?.id || "") }
  catch { return "" }
}
/** Ask the model, and say whether it STOPPED or simply RAN OUT of room. Guessing a token budget cannot
 *  work: the same report costs roughly three times more tokens in Russian than in English, so any constant
 *  is either wasteful for one language or truncating for another — measured, a 28-chapter report was cut
 *  mid-word at 4225 tokens against a 4260 budget. The model already reports which happened; use that
 *  instead of a better guess. */
async function callLocalFull(model: string, prompt: string, maxTokens: number): Promise<{ text: string; truncated: boolean }> {
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
    const u = j.usage || {}
    usageTotal.input += Number(u.prompt_tokens ?? 0)
    usageTotal.output += Number(u.completion_tokens ?? 0)
    usageTotal.reasoning += Number(u.completion_tokens_details?.reasoning_tokens ?? 0)
    const choice = j.choices?.[0]
    return {
      text: choice?.message?.content || choice?.message?.reasoning_content || "",
      truncated: choice?.finish_reason === "length",
    }
  } finally { clearTimeout(t) }
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
    const u = j.usage || {}
    usageTotal.input += Number(u.prompt_tokens ?? 0)
    usageTotal.output += Number(u.completion_tokens ?? 0)
    usageTotal.reasoning += Number(u.completion_tokens_details?.reasoning_tokens ?? 0)
    return j.choices?.[0]?.message?.content || j.choices?.[0]?.message?.reasoning_content || ""
  } finally { clearTimeout(t) }
}

// ── re-inject the finished report into the chat over HTTP ─────────────────────────────────────────
/** Write the report into the chat AS IT IS PRODUCED. A synthesis that buffers on the model side and
 *  lands in one lump after minutes of silence reads as a freeze; streamed, the reader can start reading
 *  immediately and can see the thing is alive without watching a counter. Falls back to the one-shot
 *  delivery on any streaming failure, and always closes the message — a half-written one left open is
 *  the same defect that once kept the progress line running forever.
 *  NB the map phase stays non-streaming on purpose: those summaries are internal and never shown. */
async function streamAnswer(model: string, prompt: string, maxTokens: number): Promise<{ text: string; truncated: boolean } | null> {
  let messageID = ""
  let partID = ""
  let text = ""
  let truncated = false
  const post = async (body: any) => {
    const r = await fetch(`${serverUrl}/session/${sessionID}/assistant-message?directory=${encodeURIComponent(cwd)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`assistant-message HTTP ${r.status}`)
    return await r.json()
  }
  try {
    const opened = await post({ text: "", model, final: false })
    messageID = opened.messageID; partID = opened.partID
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt + "\n\n/no_think" }], max_tokens: maxTokens, temperature: 0.4, stream: true }),
        signal: ctrl.signal,
      })
      if (!r.ok || !r.body) throw new Error(`local model HTTP ${r.status}`)
      const reader = r.body.getReader(); const dec = new TextDecoder()
      let buf = ""; let lastPush = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split("\n"); buf = lines.pop() || ""
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          const payload = line.slice(5).trim()
          if (payload === "[DONE]") continue
          try {
            const j = JSON.parse(payload)
            const ch = j.choices?.[0]
            if (ch?.finish_reason === "length") truncated = true
            const piece = ch?.delta?.content || ""
            if (piece) text += piece
            const u = j.usage
            if (u) {
              usageTotal.input += Number(u.prompt_tokens ?? 0)
              usageTotal.output += Number(u.completion_tokens ?? 0)
              usageTotal.reasoning += Number(u.completion_tokens_details?.reasoning_tokens ?? 0)
            }
          } catch {}
        }
        // Rewrite at a human cadence, not per token: the reader gains nothing from 60 updates a second
        // and the engine would carry the write traffic for all of them.
        if (text && Date.now() - lastPush > 400) { lastPush = Date.now(); await post({ text: cleanAnswer(text), messageID, partID, final: false }).catch(() => {}) }
      }
    } finally { clearTimeout(t) }
    const finalText = cleanAnswer(text)
    if (!finalText.trim()) throw new Error("empty stream")
    await post({ text: finalText, messageID, partID, final: true, model, tokens: usageTotal })
    return { text: finalText, truncated }
  } catch (e: any) {
    // Never leave a half-written message open — an unfinished one reads as work still in flight.
    if (messageID && partID) await post({ text: cleanAnswer(text) || "(the report could not be completed)", messageID, partID, final: true, model, tokens: usageTotal }).catch(() => {})
    console.error(`[corpus-worker] stream failed: ${e?.message}`)
    return null
  }
}

/** Deliver the finished report as an ANSWER. Handing it back through the prompt route made the producer
 *  speak as the USER, which the chat then renders as a narrow plain-text bubble — markdown shown as raw
 *  characters, and any marker the producer needs shown to the reader. An answer is what this actually is. */
async function deliverAnswer(text: string): Promise<void> {
  try {
    const r = await fetch(`${serverUrl}/session/${sessionID}/assistant-message?directory=${encodeURIComponent(cwd)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The pass really did spend these; a delivered answer carrying zeros makes the session's own
      // accounting lie about work that demonstrably happened.
      body: JSON.stringify({ text, model: usedModel, tokens: usageTotal }),
    })
    if (!r.ok) console.error(`[corpus-worker] deliver HTTP ${r.status}`)
  } catch (e: any) { console.error(`[corpus-worker] deliver failed: ${e?.message}`) }
}

/** Record that this session+corpus was handed back to the model, so the intercept does not fire again
 *  on the very text it just re-injected. The marker lives beside the accumulator (same key), survives
 *  the process boundary between worker and hook, and is never shown to anyone. */
function markHandback(): void {
  try { writeFileSync(HANDBACK, JSON.stringify({ ts: Date.now(), sessionID, cwd })) } catch {}
}

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
    markHandback(); await reInject(taskText, false)
    hb("fallback-too-small", { files: disc.files.length })
    return 0
  }
  const model = await localModel()
  usedModel = model
  if (!model) { markHandback(); await reInject(taskText, false); hb("fallback-no-model"); return 0 }
  const batches = planBatches(disc.files, { maxFiles: BATCH_MAX_FILES, maxBatchChars: BATCH_MAX_CHARS })
  const key = accumulatorKey(sessionID, cwd)
  seedAccumulator(key, taskText, batches)
  hb("seeded", { batches: batches.length })

  // MAP — resume-safe: only batches with at least one not-done file run.
  let done = 0
  let doneFiles = 0
  for (const batch of pendingBatches(key, batches)) {
    // Report REAL units, not batches: batching is an internal grouping, and "2 of 11" while the reader
    // sees 28 files on disk is simply wrong. The noun comes from what discovery actually found — a
    // chapter pattern matched or it did not — so nothing here assumes the corpus is a book.
    hb("map", {
      done: doneFiles,
      total: disc.files.length,
      unit: disc.fallback ? "files" : "chapters",
      current: batch.map((f) => f.name),
    })
    try {
      // Sanitize per batch, not only at the end: an unsanitized summary carries the model's reasoning
      // into the accumulator, from where it is quoted verbatim into the synthesize prompt AND into the
      // raw-summaries fallback report. Cleaning only the final answer leaves both paths polluted.
      const out = cleanAnswer(await callLocal(model, chapterSummaryPrompt(batch, taskText, CHAPTER_CAP), SUMMARY_TOKENS))
      markDone(key, batch, out)
      done++; doneFiles += batch.length
    } catch (e: any) {
      // Nothing usable came back. Record the ABSENCE — a fabricated "(batch failed: …)" string would
      // be quoted into the synthesise prompt as if it were a chapter summary. Same rule as the graph's
      // edge: a fan-in must be able to tell "nothing came back" from "this came back".
      markDone(key, batch, null)
      done++; doneFiles += batch.length
    }
  }

  // REDUCE — synthesize the full report from the per-batch summaries.
  hb("reduce", { summaries: doneSummaries(key).length })
  const summaries = doneSummaries(key)
  // Batches that produced nothing are a hole in the coverage, and a report that does not say so
  // presents a partial corpus as a whole one.
  const missing = emptyBatchCount(key)
  if (missing > 0) hb("reduce-gaps", { missing })
  if (summaries.length === 0) { markHandback(); await reInject(taskText, false); clearAccumulator(key); hb("fallback-no-summaries"); return 0 }
  let report: string
  try {
    let budget = synthTokensFor(summaries.length, process.env)
    // Try to write it into the chat as it is produced; fall back to producing it whole if streaming
    // fails, so a transport problem costs formatting-in-flight, never the report itself.
    const streamed = await streamAnswer(model, synthesizeReportPrompt(summaries, taskText), budget)
    if (streamed && !streamed.truncated) { hb("done", { reportChars: streamed.text.length, streamed: true }); return 0 }
    let out = streamed ?? (await callLocalFull(model, synthesizeReportPrompt(summaries, taskText), budget))
    // A report cut mid-sentence is worse than a shorter one written to fit, so grow the room and ask
    // again rather than shipping the stump. Bounded: two attempts, each doubling, never past the cap the
    // socket will actually return.
    for (let attempt = 0; attempt < 2 && out.truncated; attempt++) {
      const grown = Math.min(SYNTH_HARD_CAP, budget * 2)
      if (grown <= budget) break
      budget = grown
      hb("reduce-retry", { budget })
      out = await callLocalFull(model, synthesizeReportPrompt(summaries, taskText), budget)
    }
    report = cleanAnswer(out.text)
    if (!report.trim()) report = summaries.map((s) => s.text).join("\n\n---\n\n")
  } catch { report = summaries.map((s) => s.text).join("\n\n---\n\n") }
  clearAccumulator(key)
  // Provenance line, in the language the task was written in — a hardcoded language would prepend a
  // foreign sentence to every report for everyone else. Cyrillic in the ask is the same signal the
  // detector already keys on, so this stays a locale matcher rather than a hardcoded default.
  const n = disc.files.length
  const b = batches.length
  const header = /[Ѐ-ӿ]/.test(taskText)
    ? `Анализ собран map-reduce по ${n} файлам корпуса (${b} батч${b === 1 ? "" : "ей"}) и синтезирован из их резюме.\n\n`
    : `Built by map-reduce over ${n} corpus file${n === 1 ? "" : "s"} (${b} batch${b === 1 ? "" : "es"}), synthesized from their summaries.\n\n`
  await deliverAnswer(header + report)
  hb("done", { reportChars: report.length })
  return 0
}

main().then((code) => process.exit(code)).catch((e) => { console.error(`[corpus-worker] fatal: ${e?.message}`); hb("fatal", { error: String(e?.message) }); process.exit(1) })
