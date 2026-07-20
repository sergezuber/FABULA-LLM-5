// FABULA-LLM-5 — coding-context posture (separate plugin per the one-plugin-per-file rule).
// Injects a per-turn system block (cwd + git status + detected verify command + edit rules) via
// experimental.chat.system.transform. Git runs with a hard timeout + per-dir cache so it can NEVER
// re-introduce the big-repo freeze that MIMOCODE_DISABLE_GIT (an engine flag) was set to avoid.

import type { Plugin } from "@mimo-ai/plugin"
import { isEnabled } from "./lib/manage"
import { pinAwareTruncate } from "./lib/memserve"
import { promises as fs, realpathSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { formatProjectContext, ProjectFacts } from "./lib/projectcontext"
import { detectVerifyCommand } from "./lib/verifycmd"
import { codingMask, beltPromptBlock } from "./lib/toolbelt"
import { beltChannel, catalogBlock } from "./lib/beltwire"
import { TOOL_META } from "./lib/toolmeta"

// Coding tool belt (opt-in via FABULA_PROFILE=coding): mask the non-coding tool schemas so they never
// reach the model — cuts prefill (measured live: 125 -> 101 tool schemas). The engine's resolveTools
// reads FABULA_TOOL_MASK; we set it here at load (same process) if the profile is on and it isn't
// already set. Default OFF = no change for normal use. The belt note below reconciles the monolithic
// system prompt (which still documents every tool) so the model doesn't waste a turn on a masked tool.
const CODING_PROFILE = process.env.FABULA_PROFILE === "coding"
const CODING_MASK = new Set(codingMask(TOOL_META))
if (CODING_PROFILE && !process.env.FABULA_TOOL_MASK) {
  process.env.FABULA_TOOL_MASK = [...CODING_MASK].join(",")
}
const BELT_ACTIVE = Object.keys(TOOL_META).filter((id) => !CODING_MASK.has(id))

const TTL_MS = 20_000
const GIT_TIMEOUT = 1500
const cache = new Map<string, { facts: ProjectFacts; ts: number }>()

// Curated operating-memory injection. Resolves <FABULA-LLM-5>/.fabula/memory/MEMORY.md
// (override with FABULA_MEMORY_FILE) via the plugin's OWN resolved location (realpath through the
// ~/.config/mimocode/plugin symlink), so the in-app local model finally SEES the durable house rules it
// otherwise never reads. Capped (~3KB) + TTL-cached + try/catch → can never bloat context or break a turn.
const MEMORY_CAP = 3000
const MEMORY_TTL = 30_000
const MEMORY_FILE = process.env.FABULA_MEMORY_FILE || (() => {
  let dir: string
  try { dir = path.dirname(realpathSync(fileURLToPath(import.meta.url))) } catch { dir = path.dirname(fileURLToPath(import.meta.url)) }
  return path.join(dir, "..", ".fabula", "memory", "MEMORY.md")
})()
let memCache: { block: string; ts: number } | null = null
async function memoryBlock(nowMs: number): Promise<string> {
  if (memCache && nowMs - memCache.ts < MEMORY_TTL) return memCache.block
  let block = ""
  try {
    const text = (await fs.readFile(MEMORY_FILE, "utf8")).trim()
    if (text) {
      // Pin-aware, because the naive slice was POSITIONAL: whether a hard constraint reached the model
      // depended on where in the file someone happened to type it. A rule at the bottom of MEMORY.md was
      // invisible; the same rule three lines higher was honoured. That is an accident, not a policy.
      const capped = pinAwareTruncate(text, MEMORY_CAP)
      block = "<operating-memory>\n" + capped + "\n</operating-memory>"
    }
  } catch { block = "" }
  memCache = { block, ts: nowMs }
  return block
}

function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, ...args], { timeout: GIT_TIMEOUT, maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve(err ? "" : (stdout || "").toString())
    })
  })
}

