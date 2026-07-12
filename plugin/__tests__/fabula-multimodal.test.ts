// Multimodal graceful-degradation tests: tools must give clear guidance when a dep/config is absent
// (no whisper/piper/VLM installed here) — never crash.
import { test, expect, beforeAll } from "bun:test"
import { FabulaMultimodal } from "../fabula-multimodal"
import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"

let T: any
const ctx = {} as any
const out = (r: any) => (typeof r === "string" ? r : r.output)
beforeAll(async () => { T = (await FabulaMultimodal({} as any)).tool })

// Live deps (present only when .env is sourced + LM Studio up / faster-whisper installed).
const vlmReady = await (async () => {
  if (!process.env.LMSTUDIO_VLM_MODEL) return false
  try { return (await fetch("http://localhost:1234/v1/models", { signal: AbortSignal.timeout(2000) })).ok } catch { return false }
})()
const testImg = "/Users/user/Pictures/test-image.jpg"
const whisperPy = process.env.FABULA_WHISPER_PYTHON
const whisperReady = !!whisperPy && existsSync(whisperPy)
const piperReady = !!process.env.FABULA_PIPER_BIN && existsSync(process.env.FABULA_PIPER_BIN!) &&
  !!process.env.FABULA_PIPER_VOICE && existsSync(process.env.FABULA_PIPER_VOICE!)

test("vision_analyze without an endpoint → install/config guidance", async () => {
  const saved = { u: process.env.FABULA_VISION_URL, m: process.env.LMSTUDIO_VLM_MODEL }
  delete process.env.FABULA_VISION_URL; delete process.env.FABULA_VISION_MODEL; delete process.env.LMSTUDIO_VLM_MODEL
  const r = await T.vision_analyze.execute({ image: "/tmp/x.png", prompt: "what" }, ctx)
  expect(out(r)).toContain("no vision endpoint configured")
  if (saved.u) process.env.FABULA_VISION_URL = saved.u
  if (saved.m) process.env.LMSTUDIO_VLM_MODEL = saved.m
})
test("transcribe_audio missing file → clear error", async () => {
  const r = await T.transcribe_audio.execute({ path: "/tmp/nope-not-real.wav" }, ctx)
  expect(out(r)).toContain("file not found")
})
test("text_to_speech without piper → macOS say fallback (or install guidance elsewhere)", async () => {
  const saved = process.env.FABULA_PIPER_BIN
  delete process.env.FABULA_PIPER_BIN
  const r = await T.text_to_speech.execute({ text: "hi", out_path: "/tmp/o.wav" }, ctx)
  // On macOS the built-in `say` engine takes over; without it the tool explains how to install piper.
  expect(out(r)).toMatch(/macOS say|piper not found|FABULA_PIPER_VOICE/)
  if (saved) process.env.FABULA_PIPER_BIN = saved
})

// ── LIVE (run when .env is sourced + deps present; skip otherwise) ──
test.if(vlmReady && existsSync(testImg))("vision_analyze live: local VL model describes a real image", async () => {
  const r = await T.vision_analyze.execute({ image: testImg, prompt: "What is in this image? One short sentence." }, ctx)
  const o = out(r)
  expect(o.length).toBeGreaterThan(15)
  expect(o).not.toContain("no vision endpoint")
}, 90000)

test.if(whisperReady)("transcribe_audio live: faster-whisper transcribes generated speech", async () => {
  const wav = path.join(os.tmpdir(), "fabula-asr-" + process.pid + ".wav")
  try { execFileSync("say", ["-o", wav, "--data-format=LEI16@16000", "the quick brown fox"], { stdio: "ignore" }) } catch { return }
  const r = await T.transcribe_audio.execute({ path: wav }, ctx)
  const o = out(r).toLowerCase()
  expect(o).toMatch(/quick|brown|fox/)
  expect(o).not.toContain("hf_hub")
}, 180000)

test.if(piperReady)("text_to_speech live: piper synthesizes a real WAV", async () => {
  const wav = path.join(os.tmpdir(), "fabula-tts-" + process.pid + ".wav")
  const r = await T.text_to_speech.execute({ text: "FABULA Piper test, one two three.", out_path: wav }, ctx)
  expect(out(r)).toContain("Wrote speech")
  expect(existsSync(wav)).toBe(true)
}, 60000)
