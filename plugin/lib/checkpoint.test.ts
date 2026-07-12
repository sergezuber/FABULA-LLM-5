// Unit tests for shadow-git checkpoint/undo (lib/checkpoint.ts). Real git in temp dirs.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { snapshot, restore, listCheckpoints, diffCheckpoints, storeFor, _wipeStore } from "./checkpoint"

let ws: string
let store: string
let n = 0
const id = () => `t${Date.now?.() ?? 0}_${++n}` // ids just need to be unique within a test

beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), "fab-ckpt-ws-"))
  store = mkdtempSync(path.join(os.tmpdir(), "fab-ckpt-store-"))
  process.env.FABULA_CHECKPOINT_DIR = store
})
afterEach(() => {
  try { _wipeStore(ws) } catch {}
  try { rmSync(ws, { recursive: true, force: true }) } catch {}
  try { rmSync(store, { recursive: true, force: true }) } catch {}
  delete process.env.FABULA_CHECKPOINT_DIR
})

const w = (rel: string, s: string) => { const p = path.join(ws, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, s) }
const r = (rel: string) => readFileSync(path.join(ws, rel), "utf8")

test("snapshot -> modify -> restore reverts content byte-identical", () => {
  w("a.txt", "original\n")
  const cp = snapshot(ws, ["a.txt"], { id: id(), ts: 1, label: "before edit", tool: "str_replace" })!
  expect(cp.commit).toBeTruthy()
  w("a.txt", "CORRUPTED\n")
  expect(r("a.txt")).toBe("CORRUPTED\n")
  const res = restore(ws, cp.id)
  expect(res.restored).toContain("a.txt")
  expect(r("a.txt")).toBe("original\n")
})

test("restore is scoped: an unrelated file edited after the snapshot is NOT reverted", () => {
  w("a.txt", "A0\n"); w("b.txt", "B0\n")
  const cp = snapshot(ws, ["a.txt"], { id: id(), ts: 1 })! // only a.txt captured
  w("a.txt", "A1\n"); w("b.txt", "B1\n")
  restore(ws, cp.id)
  expect(r("a.txt")).toBe("A0\n") // reverted
  expect(r("b.txt")).toBe("B1\n") // untouched (not in checkpoint)
})

test("a file created after the snapshot is removed on restore", () => {
  const cp = snapshot(ws, ["new.txt"], { id: id(), ts: 1 })! // new.txt does not exist yet
  expect(cp.affected[0].existed).toBe(false)
  w("new.txt", "created by the agent\n")
  expect(existsSync(path.join(ws, "new.txt"))).toBe(true)
  const res = restore(ws, cp.id)
  expect(res.deleted).toContain("new.txt")
  expect(existsSync(path.join(ws, "new.txt"))).toBe(false)
})

test("works in a directory with NO .git (non-git project)", () => {
  expect(existsSync(path.join(ws, ".git"))).toBe(false)
  w("code.js", "let x = 1\n")
  const cp = snapshot(ws, ["code.js"], { id: id(), ts: 1 })!
  w("code.js", "let x = 999\n")
  restore(ws, cp.id)
  expect(r("code.js")).toBe("let x = 1\n")
  expect(existsSync(path.join(ws, ".git"))).toBe(false) // we never created a .git in the workspace
})

test("captures a .gitignore'd file (force-add) and can restore it", () => {
  w(".gitignore", "secret.env\n")
  w("secret.env", "KEY=old\n")
  const cp = snapshot(ws, ["secret.env"], { id: id(), ts: 1 })!
  w("secret.env", "KEY=new\n")
  const res = restore(ws, cp.id)
  expect(res.restored).toContain("secret.env")
  expect(r("secret.env")).toBe("KEY=old\n")
})

test("diffCheckpoints shows the change between two checkpoints", () => {
  w("f.txt", "line one\n")
  const c1 = snapshot(ws, ["f.txt"], { id: id(), ts: 1 })!
  w("f.txt", "line two\n")
  const c2 = snapshot(ws, ["f.txt"], { id: id(), ts: 2 })!
  const d = diffCheckpoints(ws, c1.id, c2.id)
  expect(d).toContain("-line one")
  expect(d).toContain("+line two")
})

test("listCheckpoints returns entries with labels + tool, newest appended", () => {
  w("x", "1")
  snapshot(ws, ["x"], { id: id(), ts: 1, label: "first", tool: "create_file" })
  w("x", "2")
  snapshot(ws, ["x"], { id: id(), ts: 2, label: "second", tool: "str_replace" })
  const list = listCheckpoints(ws)
  expect(list.length).toBe(2)
  expect(list[0].label).toBe("first")
  expect(list[1].tool).toBe("str_replace")
})

test("restore of an unknown id is a clean error, not a throw", () => {
  const res = restore(ws, "does-not-exist")
  expect(res.error).toContain("no checkpoint")
})

test("multiple checkpoints chain (parent links) and each restores its own state", () => {
  w("m.txt", "v1\n"); const a = snapshot(ws, ["m.txt"], { id: id(), ts: 1 })!
  w("m.txt", "v2\n"); const b = snapshot(ws, ["m.txt"], { id: id(), ts: 2 })!
  w("m.txt", "v3\n")
  restore(ws, b.id); expect(r("m.txt")).toBe("v2\n")
  restore(ws, a.id); expect(r("m.txt")).toBe("v1\n")
})
