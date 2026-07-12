// EXHAUSTIVE corner-case tests for hooks:fabula-context (experimental.chat.system.transform).
// Real temp dirs, real `git` subprocess, real fs. We drive the actual plugin hook
// returned by FabulaContext({directory}) and assert the injected system block.
//
// Target: fabula-context.ts  +  lib/projectcontext.ts (formatter).
// Coverage:
//   - git repo (init/commit/uncommitted) → cwd + branch + changed files + detected verify cmd
//   - non-git dir → no git lines, still cwd + cautionary verify note
//   - package.json {scripts.test} → npm test detected (no lockfile)
//   - pyproject.toml → pytest detected
//   - bare dir (no manifest) → cautionary "no test/build command" note
//   - output.system not an array → no crash, no mutation
//   - cache: 2nd call within TTL returns SAME ProjectFacts object (no git re-run)
//   - timeout dir: hook NEVER throws even when git is slow/unhappy
import { test, expect, afterAll } from "bun:test"
import { promises as fs } from "node:fs"
import { mkdtempSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { FabulaContext } from "../fabula-context"
import { formatProjectContext, parsePorcelain } from "../lib/projectcontext"

// ── unique temp dir per call, all cleaned up at the end ───────────────────────
const roots: string[] = []
function tmp(tag = "ctx"): string {
  const d = mkdtempSync(path.join(os.tmpdir(), `fbl-${tag}-${process.pid}-`))
  roots.push(d)
  return d
}
afterAll(async () => {
  for (const d of roots) { try { await fs.rm(d, { recursive: true, force: true }) } catch {} }
})

function gitInit(dir: string) {
  const g = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" })
  g(["init", "-q"])
  g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"])
  g(["config", "commit.gpgsign", "false"])
  return g
}

// Drive the real hook and return the injected system block (joined) + the raw array.
async function runHook(dir: string, system: any = []): Promise<{ block: string; system: any }> {
  const hooks: any = await FabulaContext({ directory: dir } as any)
  const output: any = { system }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s" }, output)
  const block = Array.isArray(output.system) ? output.system.join("\n") : ""
  return { block, system: output.system }
}

// ════════════════════════════════ git repo ════════════════════════════════

test("git repo: block has cwd + branch + detected verify command (NO volatile changed-files)", async () => {
  const repo = tmp("git")
  const g = gitInit(repo)
  await fs.writeFile(path.join(repo, "README.md"), "# hi\n")
  await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "echo hi" } }))
  g(["add", "."]); g(["commit", "-qm", "init"])
  // an uncommitted change — it must NOT leak into the (cache-stable) system block
  await fs.writeFile(path.join(repo, "feature.ts"), "export const x = 1\n")

  const { block } = await runHook(repo)

  expect(block).toContain("[FABULA PROJECT CONTEXT]")
  expect(block).toContain(`Working directory: ${repo}`)
  expect(block).toMatch(/Git branch: (main|master)/)
  // changed-files (git status) are deliberately kept OUT of the system prefix: they change on every
  // edit and any change busts the local model's KV-cache of the static system+tools prefix, forcing a
  // full ~67k-token re-prefill each step (measured 2026-07-06). The prefix must stay byte-stable.
  expect(block).not.toContain("feature.ts")
  expect(block).not.toMatch(/changed file\(s\)/)
  // package.json test script, no bun.lockb / yarn.lock / pnpm-lock → npm test
  expect(block).toContain("npm test")
  expect(block).toContain("package test script")
  expect(block).toContain("verify_done")
  // editing rules always present
  expect(block).toContain("read a file (view) before str_replace")
})

test("git repo: reports branch but no volatile git-status line", async () => {
  const repo = tmp("gitclean")
  const g = gitInit(repo)
  await fs.writeFile(path.join(repo, "a.txt"), "a\n")
  g(["add", "."]); g(["commit", "-qm", "init"])

  const { block } = await runHook(repo)
  expect(block).toMatch(/Git branch: (main|master)/)
  expect(block).not.toContain("Git:")   // no per-turn-volatile status line in the cached prefix
})

