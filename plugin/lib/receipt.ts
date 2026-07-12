// FABULA-LLM-5 — Proof-of-Done receipt (pure logic). Implements the Greenpaper "receipt" contract:
// a completed run mints a machine-readable record of WHAT proved done — model in the socket, the task,
// which gates fired and what each forced, the artifact (diff), the verification that passed, and a
// deterministic replay command. This file is pure and unit-tested; fabula-receipt.ts wires it to hooks.
//
// Provenance rule (shared with the neighbor's policy): a receipt records ONLY observed facts from THIS
// run — never a fabricated log, never an aggregate percentage, never the word "proven"/"100%" as a
// claim. The captured verification output is real tool output and is kept verbatim (tail only). See
// scrubProse() for the guard on FABULA's own generated prose.

import { classifyPath } from "./reprogate"

export type Host = "local" | "cloud" | "unknown"

export interface GateRecord {
  /** protocol gate id — verify | reproduce | comprehension | auto-rewind | loop-guard | second-opinion */
  id: string
  /** one line: what this gate forced during the run */
  forced: string
}

export interface ReceiptModel {
  id: string
  host: Host
}

export interface ReceiptVerification {
  cmd: string
  label?: string
  exitCode: number | null
  passed: boolean
  outputTail: string
  /** repo-root-relative directory the verify command ran in (absent = the repo root). Replay MUST
   *  re-run the command from this directory — a bare `bun test` recorded in a subproject is a lie
   *  when replayed from the root (measured live 2026-07-16: 2002 unrelated tests ran instead of 12). */
  cwd?: string
}

export interface ReceiptArtifact {
  kind: "git-diff"
  files: number
  bytes: number
  /** relative path of the written patch, if persisted */
  patch?: string
  /** the diff exceeded the capture cap → no patch was recorded → this run is not independently replayable */
  truncated?: boolean
}

export interface ReceiptProvenance {
  /** sha256 of the FULL request prefix (system + wire tool schemas) the model actually ran with */
  bundlePrefixHash: string
  systemHash: string
  toolsHash: string
  toolCount: number
  engineVersion: string
  /** how many prefixes the session published — steps of the run */
  step: number
  /** sha256 of the user-turn INPUT text (frozen at the first step of the turn by the engine) */
  inputHash?: string
  /** sha256 of the serving descriptor (id+arch+quantization+publisher+compat) from the model
   *  server's registry API. Pins WHICH build/quant served the run — NOT a hash of the weights. */
  modelDescriptorHash?: string
  /** the descriptor the hash covers, kept readable for auditors */
  modelDescriptor?: { id: string; arch?: string; quantization?: string; publisher?: string; compatibilityType?: string }
  /** sha256 over the actual weight FILES on disk — present ONLY when the files were really hashed */
  weightsDigest?: { digest: string; files: number; bytes: number }
  /** tool-router decision, when the router was active */
  routerProfile?: string
  routerWatermark?: string
  /** unplanned mid-turn prefix changes during the run; 0 = byte-stability held */
  midTurnBreaks?: number
}

export interface Receipt {
  version: "fabula-receipt/v0"
  mintedAt: number
  model: ReceiptModel
  task: string
  /** git HEAD at mint time — the deterministic base the patch applies to (absent outside a git repo) */
  base?: string
  gates: GateRecord[]
  artifact: ReceiptArtifact
  verification: ReceiptVerification
  /** one command a third party runs to re-verify the artifact deterministically */
  replay: string
  /** context identity (Phase 3): which exact prompt-prefix produced this work. Optional —
   *  pre-provenance receipts and runs where the engine published nothing stay valid. */
  provenance?: ReceiptProvenance
}

/** Per-session accumulator: filled passively across the run, drained into a Receipt on green verify. */
export interface ReceiptState {
  model?: ReceiptModel
  task?: string
  /** gate id -> what it forced (deduped; last write wins) */
  gates: Map<string, string>
  /** distinct files touched by edit tools */
  edits: Set<string>
  /** edit classification (own tracking — hook-order independent; see mint gating below) */
  sourceEdits: Set<string>
  testEdits: Set<string>
}

