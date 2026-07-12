// Real wiring tests: actual view/str_replace/create_file.execute() against the real FS.
import { test, expect, beforeAll } from "bun:test"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { FabulaTools } from "../fabula-tools"

let T: any
const dir = path.join(os.tmpdir(), "fabula-verify-" + process.pid)
const ctx = (sid = "s", d = dir) => ({ sessionID: sid, directory: d, abort: new AbortController().signal } as any)
const out = (r: any) => (typeof r === "string" ? r : r.output)

beforeAll(async () => {
  await fs.mkdir(dir, { recursive: true })
  T = (await FabulaTools({} as any)).tool
})

test("create_file writes + passes byte-readback", async () => {
  const p = path.join(dir, "a.ts")
  const r = await T.create_file.execute({ description: "x", file_text: "hello\nworld\n", path: p }, ctx())
  expect(out(r)).toContain("Created")
  expect(await fs.readFile(p, "utf8")).toBe("hello\nworld\n")
})

test("str_replace exact edit persists (byte-readback ok)", async () => {
  const p = path.join(dir, "b.ts")
  await fs.writeFile(p, "const x = 1\nconst y = 2\n")
  const s = ctx("edit1")
  await T.view.execute({ description: "x", path: p }, s)        // read first
  const r = await T.str_replace.execute({ description: "x", old_str: "const y = 2", new_str: "const y = 42", path: p }, s)
  expect(out(r)).toContain("Edited")
  expect(await fs.readFile(p, "utf8")).toBe("const x = 1\nconst y = 42\n")
})

test("str_replace fuzzy: wrong indentation still applies", async () => {
  const p = path.join(dir, "c.ts")
  await fs.writeFile(p, "function f() {\n    return 7\n}\n")
  const s = ctx("edit2")
  await T.view.execute({ description: "x", path: p }, s)
  const r = await T.str_replace.execute({ description: "x", old_str: "return 7", new_str: "return 8", path: p }, s)
  expect(out(r)).toContain("Edited")
  expect(await fs.readFile(p, "utf8")).toContain("    return 8")
})

test("str_replace rejects escape-drift new_str", async () => {
  const p = path.join(dir, "d.ts")
  await fs.writeFile(p, "X\n")
  const s = ctx("edit3")
  await T.view.execute({ description: "x", path: p }, s)
  const r = await T.str_replace.execute({ description: "x", old_str: "X", new_str: "a\\nb\\nc", path: p }, s)
  expect(out(r)).toContain("escape drift")
  expect(await fs.readFile(p, "utf8")).toBe("X\n") // unchanged
})

test("str_replace warns when editing a never-read file", async () => {
  const p = path.join(dir, "e.ts")
  await fs.writeFile(p, "alpha\n")
  const r = await T.str_replace.execute({ description: "x", old_str: "alpha", new_str: "beta", path: p }, ctx("fresh-session"))
  expect(out(r)).toContain("Edited")
  expect(out(r)).toContain("without having read it")
})

test("str_replace detects external modification since read (stale)", async () => {
  const p = path.join(dir, "f.ts")
  await fs.writeFile(p, "v1\n")
  const s = ctx("edit4")
  await T.view.execute({ description: "x", path: p }, s)          // read at mtime T0
  await fs.writeFile(p, "v1 changed externally\n")               // external change
  await fs.utimes(p, new Date(), new Date(Date.now() + 60000))   // force mtime forward
  const r = await T.str_replace.execute({ description: "x", old_str: "v1", new_str: "v2", path: p }, s)
  expect(out(r)).toContain("changed on disk")
})

test("str_replace ambiguous match is refused (no write)", async () => {
  const p = path.join(dir, "g.ts")
  await fs.writeFile(p, "dup\ndup\n")
  const s = ctx("edit5")
  await T.view.execute({ description: "x", path: p }, s)
  const r = await T.str_replace.execute({ description: "x", old_str: "dup", new_str: "z", path: p }, s)
  expect(out(r)).toContain("must be unique")
  expect(await fs.readFile(p, "utf8")).toBe("dup\ndup\n")
})

// ───────────────────────── 3.3 verify_done (real shell run) ─────────────────────────
test("verify_done: green command → VERIFIED DONE", async () => {
  process.env.FABULA_VERIFY_CMD = "echo PASS_OUTPUT_42 && exit 0"
  const r = await T.verify_done.execute({ description: "task" }, ctx())
  expect(out(r)).toContain("VERIFIED DONE")
  expect(out(r)).toContain("PASS_OUTPUT_42")
  expect((r as any).metadata.passed).toBe(true)
  delete process.env.FABULA_VERIFY_CMD
})
test("verify_done: failing command → NOT DONE (gate holds)", async () => {
  process.env.FABULA_VERIFY_CMD = "echo FAIL_OUTPUT_99 && exit 1"
  const r = await T.verify_done.execute({ description: "task" }, ctx())
  expect(out(r)).toContain("NOT DONE")
  expect(out(r)).toContain("FAIL_OUTPUT_99")
  expect((r as any).metadata.passed).toBe(false)
  delete process.env.FABULA_VERIFY_CMD
})
test("verify_done: no command detected → informative message", async () => {
  const empty = path.join(dir, "emptyproj")
  await fs.mkdir(empty, { recursive: true })
  const r = await T.verify_done.execute({ description: "task" }, ctx("s", empty) as any)
  expect(out(r)).toContain("no verification command detected")
})
