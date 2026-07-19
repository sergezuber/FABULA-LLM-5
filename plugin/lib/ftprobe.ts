// Fail-to-pass / pass-to-pass PROBE for the reproduce-gate (W1). REAL execution, deterministic given the
// filesystem: it materializes the PRE-PATCH tree from the shadow ledger, runs the model's new test against
// it (a real reproduction must FAIL there) and against the current tree (must PASS), and — for a validated
// repro — re-runs the project's full pre-existing suite (pass-to-pass) so a green-but-regressing patch is
// caught. It NEVER mutates the user's workspace: every probe runs in a throwaway temp copy. It degrades
// HONESTLY (ran:false + a reason) whenever it cannot validate — no base captured, a container-only verify
// env, an unsupported test runner, or any error — so the gate never traps the user (fail-open, model-agnostic).
//
// Core lesson (arXiv:2508.06365 e-Otter++ / 2511.16858 test-overfitting): a green EXISTING suite, and even a
// green NEW test, do not prove a fix — the test must fail on the bug and pass on the patch, and the fix must
// not regress a sibling. The permissive "a test exists" gate in lib/reprogate.ts is the fallback when this
// probe cannot run.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { listCheckpoints, readFileAtCommit, baseTreeFiles } from "./checkpoint"

export interface FtpResult {
  ran: boolean
  reason?: string          // "no base" | "docker-only" | "unsupported runner" | "probe error"
  preExit: number | null   // new test(s) on the PRE-patch tree (max exit across tests; a real repro is non-0)
  postExit: number | null  // new test(s) on the CURRENT tree (must be 0)
}

// Derived/heavy dirs never copied into the probe worktree (node_modules is symlinked back for deps).
const HEAVY = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "target", ".mypy_cache", ".pytest_cache", ".fabula"])

export function sha256File(abs: string): string | null {
  try { return createHash("sha256").update(readFileSync(abs)).digest("hex") } catch { return null }
}

/** The verify env is not runnable on the host (a container-only bench) → we cannot probe host-side. */
export function isDockerOnly(): boolean {
  if (process.env.FABULA_VERIFY_DOCKER_ONLY === "1") return true
  return /\bdocker\b/.test(process.env.FABULA_VERIFY_CMD || "")
}

/** Interpreter for a test file by extension; null = unsupported (→ honest degrade, never a wrong guess). */
export function runnerFor(rel: string): string | null {
  const e = (rel.toLowerCase().split(".").pop() || "")
  if (e === "py") return "python3"
  if (e === "js" || e === "mjs" || e === "cjs") return "node"
  if (e === "ts" || e === "tsx") return "bun"
  return null
}

function runFile(runner: string, file: string, cwd: string): number {
  const r = spawnSync(runner, [file], { cwd, encoding: "utf8", timeout: 120_000 })
  if (r.error) throw r.error
  return r.status ?? 1
}

// The shadow LEDGER — not a parse of the edit command — is the authority on what changed pre→post. This is
// why the probe is robust to EVERY edit path (str_replace / apply_patch / sed -i / tee / heredoc): we never
// need to name the edited file from the shell; the base checkpoint already recorded the pre-patch state.
const MAX_REVERT_FILES = 2000 // guard: don't reconstruct a huge whole-tree base host-side (degrade honestly)

/** The pre-patch BASE: prefer a green/verify-labeled checkpoint (the last-good state), else the earliest
 *  checkpoint (pre-first-edit). `files` are the base's captured paths (its `affected`, or the whole tree for
 *  a whole-tree snapshot). Null when the ledger is empty → honest "no base" degrade. */
