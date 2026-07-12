import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"
import * as path from "node:path"
import { realpathSync } from "node:fs"
import { gitDiffAll } from "./gitdiff"

function repo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fab-gd-")))
  execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: dir })
  writeFileSync(path.join(dir, "tracked.ts"), "export const a = 1\n")
  execSync("git add -A && git -c user.email=t@t -c user.name=t commit -q -m base", { cwd: dir })
  return dir
}

test("gitDiffAll includes BOTH tracked modifications and untracked new files", async () => {
  const dir = repo()
  writeFileSync(path.join(dir, "tracked.ts"), "export const a = 2\n")          // tracked change
  writeFileSync(path.join(dir, "new.test.ts"), "test('boundary', () => {})\n") // UNTRACKED — the repro test
  const diff = await gitDiffAll(dir)
  expect(diff).toContain("tracked.ts")
  expect(diff).toContain("new.test.ts")            // the old `git diff HEAD` would MISS this
  expect(diff).toContain("boundary")
  // the user's real index is untouched: nothing staged
  const staged = execSync("git diff --cached --name-only", { cwd: dir }).toString().trim()
  expect(staged).toBe("")
  rmSync(dir, { recursive: true, force: true })
})

test("gitDiffAll returns empty outside a git repo", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "fab-gd-plain-")))
  writeFileSync(path.join(dir, "x.ts"), "1\n")
  const diff = await gitDiffAll(dir)
  expect(diff).toBe("")
  rmSync(dir, { recursive: true, force: true })
})