export function newReceiptState(): ReceiptState {
  return { gates: new Map(), edits: new Set(), sourceEdits: new Set(), testEdits: new Set() }
}

/**
 * True while the run is in the classic green-but-unproven state: source was changed and no test file
 * was touched. The receipt plugin MUST NOT mint here, regardless of plugin hook order — the
 * reproduce-gate may run after us in the same event and only then rewrite the verify text. This is the
 * receipt's own, order-independent view of the same predicate (lib/reprogate.needsRepro).
 */
export function reproPending(state: ReceiptState): boolean {
  const src = state.sourceEdits?.size ?? 0
  const test = state.testEdits?.size ?? 0
  return src > 0 && test === 0
}

// ── host classification ────────────────────────────────────────────────────
const LOCAL_HINTS = ["lmstudio", "lm-studio", "local", "ollama", "llama.cpp", "llamacpp", "localhost", "127.0.0.1", "mlx"]

/** Classify where the weights sat from the providerID/host string. Conservative: unknown, not a guess. */
export function classifyHost(providerID?: string, extra?: string): Host {
  const s = `${providerID || ""} ${extra || ""}`.toLowerCase()
  if (!s.trim()) return "unknown"
  if (LOCAL_HINTS.some((h) => s.includes(h))) return "local"
  // Named cloud vendors seen in configs.
  if (/(openai|anthropic|google|groq|together|fireworks|deepseek|openrouter|azure|bedrock|mistral|xai)/.test(s)) return "cloud"
  return "unknown"
}

// ── gate recording ─────────────────────────────────────────────────────────
/** Map an observed hook marker to a protocol gate + what it forced. Returns null if not a gate signal. */
export function gateFromMarker(marker: string, meta?: any): GateRecord | null {
  switch (marker) {
    case "verify":
      return { id: "verify", forced: "re-ran the project's checks after source edits — only a green run counts as done" }
    case "reproduce":
      return { id: "reproduce", forced: "required a reproducing test before the fix could be called done" }
    case "comprehension":
      return { id: "comprehension", forced: "graded the agent against its own diff before 'done' stood" }
    case "auto-rewind": {
      const n = typeof meta?.autoRewind?.reverted === "number" ? meta.autoRewind.reverted : undefined
      return { id: "auto-rewind", forced: n != null ? `reverted to the last green checkpoint after ${n} red verifies` : "reverted to the last green checkpoint after repeated red verifies" }
    }
    case "loop-guard":
      return { id: "loop-guard", forced: "hard-stopped a repeated no-progress action, forcing a new hypothesis" }
    case "second-opinion":
      return { id: "second-opinion", forced: "pulled a cloud second opinion when the local model was stuck; the local model kept driving" }
    default:
      return null
  }
}

export function recordGate(state: ReceiptState, marker: string, meta?: any): void {
  const g = gateFromMarker(marker, meta)
  if (g) state.gates.set(g.id, g.forced)
}

export function recordEdit(state: ReceiptState, path: string): void {
  if (!path) return
  state.edits.add(path)
  // Tolerate legacy states that predate the classification sets.
  if (!state.sourceEdits) state.sourceEdits = new Set()
  if (!state.testEdits) state.testEdits = new Set()
  const kind = classifyPath(path)
  if (kind === "test") state.testEdits.add(path)
  else if (kind === "source") state.sourceEdits.add(path)
}

export function recordModel(state: ReceiptState, m: { providerID?: string; modelID?: string }): void {
  const id = m?.modelID
  if (!id) return
  state.model = { id, host: classifyHost(m?.providerID, id) }
}

export function recordTask(state: ReceiptState, text: string): void {
  const t = (text || "").trim()
  if (t) state.task = t.length > 600 ? t.slice(0, 600) + " …" : t
}

// ── assembly ───────────────────────────────────────────────────────────────
export interface BuildInput {
  state: ReceiptState
  verify: ReceiptVerification
  diff: string
  workdir: string
  mintedAt: number
  patchPath?: string
  /** git HEAD at mint time (deterministic replay base) */
  base?: string
  /** the diff was too large to capture — no patch persisted, run not replayable */
  truncated?: boolean
  /** context identity to stamp into the receipt (metadata; optional) */
  provenance?: ReceiptProvenance
}