async function gather(dir: string, nowMs: number): Promise<ProjectFacts> {
  const hit = cache.get(dir)
  if (hit && nowMs - hit.ts < TTL_MS) return hit.facts

  const facts: ProjectFacts = { cwd: dir }
  // The lsp nudge only when the engine's native lsp tool is actually exposed (same gate as the
  // engine's tool registry: MIMOCODE_EXPERIMENTAL_LSP_TOOL or the umbrella MIMOCODE_EXPERIMENTAL).
  if (process.env.MIMOCODE_EXPERIMENTAL_LSP_TOOL || process.env.MIMOCODE_EXPERIMENTAL) facts.lspTool = true
  // git branch only (stable within a session). The changed-files list (git status) is deliberately
  // NOT injected: it changes on every edit, and it lives in the SYSTEM message, so any change busts
  // the local model's KV-cache of the large, static system+tools prefix — forcing a full ~67k-token
  // re-prefill EACH step (measured 2026-07-06: a stable system reuses cache ≈0.3s vs ≈13-75s cold).
  // The model can run `git status` itself when it needs the working set. Keeping the prefix byte-stable
  // is the single biggest per-step speedup on local models. (Measured cache probe in private-bench/.)
  const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
  if (branch) facts.branch = branch
  // verify command (cheap: one readdir + maybe package.json)
  try {
    const files = await fs.readdir(dir)
    let scripts: Record<string, string> | null = null
    if (files.includes("package.json")) {
      try { scripts = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")).scripts || null } catch {}
    }
    const det = detectVerifyCommand(files, scripts)
    if (det) { facts.verifyCmd = det.cmd; facts.verifyLabel = det.label }
  } catch {}

  cache.set(dir, { facts, ts: nowMs })
  return facts
}

export const FabulaContext: Plugin = async (input: any) => {
    if (!isEnabled("context")) return {};
  const dir = input?.directory || process.cwd()
  return {
    "experimental.chat.system.transform": async (_i: any, output: any) => {
      if (!output || !Array.isArray(output.system)) return
      try {
        const facts = await gather(dir, Date.now())
        const block = formatProjectContext(facts)
        if (block) output.system.push(block)
      } catch { /* never break a turn over context posture */ }
      // Coding belt reconciliation: when the coding profile masks non-coding tool schemas, tell the
      // model exactly which tools it actually has so it never tries a masked one documented elsewhere.
      if (CODING_PROFILE) {
        try {
          const belt = beltPromptBlock(BELT_ACTIVE, TOOL_META)
          if (belt) output.system.push(
            "[FABULA CODING BELT] Only the tools listed here are available this session; ignore any other tool names mentioned elsewhere.\n" + belt)
        } catch {}
      }
      // Context OS §4.5 — the RESIDENT catalog of tools hidden by the per-session belt (MANDATORY):
      // the model must know the NAMES to attempt-dispatch a masked tool by name. Byte-stable per
      // profile (sorted names only), so within a segment the block never changes — cache-safe.
      try {
        const sid = _i?.sessionID
        if (sid) {
          const cat = catalogBlock(beltChannel().get(sid))
          if (cat) output.system.push(cat)
        }
      } catch {}
      // Inject the curated operating-memory block so the in-app local model SEES the durable house rules.
      // Pushed BEFORE the single-system collapse below → merges into the one system message.
      try {
        const mem = await memoryBlock(Date.now())
        if (mem) output.system.push(mem)
      } catch {}
      // Strict OpenAI-compatible gateways (LiteLLM / some Qwen deployments) reject more than one
      // system message ("System message must be at the beginning"): the engine maps EACH `system` array
      // element to its own system message (llm.ts). Collapse to a SINGLE element here, in place,
      // AFTER the context block is appended — this is the only system.transform that pushes, so one
      // collapse at its end guarantees exactly one system message. No-op when already single.
      try {
        if (Array.isArray(output.system) && output.system.length > 1) {
          const merged = output.system.filter((s: any) => typeof s === "string" && s.length > 0).join("\n\n")
          output.system.splice(0, output.system.length, merged)
        }
      } catch {}
    },
  }
}
