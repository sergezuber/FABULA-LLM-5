// FABULA-LLM-5 — multimodal (separate plugin per rule #4). Tools degrade gracefully: each
// works if its dependency is present (a vision endpoint / whisper / piper), else returns install
// guidance. No heavy import at load time, so the plugin is always safe to load.
//
//   vision_analyze (VLM)  ·  transcribe_audio (whisper)  ·  text_to_speech (Piper)

import { tool } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import type { Plugin } from "@mimo-ai/plugin"
import { promises as fs, existsSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn } from "node:child_process"
import { checkUrl, ssrfBlockedMessage } from "./lib/ssrf"
import { redactSecrets } from "./lib/redact"
import { whichAny, resolveVision, visionBody, mimeFromPath, extractVision, whisperPythonCandidates, FASTER_WHISPER_SCRIPT } from "./lib/multimodal"

const z = tool.schema

function run(bin: string, args: string[], opts: { input?: string; timeout?: number; cwd?: string } = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: opts.cwd })
    let out = "", killed = false
    const t = setTimeout(() => { killed = true; child.kill("SIGKILL") }, opts.timeout ?? 180000)
    child.stdout.on("data", (d) => (out += d.toString()))
    child.stderr.on("data", (d) => (out += d.toString()))
    if (opts.input) { child.stdin.write(opts.input); child.stdin.end() }
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out: out + (killed ? "\n[timed out]" : "") }) })
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out: `spawn error: ${e.message}` }) })
  })
}

