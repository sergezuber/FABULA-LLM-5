import { recheckIdentity, renderIdentity, recheckEnabled } from "./lib/recheck"
// FABULA Proof Registry (§ disrupt #1). Turns a LOCAL Proof-of-Done receipt into something the rest
// of the world can find and re-verify: a content-addressed store keyed by SHA256(patch + verify cmd).
//
//   publish_receipt  — copy the last green run's receipt + patch into the registry store, commit it,
//                      and (if a git remote is set) push. Returns the real public URL, or the local
//                      store path when no remote is configured — never a fabricated link.
//   verify_receipt   — resolve an id / path / URL, replay the artifact in a throwaway git worktree at
//                      the recorded base commit, run the SAME verification command, report VERIFIED /
//                      NOT DONE. Foreign (http) receipts run attacker-controlled shell, so they are
//                      gated behind FABULA_REGISTRY_VERIFY_UNTRUSTED (ideally FABULA_CODE_SANDBOX=docker).
//   search_receipts  — query the store index by task / model / gates.
//
// The registry never invents a verdict; it addresses, stores, finds and re-runs what a green run left.
// Decision logic (ids, parsing, search) is the pure lib/registry.ts; this file is the git/fs/net glue.

import { tool } from "@mimo-ai/plugin"
import type { Plugin } from "@mimo-ai/plugin"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync, execSync } from "node:child_process"
import { gate } from "./lib/manage"
import {
  receiptId,
  receiptStorePath,
  parseReceipt,
  indexEntry,
  searchIndex,
  upsertIndex,
  resolveSource,
  publicUrl,
  type ReceiptV0,
  type IndexEntry,
} from "./lib/registry"

const z = tool.schema