test("git repo: changed files are NOT injected even with many changes (prefix stays byte-stable)", async () => {
  const repo = tmp("gitmulti")
  const g = gitInit(repo)
  await fs.writeFile(path.join(repo, "tracked.txt"), "v1\n")
  g(["add", "."]); g(["commit", "-qm", "init"])
  await fs.writeFile(path.join(repo, "tracked.txt"), "v2\n")
  await fs.writeFile(path.join(repo, "untracked1.txt"), "x")
  await fs.writeFile(path.join(repo, "untracked2.txt"), "y")

  const { block } = await runHook(repo)
  expect(block).not.toMatch(/changed file\(s\)/)
  expect(block).not.toContain("untracked1.txt")
  expect(block).not.toContain("untracked2.txt")
})

// ════════════════════════════════ non-git dir ════════════════════════════════

test("non-git directory: no git lines, still cwd + cautionary verify note", async () => {
  const plain = tmp("plain")
  await fs.writeFile(path.join(plain, "notes.txt"), "hello\n")

  const { block } = await runHook(plain)
  expect(block).toContain(`Working directory: ${plain}`)
  expect(block).not.toContain("Git branch")
  expect(block).not.toContain("Git:")
  // no manifest → cautionary note, NOT a verify_done line
  expect(block).toContain("no test/build command auto-detected")
  expect(block).not.toContain("verify_done")
})

// ════════════════════════════════ verify detection ════════════════════════════════

test("package.json with test script → 'npm test' detected (non-git)", async () => {
  const dir = tmp("npm")
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest" } }))

  const { block } = await runHook(dir)
  expect(block).toContain("npm test")
  expect(block).toContain("verify_done")
  expect(block).not.toContain("Git branch") // non-git, so verify works without git
})

test("pyproject.toml → pytest detected", async () => {
  const dir = tmp("py")
  await fs.writeFile(path.join(dir, "pyproject.toml"), "[project]\nname = \"x\"\n")

  const { block } = await runHook(dir)
  expect(block).toContain("python -m pytest -q")
  expect(block).toContain("pytest")
  expect(block).toContain("verify_done")
})

test("bare dir (no manifest) → cautionary note, no verify command", async () => {
  const dir = tmp("bare")
  // truly empty (mkdtemp already created it)
  const { block } = await runHook(dir)
  expect(block).toContain(`Working directory: ${dir}`)
  expect(block).toContain("no test/build command auto-detected")
  expect(block).not.toContain("verify_done")
})

// ════════════════════════════════ output.system shape ════════════════════════════════

test("output.system not an array → no crash, no mutation", async () => {
  const dir = tmp("noarr")
  // Various non-array shapes the harness might hand us.
  for (const bad of [undefined, null, "a string", 42, { not: "array" }]) {
    const hooks: any = await FabulaContext({ directory: dir } as any)
    const output: any = { system: bad }
    // Must NOT throw, and must leave the non-array value untouched.
    let threw = false
    try { await hooks["experimental.chat.system.transform"]({ sessionID: "s" }, output) }
    catch { threw = true }
    expect(threw).toBe(false)
    expect(output.system).toBe(bad)
  }
})

test("missing output object → hook does not throw", async () => {
  const dir = tmp("noout")
  const hooks: any = await FabulaContext({ directory: dir } as any)
  let threw = false
  try {
    await hooks["experimental.chat.system.transform"]({ sessionID: "s" }, undefined)
    await hooks["experimental.chat.system.transform"]({ sessionID: "s" }, null)
  } catch { threw = true }
  expect(threw).toBe(false)
})

// ════════════════════════════════ cache (TTL_MS = 20s) ════════════════════════════════

test("system block is byte-STABLE across working-tree changes (KV-cache friendliness)", async () => {
  const repo = tmp("cache")
  const g = gitInit(repo)
  await fs.writeFile(path.join(repo, "a.txt"), "a\n")
  g(["add", "."]); g(["commit", "-qm", "init"])

  const first = await runHook(repo)

  // Mutate the repo on disk AFTER the first call — the working tree is now dirty.
  await fs.writeFile(path.join(repo, "sneaky.txt"), "added after first call\n")

  const second = await runHook(repo)
  // The injected system block must be IDENTICAL despite the new file: the volatile working set is
  // deliberately kept out of the cached prefix, so the local model's KV-cache stays valid turn-to-turn.
  expect(second.block).not.toContain("sneaky.txt")
  expect(second.block).toBe(first.block)
})

