// Integration: real temp git repo → the plugin's system.transform injects accurate project context.
import { test, expect, beforeAll } from "bun:test"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { FabulaContext } from "../fabula-context"

const repo = path.join(os.tmpdir(), "fabula-ctx-" + process.pid)

beforeAll(async () => {
  await fs.mkdir(repo, { recursive: true })
  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" })
  g(["init", "-q"])
  g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"])
  await fs.writeFile(path.join(repo, "README.md"), "# hi\n")
  await fs.writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
  g(["add", "."]); g(["commit", "-qm", "init"])
  await fs.writeFile(path.join(repo, "new.ts"), "x") // uncommitted change
})

test("plugin injects cwd + git branch + verify command; keeps volatile changed-files OUT (cache-stable)", async () => {
  const hooks: any = await FabulaContext({ directory: repo } as any)
  const output = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s" }, output)
  const block = output.system.join("\n")
  expect(block).toContain(`Working directory: ${repo}`)
  expect(block).toMatch(/Git branch: (main|master)/)
  expect(block).toContain("npm test")          // detected from package.json (no bun.lockb → npm)
  expect(block).toContain("verify_done")
  // the uncommitted file must NOT appear — changed-files would bust the model's KV-cache of the
  // static system prefix (they change every edit). Prefix stays byte-stable → cache reused each turn.
  expect(block).not.toContain("new.ts")
  expect(block).not.toMatch(/changed file\(s\)/)
})

test("non-git directory does not crash + still gives context", async () => {
  const plain = path.join(os.tmpdir(), "fabula-plain-" + process.pid)
  await fs.mkdir(plain, { recursive: true })
  const hooks: any = await FabulaContext({ directory: plain } as any)
  const output = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s" }, output)
  const block = output.system.join("\n")
  expect(block).toContain("Working directory")
  expect(block).not.toContain("Git branch")
})