function registryDir(): string {
  return process.env.FABULA_REGISTRY_DIR || path.join(os.homedir(), ".local", "share", "fabula", "registry")
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

// Ensure the registry is an initialized git repo; wire a remote from FABULA_REGISTRY_REMOTE if given.
function ensureStore(): { dir: string; remote: string | undefined } {
  const dir = registryDir()
  fs.mkdirSync(path.join(dir, "proofs"), { recursive: true })
  if (!fs.existsSync(path.join(dir, ".git"))) {
    git(dir, ["init", "-q"])
    git(dir, ["config", "user.email", "registry@fabula.local"])
    git(dir, ["config", "user.name", "fabula-registry"])
  }
  const remote = process.env.FABULA_REGISTRY_REMOTE
  if (remote) {
    try {
      const cur = git(dir, ["remote", "get-url", "origin"])
      if (cur !== remote) git(dir, ["remote", "set-url", "origin", remote])
    } catch {
      git(dir, ["remote", "add", "origin", remote])
    }
  }
  return { dir, remote }
}

function readIndex(dir: string): IndexEntry[] {
  try {
    const raw = fs.readFileSync(path.join(dir, "proofs", "index.json"), "utf8")
    const j = JSON.parse(raw)
    return Array.isArray(j) ? (j as IndexEntry[]) : []
  } catch {
    return []
  }
}

function localReceipt(projectDir: string, arg?: string): { json: string; patch: string } | { error: string } {
  const base = arg && arg.trim() ? path.resolve(projectDir, arg.trim()) : path.join(projectDir, ".fabula", "receipts", "latest.json")
  if (!fs.existsSync(base)) return { error: `no receipt at ${base} — run a green verify first (mint_receipt / verify_done) to produce .fabula/receipts/latest.json` }
  let json: string
  try {
    json = fs.readFileSync(base, "utf8")
  } catch (e) {
    return { error: `could not read ${base}: ${e instanceof Error ? e.message : String(e)}` }
  }
  const parsed = parseReceipt(json)
  if (!parsed.ok) return { error: `receipt at ${base} is invalid: ${parsed.error}` }
  const patchRel = parsed.receipt.artifact?.patch
  if (!patchRel) return { error: "receipt has no artifact patch — nothing to re-verify (was the run truncated?)" }
  const patchAbs = path.resolve(projectDir, patchRel)
  if (!fs.existsSync(patchAbs)) return { error: `patch file missing: ${patchAbs}` }
  return { json, patch: fs.readFileSync(patchAbs, "utf8") }
}

// Deterministic replay: worktree at the recorded base → apply the patch → run the verification cmd.
// cwd = the worktree, so a cmd like `cd "$(git rev-parse --show-toplevel)/demo" && bun test .` resolves.
function replay(repoDir: string, r: ReceiptV0, patch: string): { status: "VERIFIED" | "NOT DONE"; output: string } | { error: string } {
  const cmd = r.verification?.cmd
  if (!cmd) return { error: "receipt has no verification command" }
  const base = r.base
  if (!base) return { error: "receipt has no base commit — cannot replay deterministically" }
  try {
    execFileSync("git", ["-C", repoDir, "cat-file", "-e", `${base}^{commit}`], { stdio: "ignore" })
  } catch {
    return { error: `base commit ${base} is not in this repository — clone the receipt's origin, then verify there` }
  }
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "fabula-replay-"))
  const patchFile = path.join(os.tmpdir(), `fabula-patch-${Date.now()}.diff`)
  try {
    // git apply rejects a patch with no trailing newline as "corrupt" — restore it if a transport
    // (or a trimming tool) dropped it. The patch bytes are otherwise verbatim.
    fs.writeFileSync(patchFile, patch.endsWith("\n") ? patch : patch + "\n", "utf8")
    git(repoDir, ["worktree", "add", "--detach", "-q", wt, base])
    try {
      git(wt, ["apply", "--whitespace=nowarn", patchFile])
    } catch (e) {
      return { error: `patch did not apply cleanly at ${base}: ${e instanceof Error ? e.message : String(e)}` }
    }
    const timeoutMs = Math.max(10000, parseInt(process.env.FABULA_REGISTRY_VERIFY_TIMEOUT_MS || "180000", 10) || 180000)
    try {
      const out = execSync(cmd, { cwd: wt, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] })
      return { status: "VERIFIED", output: out.slice(-1500) }
    } catch (e: any) {
      const out = `${e?.stdout || ""}${e?.stderr || ""}`.slice(-1500)
      return { status: "NOT DONE", output: out || (e?.message ?? "verification command failed") }
    }
  } finally {
    try { git(repoDir, ["worktree", "remove", "--force", wt]) } catch {}
    try { fs.rmSync(wt, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(patchFile, { force: true }) } catch {}
  }
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctl.signal } as any)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()
  } finally {
    clearTimeout(t)
  }
}

