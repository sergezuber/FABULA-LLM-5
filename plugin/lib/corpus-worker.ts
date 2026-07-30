// FABULA-LLM-5 — corpus map-reduce worker (standalone, detached). Spawned by fabula-corpus.ts as a
// DETACHED child process so a long map-reduce (minutes on a 28-chapter book) survives the engine's
// 5-second hook timeout AND the headless `bin/fabula run` exit. The worker re-injects the finished
// report back into the chat over HTTP (POST to the engine's /session/{id}/message) so it lands in the
// live server even after the spawning turn ended.
//
// Invocation:  bun plugin/lib/corpus-worker.ts <cwd> <sessionID> <taskText> <serverUrl> [reportTag]
// All args are strings; taskText is passed base64-encoded by the spawner to survive shell quoting.
// The worker is fully self-contained: it imports only the pure core (corpus.ts) + node:fetch.

import { DEFAULT_CHARS_PER_TOKEN as CHARS_PER_TOKEN } from "./ctxguard"
import { discoverCorpus, planBatches, chapterSummaryPrompt, synthesizeReportPrompt, synthesizeWithFallback, cleanAnswer, accumulatorKey, seedAccumulator, markDone, pendingBatches, doneSummaries, emptyBatchCount, clearAccumulator, synthTokensFor, corpusBudgets } from "./corpus"
import { budgetWindow } from "./handle"
import { probeWindow } from "./ctxguard"
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
// How much material one map call carries — corpusBudgets, in the pure core so it can be tested.
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
/** The one channel that writes an ASSISTANT message. Module-scope deliberately: the reduce path rewrites
 *  the streaming message after streamAnswer has returned, and a helper scoped inside it would make that
 *  rewrite a ReferenceError the tests cannot see (the wiring suite stands the worker in with a marker
 *  script and never executes this path). */
async function post(body: any): Promise<any> {
  const r = await fetch(`${serverUrl}/session/${sessionID}/assistant-message?directory=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`assistant-message HTTP ${r.status}`)
  return await r.json()
}

async function streamAnswer(model: string, prompt: string, maxTokens: number): Promise<{ text: string; truncated: boolean; messageID: string; partID: string } | null> {
  let messageID = ""
  let partID = ""
  let text = ""
  let truncated = false
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
    // A TRUNCATED stream is an intermediate, and intermediates never reach the reader (owner's rule,
    // 2026-07-28): do not finalize the stump. The message stays open and its ids go back to the caller,
    // which rewrites the SAME message with the full report — one message, filled in, never a stump plus
    // a second copy underneath it.
    if (!truncated) await post({ text: finalText, messageID, partID, final: true, model, tokens: usageTotal })
    return { text: finalText, truncated, messageID, partID }
  } catch (e: any) {
    console.error(`[corpus-worker] stream failed: ${e?.message}`)
    // The open message carries whatever partial streamed; the caller rewrites it with the finished
    // report, or empties it if no report can be produced. No service string ever lands in the chat.
    return { text: "", truncated: true, messageID, partID }
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
  // MEASURE THE SOCKET, then size the prompts to it. A probe that cannot answer falls back to the same
  // window figure every other consumer resolves — never to a number invented here.
  const windowTokens = budgetWindow(await probeWindow().catch(() => 0), process.env)
  const { batchChars: BATCH_MAX_CHARS, chapterCap: CHAPTER_CAP } = corpusBudgets(windowTokens, process.env)
  hb("budget", { windowTokens, batchChars: BATCH_MAX_CHARS, chapterCap: CHAPTER_CAP })
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
  // THE FINISHED ANSWER OR NOTHING (owner's rule, 2026-07-28). The raw per-batch summaries never reach
  // the chat: a failed flat synthesis reduces hierarchically (groups → internal partials → final), and
  // if no report can be produced at all, the task is handed back to the ordinary agent — silence, never
  // work-in-progress presented as an answer.
  // The report's room comes from the window it has to come back through, less the prompt that asks for
  // it — not from a constant. `windowTokens` is already what the socket reported for this run.
  const synthPrompt = synthesizeReportPrompt(summaries, taskText)
  const promptTokens = Math.ceil(synthPrompt.length / CHARS_PER_TOKEN)
  let budget = synthTokensFor(summaries.length, process.env, windowTokens, promptTokens)
  hb("reduce", { summaries: summaries.length, budget, promptTokens, windowTokens })
  const streamed = await streamAnswer(model, synthPrompt, budget)
  if (streamed && !streamed.truncated && streamed.text.trim()) {
    clearAccumulator(key)
    hb("done", { reportChars: streamed.text.length, streamed: true })
    return 0
  }
  // The streaming message (complete or a stump) is rewritten in place with whatever the fallback
  // produces — the reader sees ONE message that fills in, never a stump plus a second copy.
  const rewrite = async (text: string) => {
    if (streamed?.messageID && streamed?.partID) {
      await post({ text, messageID: streamed.messageID, partID: streamed.partID, final: true, model, tokens: usageTotal }).catch(() => {})
      return
    }
    await deliverAnswer(text)
  }
  const call = async (prompt: string, tokens: number): Promise<string> => {
    let b = tokens
    let out = await callLocalFull(model, prompt, b)
    for (let attempt = 0; attempt < 2 && out.truncated; attempt++) {
      const grown = Math.min(SYNTH_HARD_CAP, b * 2)
      if (grown <= b) break
      b = grown
      hb("reduce-retry", { budget: b })
      out = await callLocalFull(model, prompt, b)
    }
    // A truncated report is an intermediate too — treat it as a failure so the layered path runs.
    return out.truncated ? "" : cleanAnswer(out.text)
  }
  const report = await synthesizeWithFallback(call, summaries, taskText, process.env)
  if (!report) {
    // Nothing finished to show. Empty the streaming stump if one exists, hand the task back, stay silent.
    if (streamed?.messageID && streamed?.partID) await post({ text: "", messageID: streamed.messageID, partID: streamed.partID, final: true, model, tokens: usageTotal }).catch(() => {})
    markHandback()
    await reInject(taskText, false)
    clearAccumulator(key)
    hb("fallback-synthesis-failed")
    return 0
  }
  clearAccumulator(key)
  // NO PROVENANCE LINE. It used to open every report with how the answer had been assembled — the file
  // count, the batch count, the words "map-reduce". That is bookkeeping about the machine, printed in the
  // one place reserved for the answer, and it is the first thing the reader's eye lands on. How the work
  // was divided is a fact for the log, where a maintainer looks for it; it is not part of what was asked.
  await rewrite(report)
  hb("done", { reportChars: report.length })
  return 0
}

main().then((code) => process.exit(code)).catch((e) => { console.error(`[corpus-worker] fatal: ${e?.message}`); hb("fatal", { error: String(e?.message) }); process.exit(1) })