export const FabulaMultimodal: Plugin = async () => gate("multimodal", ({
  tool: {
    vision_analyze: tool({
      description: "Analyze an image (local path or https URL) with a vision model and answer a question about it. " +
        "Requires a vision endpoint: set FABULA_VISION_URL+FABULA_VISION_MODEL (+FABULA_VISION_KEY) or LMSTUDIO_VLM_MODEL.",
      args: { image: z.string().describe("Local file path or https URL of the image"),
        prompt: z.string().describe("What to ask about the image") },
      async execute(args: any) {
        const ep = resolveVision(process.env)
        if (!ep) return "vision_analyze: no vision endpoint configured. Set FABULA_VISION_URL + FABULA_VISION_MODEL (+FABULA_VISION_KEY), or load a VLM in LM Studio and set LMSTUDIO_VLM_MODEL."
        let dataUrl: string
        try {
          if (/^https?:\/\//i.test(args.image)) {
            const v = await checkUrl(args.image); if (v.blocked) return ssrfBlockedMessage(v, args.image)
            const r = await fetch(args.image); const buf = Buffer.from(await r.arrayBuffer())
            dataUrl = `data:${r.headers.get("content-type") || mimeFromPath(args.image)};base64,${buf.toString("base64")}`
          } else {
            if (!existsSync(args.image)) return `vision_analyze: file not found: ${args.image}`
            const buf = await fs.readFile(args.image)
            dataUrl = `data:${mimeFromPath(args.image)};base64,${buf.toString("base64")}`
          }
          const r = await fetch(ep.url, { method: "POST", headers: { "Content-Type": "application/json", ...ep.headers }, body: JSON.stringify(visionBody(ep.model, args.prompt, dataUrl)) })
          if (!r.ok) return `vision_analyze error: HTTP ${r.status} from vision endpoint.`
          const text = extractVision(await r.json())
          return { output: redactSecrets(text || "(empty response)").text, metadata: { model: ep.model } }
        } catch (e: any) { return `vision_analyze error: ${e.message}` }
      },
    }),
    transcribe_audio: tool({
      description: "Transcribe a local audio file to text using a local whisper install. Requires `whisper` " +
        "(pip install openai-whisper) or whisper.cpp on PATH.",
      args: { path: z.string().describe("Local audio file path (wav/mp3/m4a)"),
        model: z.string().nullish().describe("whisper model size (default base)") },
      async execute(args: any) {
        if (!existsSync(args.path)) return `transcribe_audio: file not found: ${args.path}`
        const model = args.model || "base"
        // Preferred: faster-whisper via a python that has it (FABULA_WHISPER_PYTHON).
        for (const py of whisperPythonCandidates(process.env)) {
          const ok = await run(py, ["-c", "import faster_whisper"], { timeout: 15000 })
          if (ok.code !== 0) continue
          const r = await run(py, ["-c", FASTER_WHISPER_SCRIPT, args.path, model], { timeout: 600000 })
          const clean = r.out.split("\n").filter((l) => !/HF.?Hub|HF_TOKEN|unauthenticated requests|huggingface/i.test(l)).join("\n").trim()
          if (r.code === 0 && clean) return { output: clean, metadata: { engine: `faster-whisper(${py})`, model } }
          return `transcribe_audio: faster-whisper run failed.\n${r.out.slice(-600)}`
        }
        // Fallback: openai-whisper / whisper.cpp CLI if present.
        const whisper = await whichAny(["whisper", "whisper-cpp"])
        if (!whisper) return "transcribe_audio: no whisper available. Set FABULA_WHISPER_PYTHON to a python that has faster-whisper (pip install faster-whisper), or install openai-whisper."
        const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabula-whisper-"))
        const r = await run(whisper, [args.path, "--model", model, "--output_format", "txt", "--output_dir", outDir], { timeout: 600000 })
        try {
          const txt = (await fs.readdir(outDir)).find((f) => f.endsWith(".txt"))
          if (txt) { const content = await fs.readFile(path.join(outDir, txt), "utf8"); return { output: content.trim() || "(empty transcript)", metadata: { engine: whisper } } }
          return `transcribe_audio: completed but no transcript produced.\n${r.out.slice(-500)}`
        } finally { await fs.rm(outDir, { recursive: true, force: true }).catch(() => {}) }
      },
    }),
    text_to_speech: tool({
      description: "Synthesize speech from text to an audio file. Uses local Piper TTS if installed " +
        "(FABULA_PIPER_BIN + FABULA_PIPER_VOICE); otherwise falls back to the built-in macOS `say` command — " +
        "always available, no install. Russian text uses the Milena voice by default (override FABULA_SAY_VOICE). " +
        "Output format is taken from out_path's extension (.aiff, .m4a, or .wav). NOTE: this is spoken aloud, not sung.",
      args: { text: z.string().describe("Text to speak"), out_path: z.string().describe("Output audio path: .aiff, .m4a, or .wav") },
      async execute(args: any) {
        // 1) Piper (best quality) when fully configured.
        const piper = process.env.FABULA_PIPER_BIN || (await whichAny(["piper"]))
        const voice = process.env.FABULA_PIPER_VOICE
        if (piper && existsSync(piper) && voice && existsSync(voice)) {
          const r = await run(piper, ["-m", voice, "-f", args.out_path], { input: args.text, timeout: 120000 })
          if (existsSync(args.out_path)) return { output: `Wrote speech to ${args.out_path} (Piper).`, metadata: { engine: "piper", voice } }
          // else fall through to the built-in `say`
        }
        // 2) macOS `say` fallback — built-in, no install. Russian → Milena unless overridden.
        const sayBin = await whichAny(["say"])
        if (sayBin) {
          const sayVoice = process.env.FABULA_SAY_VOICE || (/[Ѐ-ӿ]/.test(args.text) ? "Milena" : "")
          const a = ["-o", args.out_path]
          if (sayVoice) a.push("-v", sayVoice)
          if (/\.wav$/i.test(args.out_path)) a.push("--data-format=LEI16@22050", "--file-format=WAVE") // say needs an explicit WAV format
          a.push(args.text)
          const r = await run(sayBin, a, { timeout: 120000 })
          if (existsSync(args.out_path)) return { output: `Wrote speech to ${args.out_path} (macOS say${sayVoice ? ", voice " + sayVoice : ", system voice"}). Spoken aloud, not sung.`, metadata: { engine: "say", voice: sayVoice || "default" } }
          return `text_to_speech error (say): ${r.out.slice(-300)}`
        }
        // 3) nothing available (non-macOS, no Piper)
        return "text_to_speech: no TTS engine available. Install Piper (FABULA_PIPER_BIN + FABULA_PIPER_VOICE), or run on macOS for the built-in `say`."
      },
    }),
  },
}))
