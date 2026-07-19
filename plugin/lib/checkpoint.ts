// Shadow-git checkpoint / undo (Item 4). Pure git plumbing over a PRIVATE object store that never
// touches the user's real .git, index, HEAD, or reflog.
//
// Mechanism: a dedicated GIT_DIR under ~/.local/share/fabula/checkpoints/<workspace-hash> whose
// work-tree is the workspace and whose index is a private GIT_INDEX_FILE. Before a write-batch we
// force-add (`git add -f`, so even .gitignore'd targets are captured) the target paths, write a tree,
// commit it (synthetic identity), and move a private ref. Restore checks the file content back out of
// that commit (or deletes files that did not exist at snapshot time). Works even in non-git projects.
//
// Safety invariant (enforced by corner-hooks-checkpoint.test.ts): all git metadata lives in the private
// store; the user's repo is only ever WRITTEN to as a plain work tree via checkout-of-paths — its .git,
// index, HEAD and reflog are never read or modified.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const IDENTITY = {
  GIT_AUTHOR_NAME: "FABULA Checkpoint",
  GIT_AUTHOR_EMAIL: "checkpoint@fabula.local",
  GIT_COMMITTER_NAME: "FABULA Checkpoint",
  GIT_COMMITTER_EMAIL: "checkpoint@fabula.local",
  // never let a user's global git config (hooks, gpgsign, templates) affect the shadow store
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
}

const MAX_FULL_SNAPSHOT_FILES = 5000 // guard: skip a whole-tree snapshot on a huge workspace

export interface CheckpointEntry {
  id: string
  commit: string
  ts: number
  label: string
  tool?: string
  affected: { path: string; existed: boolean }[]
  skipped?: string // set when the snapshot was skipped (e.g. too large), with the reason
}

function storeRoot(): string {
  // Lives under the engine data dir (app id "fabula" → ~/.local/share/fabula), consolidated with the
  // rest of the engine's data. FABULA_CHECKPOINT_DIR overrides (hermetic tests). The 225MB of existing
  // per-workspace undo history was migrated from the legacy ~/.local/share/mimocode/checkpoints (2026-07-11).
  return process.env.FABULA_CHECKPOINT_DIR ||
    path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "fabula", "checkpoints")
}

/** Private git dir + ledger path for a workspace. */
export function storeFor(workspace: string): { dir: string; index: string; ledger: string } {
  const hash = createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 16)
  const dir = path.join(storeRoot(), hash, "git")
  return { dir, index: path.join(dir, "fabula-index"), ledger: path.join(storeRoot(), hash, "ledger.json") }
}