export const FabulaRegistry: Plugin = async (input: any) => {
  const projectDir: string = input?.directory || process.cwd()
  return gate("registry", {
    tool: {
      publish_receipt: tool({
        description:
          "Publish this project's latest Proof-of-Done receipt to the FABULA registry so anyone can re-verify it. " +
          "Content-addressed by SHA256(patch + verification command). Returns a public URL when a git remote is " +
          "configured (FABULA_REGISTRY_REMOTE), otherwise the local store path. Run this after a green verify.",
        args: {
          receipt: z.string().nullish().describe("Optional path to a receipt.json (defaults to .fabula/receipts/latest.json)."),
        },
        async execute(args: any) {
          const got = localReceipt(projectDir, args?.receipt)
          if ("error" in got) return `publish_receipt: ${got.error}`
          const parsed = parseReceipt(got.json)
          if (!parsed.ok) return `publish_receipt: ${parsed.error}`
          const r = parsed.receipt
          const id = receiptId(got.patch, r.verification!.cmd!)
          try {
            const { dir, remote } = ensureStore()
            const rel = receiptStorePath(id)
            const abs = path.join(dir, rel)
            fs.mkdirSync(abs, { recursive: true })
            fs.writeFileSync(path.join(abs, "receipt.json"), got.json, "utf8")
            fs.writeFileSync(path.join(abs, "patch.diff"), got.patch, "utf8")
            fs.writeFileSync(path.join(abs, "verify.sh"), `#!/usr/bin/env bash\nset -e\n${r.verification!.cmd}\n`, "utf8")
            fs.writeFileSync(path.join(dir, "proofs", "index.json"), JSON.stringify(upsertIndex(readIndex(dir), indexEntry(id, r)), null, 2), "utf8")
            git(dir, ["add", "-A"])
            try { git(dir, ["commit", "-q", "-m", `receipt ${id.slice(0, 12)} — ${indexEntry(id, r).task.slice(0, 60)}`]) } catch {}
            let pushed = false
            if (remote) {
              try { git(dir, ["push", "-q", "origin", "HEAD:main"]); pushed = true } catch {}
            }
            const url = publicUrl(remote, id)
            return (
              `✅ published — receipt ${id.slice(0, 16)}…\n` +
              (url ? `Public URL: ${url}${pushed ? "" : " (commit ready — push failed or pending; check the remote)"}\n` : `Local store: ${abs}\n`) +
              (url ? "" : "No remote configured — set FABULA_REGISTRY_REMOTE=<git url> to publish publicly.\n") +
              `Re-verify anywhere: fabula receipt verify (or verify_receipt ${id.slice(0, 16)}…)`
            )
          } catch (e) {
            return `publish_receipt: registry write failed — ${e instanceof Error ? e.message : String(e)}`
          }
        },
      }),

      verify_receipt: tool({
        description:
          "Independently re-verify a receipt by id (from the local registry), a file path, or an http(s) URL. " +
          "Replays the artifact in a throwaway git worktree at the recorded base commit and runs its verification " +
          "command, reporting VERIFIED or NOT DONE. Verifying an untrusted http receipt runs its shell command — " +
          "that requires FABULA_REGISTRY_VERIFY_UNTRUSTED=1 (ideally with FABULA_CODE_SANDBOX=docker).",
        args: {
          source: z.string().describe("Receipt id (64-hex), a receipt.json path, or an http(s) URL."),
        },
        async execute(args: any) {
          const src = resolveSource(String(args?.source || ""))
          let json: string
          let trusted = true
          try {
            if (src.kind === "id") {
              const abs = path.join(registryDir(), receiptStorePath(src.id))
              json = fs.readFileSync(path.join(abs, "receipt.json"), "utf8")
            } else if (src.kind === "file") {
              json = fs.readFileSync(src.path, "utf8")
            } else {
              trusted = false
              if (process.env.FABULA_REGISTRY_VERIFY_UNTRUSTED !== "1")
                return `verify_receipt: refusing to run an untrusted receipt's shell command from ${src.url}. Set FABULA_REGISTRY_VERIFY_UNTRUSTED=1 to allow (ideally with FABULA_CODE_SANDBOX=docker), or inspect it first.`
              json = await fetchText(src.url, 20000)
            }
          } catch (e) {
            return `verify_receipt: could not load receipt — ${e instanceof Error ? e.message : String(e)}`
          }
          const parsed = parseReceipt(json)
          if (!parsed.ok) return `verify_receipt: ${parsed.error}`
          const r = parsed.receipt
          // Patch: sibling patch.diff for id sources; otherwise the receipt must be replayable from this repo.
          let patch: string | null = null
          if (src.kind === "id") {
            try { patch = fs.readFileSync(path.join(registryDir(), receiptStorePath(src.id), "patch.diff"), "utf8") } catch {}
          } else if (src.kind === "file") {
            const sib = path.join(path.dirname(src.path), "patch.diff")
            if (fs.existsSync(sib)) patch = fs.readFileSync(sib, "utf8")
            else if (r.artifact?.patch) { const p = path.resolve(path.dirname(src.path), "..", "..", "..", r.artifact.patch); if (fs.existsSync(p)) patch = fs.readFileSync(p, "utf8") }
          }
          if (patch == null) return `verify_receipt: found the receipt but not its patch (need a sibling patch.diff). id=${receiptId("", r.verification!.cmd!).slice(0, 8)}…`
          const res = replay(projectDir, r, patch)
          if ("error" in res) return `verify_receipt: cannot replay — ${res.error}`
          // ── RECOMPUTE the identity, do not echo it ────────────────────────────────────────────
          // The work above is genuinely re-run. Until W8 the identity beside it was printed straight out
          // of the very JSON this command exists to check — so the expensive claim was verified and the
          // cheap, trivially forged one was repeated back in the same breath, with nothing in the output
          // telling them apart. Every identity claim now lands in exactly one of three states, named.
          //
          // A contradiction fails the IDENTITY, never the WORK: recomputing a descriptor proves what is
          // being served NOW on THIS machine, so a verifier elsewhere can only ever say "not checkable
          // here". Failing someone's proof because this box serves a different quantisation would be
          // this command committing the exact overclaim it was built to remove.
          // Same switch, read plainly on this surface too — `FABULA_RECHECK=0` restores the pre-W8
          // output of this command byte-for-byte.
          const w8 = String(process.env.FABULA_RECHECK ?? "1").trim() !== "0" && recheckEnabled()
          const identity = w8 ? await recheckIdentity(r) : { claims: [], reVerified: 0, notCheckable: 0, contradicted: 0, ok: true, summary: "" }
          // The header must not OPEN with a verified verdict when an identity claim was contradicted: a
          // reader skims the first line, and "VERIFIED" anywhere in it is what they take away. The work
          // result is still reported — on its own line, unchanged — because the tests did pass and saying
          // otherwise would be the mirror overclaim.
          const head =
            identity.contradicted > 0
              ? "❌ IDENTITY MISMATCH — the recomputed identity does not match this receipt"
              : res.status === "VERIFIED"
                ? "✅ VERIFIED"
                : "❌ NOT DONE"
          const workLine =
            identity.contradicted > 0
              ? `\nwork: the patch replayed and the recorded command ${res.status === "VERIFIED" ? "PASSED" : "FAILED"} — the contradiction above is about WHO/WHAT produced it, not about the tests`
              : ""
          const prov = (r as { provenance?: { bundlePrefixHash?: string; routerProfile?: string; midTurnBreaks?: number } }).provenance
          const provLine = prov?.bundlePrefixHash
            ? `\ncontext: prefix ${prov.bundlePrefixHash.slice(0, 16)}${prov.routerProfile ? ` · profile ${prov.routerProfile}` : ""}${typeof prov.midTurnBreaks === "number" ? ` · byte-stability ${prov.midTurnBreaks === 0 ? "held" : `BROKEN ×${prov.midTurnBreaks}`}` : ""}`
            : ""
          const idLine = w8 ? renderIdentity(identity) : ""
          const gateLine = !w8
            ? ""
            : (r as any).gateProof
            ? `\ngate: ${(r as any).gateProof.reason}`
            : `\ngate: NO reproduce-probe verdict recorded in this receipt — it cannot say whether the probe ran (absence is not a pass)`
          return `${head} — ${r.model?.id || "?"} (${r.model?.host || "?"})${trusted ? "" : " · untrusted source"}\ntask: ${(r.task || "").slice(0, 120)}\ncmd: ${r.verification!.cmd}${provLine}${workLine}${gateLine}${idLine ? `\n\n${idLine}` : ""}\n\n${res.output}`
        },
      }),

      search_receipts: tool({
        description:
          "Search the local FABULA proof registry — find which model proved which task. Query matches task/model/gates.",
        args: {
          query: z.string().nullish().describe("Free text, e.g. 'swe-bench python' or 'export bug'."),
          model: z.string().nullish().describe("Filter by model id substring."),
          limit: z.number().nullish().describe("Max results (default 10)."),
        },
        async execute(args: any) {
          const entries = readIndex(registryDir())
          if (entries.length === 0) return "search_receipts: the registry is empty — publish_receipt first."
          const hits = searchIndex(entries, String(args?.query || ""), {
            model: args?.model ? String(args.model) : undefined,
            limit: typeof args?.limit === "number" ? args.limit : 10,
          })
          if (hits.length === 0) return "search_receipts: no matches."
          return hits
            .map((e) => `• ${e.passed ? "✅" : "○"} ${e.id.slice(0, 12)}… — ${e.model} (${e.host}) · gates:[${e.gates.join(",")}]\n  ${e.task}`)
            .join("\n")
        },
      }),
    },
  })
}