/** Assemble the immutable receipt. The verify gate is always present when a verify ran. */
export function buildReceipt(inp: BuildInput): Receipt {
  const { state, verify, diff, workdir, mintedAt, patchPath, base, truncated, provenance } = inp
  // Verify gate is implicit: a receipt only mints on a real verify_done, so it always fired.
  recordGate(state, "verify")
  const gates: GateRecord[] = [...state.gates.entries()].map(([id, forced]) => ({ id, forced }))
  // Stable, protocol order.
  const order = ["verify", "reproduce", "comprehension", "auto-rewind", "loop-guard", "second-opinion"]
  gates.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))

  const files = countDiffFiles(diff)
  return {
    version: "fabula-receipt/v0",
    mintedAt,
    model: state.model ?? { id: "unknown", host: "unknown" },
    task: state.task ?? "(task text unavailable)",
    base,
    gates,
    artifact: { kind: "git-diff", files, bytes: byteLen(diff), patch: patchPath, truncated: truncated || undefined },
    verification: verify,
    replay: buildReplay(workdir, verify.cmd, patchPath, base, mintedAt, verify.cwd),
    ...(provenance ? { provenance } : {}),
  }
}

/**
 * The replay command: re-verify the ARTIFACT, not the run. With a recorded base commit this is fully
 * deterministic — a throwaway worktree at that exact commit, the shipped patch applied, the same
 * verification run. `fabula receipt verify` wraps the same steps.
 */
export function buildReplay(workdir: string, verifyCmd: string, patchPath?: string, base?: string, stamp?: number, cwdRel?: string): string {
  // Portable: run from the receipt's project directory — no machine-specific paths baked in.
  if (base && patchPath) {
    const tmp = `/tmp/fabula-replay-${stamp || "run"}`
    // The verify command re-runs from the SAME repo-root-relative dir it was recorded in — a bare
    // `bun test` minted in a subproject must not sweep the whole worktree on replay.
    const where = cwdRel ? `${tmp}/${cwdRel}` : tmp
    return `git worktree add --detach ${tmp} ${base.slice(0, 12)} && git -C ${tmp} apply "$(pwd)/${patchPath}" && cd ${where} && ${verifyCmd}`
  }
  if (patchPath) return `git apply ${patchPath} && ${verifyCmd}`
  // No patch was recorded (diff too large to capture) — do NOT pretend a "recorded diff" exists to
  // apply. This run is NOT independently replayable; say so honestly.
  return `# not replayable: the diff exceeded the capture cap, so no patch was recorded with this receipt`
}

export function countDiffFiles(diff: string): number {
  if (!diff) return 0
  const m = diff.match(/^diff --git /gm)
  if (m) return m.length
  // fallback: count +++ b/ headers
  const m2 = diff.match(/^\+\+\+ /gm)
  return m2 ? m2.length : 0
}

function byteLen(s: string): number {
  try { return Buffer.byteLength(s, "utf8") } catch { return s.length }
}

function shorten(p: string): string {
  const home = (() => { try { return process.env.HOME || "" } catch { return "" } })()
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p
}

// ── rendering ──────────────────────────────────────────────────────────────
/**
 * Scrub FABULA's OWN generated prose of unearned absolutes. Does NOT touch captured tool output
 * (that is real evidence). Keeps the artifact honest per the provenance rule.
 */
export function scrubProse(s: string): string {
  return (s || "")
    .replace(/\b100\s?%/g, "the check")
    .replace(/\bproven\b/gi, "verified")
    .replace(/\bguarantee(d|s)?\b/gi, "checked")
}

const HOST_LABEL: Record<Host, string> = { local: "local", cloud: "cloud", unknown: "host unknown" }