function git(args: string[], workspace: string, store: { dir: string; index: string }): string {
  return execFileSync("git", args, {
    env: {
      ...process.env,
      ...IDENTITY,
      GIT_DIR: store.dir,
      GIT_WORK_TREE: path.resolve(workspace),
      GIT_INDEX_FILE: store.index,
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString()
}

function ensureStore(workspace: string) {
  const store = storeFor(workspace)
  if (!existsSync(store.dir)) {
    mkdirSync(store.dir, { recursive: true })
    // init the private object store (GIT_DIR points at it); work-tree is the workspace
    git(["init", "-q"], workspace, store)
  }
  return store
}

function readLedger(ledger: string): CheckpointEntry[] {
  // Defensive: a corrupt ledger.json holding valid non-array JSON ({}, null, …) must not crash the
  // checkpoint tools (entries.push/find downstream) — normalize any non-array to an empty ledger.
  try { const j = JSON.parse(readFileSync(ledger, "utf8")); return Array.isArray(j) ? j : [] } catch { return [] }
}
function writeLedger(ledger: string, entries: CheckpointEntry[]) {
  mkdirSync(path.dirname(ledger), { recursive: true })
  writeFileSync(ledger, JSON.stringify(entries, null, 2))
}

function tipRef(store: { dir: string; index: string }, workspace: string): string | null {
  try { return git(["rev-parse", "--verify", "-q", "refs/fabula/tip"], workspace, store).trim() || null }
  catch { return null }
}

/**
 * Snapshot the current state of `paths` (relative to the workspace) into a new checkpoint.
 * If `paths` is empty/undefined, snapshots the whole work tree (respecting .gitignore, guarded by size).
 * `id` must be supplied by the caller (Date.now/Math.random are unavailable in some sandboxes; the
 * plugin passes a monotonic id). Returns the ledger entry, or null if nothing was captured.
 */
export function snapshot(
  workspace: string,
  paths: string[] | null | undefined,
  opts: { id: string; ts: number; label?: string; tool?: string },
): CheckpointEntry | null {
  const store = ensureStore(workspace)
  const targeted = Array.isArray(paths) && paths.length > 0

  const affected: { path: string; existed: boolean }[] = []
  if (targeted) {
    for (const rel of paths!) {
      const abs = path.resolve(workspace, rel)
      const existed = existsSync(abs)
      affected.push({ path: rel, existed })
      // force-add so even .gitignore'd files are captured; if it doesn't exist yet, stage its removal
      try {
        if (existed) git(["add", "-f", "--", rel], workspace, store)
        else git(["rm", "--cached", "--ignore-unmatch", "-q", "--", rel], workspace, store)
      } catch { /* path not addable (e.g. outside tree) — skip it */ }
    }
  } else {
    // whole-tree snapshot (bash mutations): bounded by file count to avoid huge trees
    let count = 0
    try { count = git(["ls-files", "-o", "-c", "--exclude-standard"], workspace, store).split("\n").filter(Boolean).length }
    catch { count = 0 }
    if (count > MAX_FULL_SNAPSHOT_FILES) {
      const entry: CheckpointEntry = { id: opts.id, commit: "", ts: opts.ts, label: opts.label || "", tool: opts.tool, affected: [], skipped: `workspace too large (${count} files > ${MAX_FULL_SNAPSHOT_FILES}); not checkpointed` }
      const entries = readLedger(store.ledger); entries.push(entry); writeLedger(store.ledger, entries)
      return entry
    }
    try { git(["add", "-A"], workspace, store) } catch { /* nothing to add */ }
  }

  let commit = ""
  try {
    const tree = git(["write-tree"], workspace, store).trim()
    const parent = tipRef(store, workspace)
    const args = ["commit-tree", tree, "-m", opts.label || `checkpoint ${opts.id}`]
    if (parent) { args.push("-p", parent) }
    commit = git(args, workspace, store).trim()
    git(["update-ref", "refs/fabula/tip", commit], workspace, store)
    git(["update-ref", `refs/fabula/ckpt/${opts.id}`, commit], workspace, store)
  } catch (e: any) {
    return null
  }

  const entry: CheckpointEntry = { id: opts.id, commit, ts: opts.ts, label: opts.label || "", tool: opts.tool, affected }
  const entries = readLedger(store.ledger); entries.push(entry); writeLedger(store.ledger, entries)
  return entry
}

export function listCheckpoints(workspace: string): CheckpointEntry[] {
  return readLedger(storeFor(workspace).ledger)
}

/**
 * Restore the workspace to a checkpoint: every path captured in that checkpoint is reverted to its
 * snapshot content; paths that did NOT exist at snapshot time (created afterward) are deleted.
 * Only the checkpoint's affected paths are touched — unrelated files are never modified.
 */
export function restore(workspace: string, id: string): { restored: string[]; deleted: string[]; failed: string[]; treePaths: string[]; error?: string } {
  const store = storeFor(workspace)
  const entries = readLedger(store.ledger)
  const entry = entries.find((e) => e.id === id)
  if (!entry) return { restored: [], deleted: [], failed: [], treePaths: [], error: `no checkpoint "${id}"` }
  if (entry.skipped) return { restored: [], deleted: [], failed: [], treePaths: [], error: `checkpoint "${id}" was skipped: ${entry.skipped}` }
  const restored: string[] = [], deleted: string[] = [], failed: string[] = []
  const affected = entry.affected.length
    ? entry.affected
    // whole-tree snapshot: derive affected paths from the commit's tree
    : git(["ls-tree", "-r", "--name-only", entry.commit], workspace, store).split("\n").filter(Boolean).map((p) => ({ path: p, existed: true }))
  // The set of paths that exist IN the green tree — callers (auto-rewind) must NOT delete these when
  // cleaning up files created during the red streak (a green-era file deleted-then-recreated is here).
  const treePaths = affected.filter((a) => a.existed).map((a) => a.path)
  for (const { path: rel, existed } of affected) {
    const abs = path.resolve(workspace, rel)
    if (existed) {
      // A swallowed checkout failure used to read as success → a caller could claim "files are back"
      // over a workspace nothing moved in. Record failures so callers can tell a real restore apart.
      try { git(["checkout", entry.commit, "--", rel], workspace, store); restored.push(rel) } catch { failed.push(rel) }
    } else {
      try { if (existsSync(abs)) { rmSync(abs); deleted.push(rel) } } catch { failed.push(rel) }
    }
  }
  return { restored, deleted, failed, treePaths }
}

/** Read a file's bytes AS OF a checkpoint commit, from the PRIVATE store (never touches the real .git).
 *  Returns null if the path did not exist at that commit. Used by the reproduce-gate to materialize the
 *  pre-patch tree for a fail-to-pass probe. Buffer (not utf8) so binary source is never corrupted. */
export function readFileAtCommit(workspace: string, commit: string, rel: string): Buffer | null {
  const store = storeFor(workspace)
  try {
    return execFileSync("git", ["show", `${commit}:${rel}`], {
      env: { ...process.env, ...IDENTITY, GIT_DIR: store.dir },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }) as unknown as Buffer
  } catch { return null }
}

/** All paths present in a checkpoint commit's tree (for a whole-tree snapshot whose `affected` is empty).
 *  Read-only, from the private store. */
export function baseTreeFiles(workspace: string, commit: string): string[] {
  const store = storeFor(workspace)
  try {
    return execFileSync("git", ["ls-tree", "-r", "--name-only", commit], {
      env: { ...process.env, ...IDENTITY, GIT_DIR: store.dir },
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    }).split("\n").filter(Boolean)
  } catch { return [] }
}

/** Unified diff between two checkpoints (or a checkpoint and the current work tree if `toId` omitted). */
export function diffCheckpoints(workspace: string, fromId: string, toId?: string): string {
  const store = storeFor(workspace)
  const entries = readLedger(store.ledger)
  const from = entries.find((e) => e.id === fromId)
  if (!from) return `no checkpoint "${fromId}"`
  const to = toId ? entries.find((e) => e.id === toId) : null
  if (toId && !to) return `no checkpoint "${toId}"`
  try {
    if (to) return git(["diff", from.commit, to.commit], workspace, store)
    return git(["diff", from.commit], workspace, store) // vs current work tree
  } catch (e: any) { return `diff error: ${e.message}` }
}

/** Test-only: wipe a workspace's shadow store. */
export function _wipeStore(workspace: string): void {
  try { rmSync(path.dirname(storeFor(workspace).dir), { recursive: true, force: true }) } catch { /* ignore */ }
}