export function pickBaseCheckpoint(workspace: string): { commit: string; files: string[] } | null {
  const cps = listCheckpoints(workspace).filter((e) => e && e.commit && !e.skipped)
  if (!cps.length) return null
  const greens = cps.filter((e) => e.tool === "verify_done" || /green|base|good/i.test(e.label || ""))
  const base = greens.length ? greens[greens.length - 1] : cps[0]
  let files = Array.isArray(base.affected) ? base.affected.filter((a) => a.existed).map((a) => a.path) : []
  if (!files.length) files = baseTreeFiles(workspace, base.commit)
  if (!files.length || files.length > MAX_REVERT_FILES) return null
  return { commit: base.commit, files }
}

/** Copy the workspace to a throwaway temp dir (excluding heavy/derived dirs), symlink node_modules for deps,
 *  then revert every file the BASE checkpoint captured to its pre-patch content → a faithful pre-patch
 *  worktree (the current NEW test, absent from the base, is carried over as-is). Returns the temp dir, or
 *  null when no base is recoverable (→ "no base"). Never mutates the user's workspace. */
export function materializePrePatch(workspace: string): string | null {
  const base = pickBaseCheckpoint(workspace)
  if (!base) return null
  const dest = mkdtempSync(path.join(tmpdir(), "w1-pre-"))
  cpSync(workspace, dest, { recursive: true, filter: (src) => !HEAVY.has(path.basename(src)) })
  const nm = path.join(workspace, "node_modules")
  if (existsSync(nm)) { try { symlinkSync(nm, path.join(dest, "node_modules")) } catch { /* deps optional */ } }
  let overlaid = 0
  for (const rel of base.files) {
    const buf = readFileAtCommit(workspace, base.commit, rel)
    if (!buf) continue
    const abs = path.join(dest, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, buf)
    overlaid++
  }
  if (!overlaid) { try { rmSync(dest, { recursive: true, force: true }) } catch {} ; return null }
  return dest
}

/** Run the project's FULL pre-existing suite (FABULA_VERIFY_CMD) on the current tree → pass-to-pass.
 *  null when no verify command is configured (cannot check) or it errored; else true/false on exit code. */
export function siblingSuitePasses(workspace: string): boolean | null {
  const cmd = process.env.FABULA_VERIFY_CMD
  if (!cmd) return null
  const r = spawnSync("bash", ["-c", cmd], { cwd: workspace, encoding: "utf8", timeout: 300_000 })
  if (r.error) return null
  return (r.status ?? 1) === 0
}

/** The fail-to-pass probe: materialize the pre-patch tree, run the model's new test(s) there (preExit) and on
 *  the current tree (postExit). Honest degrade on any obstruction. `newTests` are the added/edited test files. */
export function failToPassProbe(workspace: string | undefined, newTests: string[]): FtpResult {
  const none: FtpResult = { ran: false, preExit: null, postExit: null }
  if (!workspace) return { ...none, reason: "no base" }
  if (isDockerOnly()) return { ...none, reason: "docker-only" }
  if (!newTests.length || newTests.some((t) => runnerFor(t) === null)) return { ...none, reason: "unsupported runner" }
  let dest: string | null = null
  try {
    dest = materializePrePatch(workspace)
    if (!dest) return { ...none, reason: "no base" }
    let preExit = 0, postExit = 0
    for (const t of newTests) {
      const runner = runnerFor(t)!
      preExit = Math.max(preExit, runFile(runner, t, dest))        // on the pre-patch tree
      postExit = Math.max(postExit, runFile(runner, t, workspace)) // on the current tree
    }
    return { ran: true, preExit, postExit }
  } catch {
    return { ...none, reason: "probe error" }
  } finally {
    if (dest) { try { rmSync(dest, { recursive: true, force: true }) } catch { /* temp */ } }
  }
}

/** Run the new test(s) on the CURRENT tree only (for the no-source-change / no-change-terminal check). */
export function newTestsPassOnCurrent(workspace: string | undefined, newTests: string[]): boolean {
  if (!workspace || !newTests.length) return false
  try {
    for (const t of newTests) {
      const runner = runnerFor(t)
      if (!runner) return false
      if (runFile(runner, t, workspace) !== 0) return false
    }
    return true
  } catch { return false }
}