test("cache: distinct directories are cached independently", async () => {
  const a = tmp("cacheA"); const b = tmp("cacheB")
  await fs.writeFile(path.join(a, "pyproject.toml"), "[project]\n")
  await fs.writeFile(path.join(b, "package.json"), JSON.stringify({ scripts: { test: "x" } }))

  const ra = await runHook(a)
  const rb = await runHook(b)
  expect(ra.block).toContain("python -m pytest -q")
  expect(rb.block).toContain("npm test")
  // cross-contamination check
  expect(ra.block).not.toContain("npm test")
  expect(rb.block).not.toContain("pytest")
})

// ════════════════════════════════ timeout / hostile git ════════════════════════════════

test("git that cannot resolve a HEAD (no commits) → no branch, never throws", async () => {
  // Fresh `git init` with NO commits: `rev-parse --abbrev-ref HEAD` fails.
  // The plugin treats empty branch as "not a repo" and must not crash.
  const repo = tmp("nohead")
  gitInit(repo)
  await fs.writeFile(path.join(repo, "x.txt"), "x")

  let threw = false
  let block = ""
  try { block = (await runHook(repo)).block } catch { threw = true }
  expect(threw).toBe(false)
  expect(block).toContain(`Working directory: ${repo}`)
  // No resolvable HEAD → no "Git branch:" line.
  expect(block).not.toContain("Git branch:")
})

test("nonexistent directory → hook never throws", async () => {
  // A directory that doesn't exist: git -C fails, readdir fails. Hook must swallow both.
  const ghost = path.join(os.tmpdir(), `fbl-ghost-${process.pid}-does-not-exist`)
  let threw = false
  let blockType = ""
  try {
    const { block } = await runHook(ghost)
    blockType = typeof block
  } catch { threw = true }
  expect(threw).toBe(false)
  expect(blockType).toBe("string")
})

test("git pointed at a directory whose .git is a dangling file → never throws", async () => {
  // Sabotage: create a bogus `.git` *file* (worktree-style gitlink to nowhere). Real git will
  // error; the plugin must degrade gracefully (no branch line) rather than throw.
  const dir = tmp("baddotgit")
  await fs.writeFile(path.join(dir, ".git"), "gitdir: /no/such/path\n")
  await fs.writeFile(path.join(dir, "pyproject.toml"), "[project]\n")

  let threw = false
  let block = ""
  try { block = (await runHook(dir)).block } catch { threw = true }
  expect(threw).toBe(false)
  // git is broken → no branch, but verify detection (readdir) still works.
  expect(block).not.toContain("Git branch:")
  expect(block).toContain("python -m pytest -q")
})

// ════════════════════════════════ pure formatter sanity ════════════════════════════════
// Belt-and-suspenders: exercise the formatter the hook depends on directly.

test("formatProjectContext: MAX_CHANGED truncation flags 'showing 25'", async () => {
  const changed = Array.from({ length: 40 }, (_, i) => ` M file${i}.ts`)
  const block = formatProjectContext({ cwd: "/x", changed, changedTotal: 40 })
  expect(block).toContain("Git: 40 changed file(s) (showing 25):")
  // exactly 25 file lines rendered
  const fileLines = block.split("\n").filter((l) => /^\s+ M file/.test(l))
  expect(fileLines.length).toBe(25)
})

test("parsePorcelain: caps lines at 25 but reports true total", () => {
  const porc = Array.from({ length: 30 }, (_, i) => `?? f${i}`).join("\n")
  const { lines, total } = parsePorcelain(porc)
  expect(total).toBe(30)
  expect(lines.length).toBe(25)
  // blank/whitespace-only lines are dropped
  const { lines: l2, total: t2 } = parsePorcelain("?? a\n\n   \n M b\n")
  expect(t2).toBe(2)
  expect(l2).toEqual(["?? a", " M b"])
})