export function renderReceiptMarkdown(r: Receipt): string {
  const when = r.mintedAt ? new Date(r.mintedAt).toISOString() : "(time unavailable)"
  const verdict = r.verification.passed ? "VERIFIED" : "NOT DONE"
  const lines: string[] = []
  lines.push(`# FABULA receipt — ${verdict}`)
  lines.push("")
  lines.push(`> Done is a proof, not a feeling. This receipt records what proved this run done — replay it to re-verify.`)
  lines.push("")
  lines.push(`- **minted:** ${when}`)
  lines.push(`- **model:** \`${r.model.id}\` (${HOST_LABEL[r.model.host]})`)
  lines.push(`- **task:** ${scrubProse(oneLine(r.task))}`)
  if (r.base) lines.push(`- **base:** \`${r.base.slice(0, 12)}\` (the commit the patch applies to)`)
  lines.push("")
  lines.push(`## Gates that fired`)
  for (const g of r.gates) lines.push(`- **${g.id}** — ${g.forced}`)
  lines.push("")
  lines.push(`## Artifact`)
  lines.push(`- git diff · ${r.artifact.files} file(s) · ${r.artifact.bytes} bytes${r.artifact.patch ? ` · \`${r.artifact.patch}\`` : ""}`)
  if (r.artifact.truncated) lines.push(`- ⚠️ the diff exceeded the capture cap — **no patch was recorded, so this run is not independently replayable.**`)
  lines.push("")
  lines.push(`## Verification`)
  lines.push(`- **command:** \`${r.verification.cmd}\`${r.verification.label ? ` (${r.verification.label})` : ""}`)
  lines.push(`- **exit code:** ${r.verification.exitCode ?? "n/a"} · **passed:** ${r.verification.passed ? "yes" : "no"}`)
  lines.push("")
  lines.push("```")
  lines.push(r.verification.outputTail.trim() || "(no output captured)")
  lines.push("```")
  lines.push("")
  if (r.provenance) {
    lines.push(`## Context provenance`)
    lines.push(`- **prefix:** \`${r.provenance.bundlePrefixHash.slice(0, 16)}\` (system \`${r.provenance.systemHash.slice(0, 8)}\` · tools \`${r.provenance.toolsHash.slice(0, 8)}\` · ${r.provenance.toolCount} tools)`)
    if (r.provenance.inputHash) lines.push(`- **input:** \`${r.provenance.inputHash.slice(0, 16)}\` (sha256 of the user-turn request text)`)
    if (r.provenance.modelDescriptorHash) {
      const d = r.provenance.modelDescriptor
      const detail = d ? ` (${[d.arch, d.quantization, d.publisher].filter(Boolean).join(" · ")})` : ""
      lines.push(`- **model descriptor:** \`${r.provenance.modelDescriptorHash.slice(0, 16)}\`${detail} — serving build/quant, not a weights hash`)
    }
    if (r.provenance.weightsDigest)
      lines.push(
        `- **weights digest:** \`${r.provenance.weightsDigest.digest.slice(0, 16)}\` (${r.provenance.weightsDigest.files} files, ${(r.provenance.weightsDigest.bytes / 1e9).toFixed(2)} GB actually hashed)`,
      )
    if (r.provenance.routerProfile) lines.push(`- **router profile:** ${r.provenance.routerProfile}`)
    lines.push(`- **engine:** ${r.provenance.engineVersion} · **steps:** ${r.provenance.step}`)
    if (typeof r.provenance.midTurnBreaks === "number")
      lines.push(
        r.provenance.midTurnBreaks === 0
          ? `- **byte-stability:** held (0 mid-turn prefix changes)`
          : `- **byte-stability:** ⚠️ ${r.provenance.midTurnBreaks} unplanned mid-turn prefix change(s) — KV-cache breaks`,
      )
    lines.push("")
  }
  lines.push(`## Replay`)
  lines.push("```bash")
  lines.push(r.replay)
  lines.push("```")
  lines.push("")
  lines.push(`— Verified Autonomy · fabula-receipt/${r.version.split("/")[1]}`)
  return lines.join("\n")
}

export function renderReceiptJSON(r: Receipt): string {
  return JSON.stringify(r, null, 2)
}

/** One-line summary of the receipt for a hook steer / log. */
export function receiptSummary(r: Receipt): string {
  const verdict = r.verification.passed ? "VERIFIED ✓" : "NOT DONE"
  return `${verdict} · model ${r.model.id} (${HOST_LABEL[r.model.host]}) · ${r.gates.length} gate(s) · ${r.artifact.files} file(s)`
}

function oneLine(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim()
}
