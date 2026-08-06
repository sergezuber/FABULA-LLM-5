import { describe, expect, test } from "bun:test"
import { resolveInWorkspace, makeFileHooks } from "../../src/workflow/workspace"
import { tmpdir } from "os"
import { mkdtempSync } from "fs"
import path from "path"

describe("resolveInWorkspace", () => {
  // The root is an absolute path on the system this runs on, and what comes back is a path to OPEN there,
  // so both are written in that system's dialect. Comparing against a literal with forward slashes made a
  // correct answer read as wrong on the platform that spells them the other way — the escape assertions
  // below, which are what this function is for, were passing all along.
  const WS = path.resolve(path.sep + "ws")

  test("resolves a relative path inside the root", () => {
    expect(resolveInWorkspace(WS, "a/b.txt")).toBe(path.join(WS, "a", "b.txt"))
  })

  test("rejects a parent-traversal escape", () => {
    expect(() => resolveInWorkspace(WS, "../escape")).toThrow(/workspace/)
  })

  test("rejects an absolute path that escapes the root", () => {
    expect(() => resolveInWorkspace(WS, path.resolve(path.sep + "etc", "passwd"))).toThrow(/workspace/)
  })

  test("allows the root itself and nested dirs", () => {
    expect(resolveInWorkspace(WS, ".")).toBe(WS)
    expect(resolveInWorkspace(WS, "deep/nested/x")).toBe(path.join(WS, "deep", "nested", "x"))
  })
})

describe("makeFileHooks read/write/exists", () => {
  test("writeFile then readFile round-trips inside the workspace", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-`)
    const hooks = makeFileHooks(root)
    await hooks.writeFile("out/data.tsv", "a\tb\n")
    expect(await hooks.readFile("out/data.tsv")).toBe("a\tb\n")
  })

  test("readFile of a missing file returns null (not throw)", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-`)
    const hooks = makeFileHooks(root)
    expect(await hooks.readFile("nope.txt")).toBe(null)
  })

  test("exists reflects presence", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-`)
    const hooks = makeFileHooks(root)
    expect(await hooks.exists("x")).toBe(false)
    await hooks.writeFile("x", "1")
    expect(await hooks.exists("x")).toBe(true)
  })

  test("writeFile escaping the workspace throws", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-`)
    const hooks = makeFileHooks(root)
    await expect(hooks.writeFile("../escape", "x")).rejects.toThrow(/workspace/)
  })
})

describe("makeFileHooks glob", () => {
  test("returns workspace-relative matches, lexicographically sorted", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-`)
    const hooks = makeFileHooks(root)
    await hooks.writeFile("src/c.zig", "")
    await hooks.writeFile("src/a.zig", "")
    await hooks.writeFile("src/b.zig", "")
    const r = await hooks.glob("src/*.zig")
    expect(r).toEqual(["src/a.zig", "src/b.zig", "src/c.zig"]) // sorted, relative
  })

  test("empty match set returns []", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-`)
    const hooks = makeFileHooks(root)
    expect(await hooks.glob("nothing/*.x")).toEqual([])
  })

  test("glob cannot escape the workspace via .. or absolute patterns", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-`)
    const hooks = makeFileHooks(root)
    // Create a sibling file OUTSIDE the workspace root.
    const outside = mkdtempSync(`${tmpdir()}/wf-outside-`)
    const { writeFileSync } = await import("fs")
    const pathMod = await import("path")
    writeFileSync(pathMod.join(outside, "secret.txt"), "x")
    // A file INSIDE the workspace (the legitimate match).
    await hooks.writeFile("inside.txt", "y")
    // Parent-traversal and absolute patterns must NOT leak anything outside root.
    expect(await hooks.glob("../wf-outside-*/*")).toEqual([])
    expect(await hooks.glob(`${outside}/*`)).toEqual([])
    expect(await hooks.glob("../*")).toEqual([])
    // A normal in-workspace glob still works.
    expect(await hooks.glob("*.txt")).toEqual(["inside.txt"])
  })
})

// ── The names a script receives are in one dialect, whatever machine ran it ────────────────────────
//
// A workflow script is portable text: it takes these names, hands them back to readFile/writeFile,
// compares and sorts them, and may print them into a report. Handing it the host's separator makes the
// same script sort differently and match differently depending on where it runs.
describe("guest-facing paths", () => {
  test("glob answers in one separator and the answer round-trips", async () => {
    const root = mkdtempSync(`${tmpdir()}/wf-ws-sep-`)
    const hooks = makeFileHooks(root)
    await hooks.writeFile("deep/nested/x.txt", "hi")
    const [only] = await hooks.glob("deep/nested/*.txt")
    expect(only).toBe("deep/nested/x.txt")
    expect(only).not.toContain("\\")
    // …and what it handed back is accepted on the way in, which is what makes one dialect safe to choose.
    expect(await hooks.readFile(only!)).toBe("hi")
    expect(await hooks.exists(only!)).toBe(true)
  })
})
