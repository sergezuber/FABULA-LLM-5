// Wiring test: the REAL FabulaCheckpoint plugin — its before-hook auto-snapshots the target file,
// and restore_checkpoint reverts it. Real git in a temp workspace.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { FabulaCheckpoint } from "../fabula-checkpoint"
import { _wipeStore } from "../lib/checkpoint"

let ws: string, store: string
beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), "fab-ckpt-wire-ws-"))
  store = mkdtempSync(path.join(os.tmpdir(), "fab-ckpt-wire-store-"))
  process.env.FABULA_CHECKPOINT_DIR = store
})
afterEach(() => {
  try { _wipeStore(ws) } catch {}
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
  try { rmSync(store, { recursive: true, force: true }) } catch {}
  delete process.env.FABULA_CHECKPOINT_DIR
})

test("before-hook auto-snapshots a str_replace target; restore_checkpoint reverts it", async () => {
  const hooks = await FabulaCheckpoint({ directory: ws } as any) as any
  const file = path.join(ws, "app.ts")
  writeFileSync(file, "const v = 1\n")

  // the engine is ABOUT to run str_replace on app.ts → before-hook snapshots the pre-edit content
  await hooks["tool.execute.before"]({ tool: "str_replace", sessionID: "s", callID: "c" }, { args: { path: "app.ts" } })

  // the edit happens (simulated)
  writeFileSync(file, "const v = 999\n")
  expect(readFileSync(file, "utf8")).toBe("const v = 999\n")

  // list shows the checkpoint
  const list = await hooks.tool.list_checkpoints.execute({})
  expect(list).toContain("app.ts")
  const id = list.split("\n").find((l: string) => l.includes("app.ts"))!.trim().split(/\s+/)[0]

  // restore reverts
  const res = await hooks.tool.restore_checkpoint.execute({ id })
  expect(res).toContain("restored")
  expect(readFileSync(file, "utf8")).toBe("const v = 1\n")
})

test("before-hook ignores read tools (no checkpoint for view)", async () => {
  const hooks = await FabulaCheckpoint({ directory: ws } as any) as any
  writeFileSync(path.join(ws, "a.txt"), "x")
  await hooks["tool.execute.before"]({ tool: "view", sessionID: "s", callID: "c" }, { args: { path: "a.txt" } })
  const list = await hooks.tool.list_checkpoints.execute({})
  expect(list).toContain("No checkpoints yet")
})

test("before-hook never throws even on a bad path (best-effort)", async () => {
  const hooks = await FabulaCheckpoint({ directory: ws } as any) as any
  // path outside the workspace → skipped, no throw
  await expect(hooks["tool.execute.before"]({ tool: "create_file", sessionID: "s", callID: "c" }, { args: { path: "/etc/hosts" } })).resolves.toBeUndefined()
  const list = await hooks.tool.list_checkpoints.execute({})
  expect(list).toContain("No checkpoints yet") // nothing captured for the out-of-tree path
})
