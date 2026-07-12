// CRITICAL safety test: the shadow-git checkpoint store must NEVER touch the user's real .git —
// not HEAD, not the index, not refs, not the reflog. Real git repo in a temp dir.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { snapshot, restore, _wipeStore } from "../lib/checkpoint"

let ws: string, store: string, n = 0
// The hermetic preload sets FABULA_CHECKPOINT_DIR to an isolated temp dir; restore it after each test
// (instead of deleting) so later test files keep the isolation and never write to the real data dir.
const PRELOAD_CKPT = process.env.FABULA_CHECKPOINT_DIR
const id = () => `s${++n}`
const g = (args: string[]) => execFileSync("git", args, { cwd: ws, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).toString()

beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), "fab-ckpt-realgit-"))
  store = mkdtempSync(path.join(os.tmpdir(), "fab-ckpt-store-"))
  process.env.FABULA_CHECKPOINT_DIR = store
  // a real user repo with one commit
  g(["init", "-q"]); g(["config", "user.email", "u@example.com"]); g(["config", "user.name", "User"])
  writeFileSync(path.join(ws, "app.js"), "let x = 1\n")
  g(["add", "app.js"]); g(["commit", "-q", "-m", "initial"])
})
afterEach(() => {
  try { _wipeStore(ws) } catch {}
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
  try { rmSync(store, { recursive: true, force: true }) } catch {}
  if (PRELOAD_CKPT) process.env.FABULA_CHECKPOINT_DIR = PRELOAD_CKPT
  else delete process.env.FABULA_CHECKPOINT_DIR
})

test("snapshot + restore never mutates the user's real .git (HEAD, index, refs, reflog)", () => {
  const headBefore = g(["rev-parse", "HEAD"]).trim()
  const statusBefore = g(["status", "--porcelain"]).trim()
  const reflogBefore = g(["reflog"]).trim()
  const branchBefore = g(["branch", "--show-current"]).trim()
  const indexBefore = g(["ls-files", "-s"]).trim()

  // the agent edits app.js: snapshot its pre-edit state, then "corrupt" it, then restore
  snapshot(ws, ["app.js"], { id: id(), ts: 1, label: "before edit", tool: "str_replace" })
  writeFileSync(path.join(ws, "app.js"), "let x = 9999\n")
  const res = restore(ws, "s1")
  expect(res.restored).toContain("app.js")
  expect(readFileSync(path.join(ws, "app.js"), "utf8")).toBe("let x = 1\n")

  // the real repo must be byte-identical in every metadata dimension
  expect(g(["rev-parse", "HEAD"]).trim()).toBe(headBefore)
  expect(g(["reflog"]).trim()).toBe(reflogBefore)      // no new reflog entries
  expect(g(["branch", "--show-current"]).trim()).toBe(branchBefore)
  expect(g(["ls-files", "-s"]).trim()).toBe(indexBefore) // the user's index is untouched
  // working tree is back to clean (matches the committed content) → status still clean
  expect(g(["status", "--porcelain"]).trim()).toBe(statusBefore)
})

test("the shadow store lives entirely outside the workspace .git", () => {
  snapshot(ws, ["app.js"], { id: id(), ts: 1 })
  // no fabula refs leaked into the real repo
  const refs = g(["for-each-ref", "--format=%(refname)"])
  expect(refs).not.toContain("refs/fabula")
  // the private store dir exists and holds the objects, separate from ws/.git
  expect(existsSync(store)).toBe(true)
  expect(readFileSync(path.join(ws, ".git", "HEAD"), "utf8")).toContain("refs/heads")
})
