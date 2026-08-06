import { test, expect, describe } from "bun:test"
import path from "path"
import { Global } from "@/global"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { memoryRoot } from "@/session/checkpoint-paths"

// ── Both sides of the memory-root comparison must be in ONE spelling ──────────────────────────────
//
// The guards canonicalise the TARGET (`normalizePath` resolves the true case and the long form of every
// component) and then compared it against the root as the data directory happened to be spelled. Where a
// filesystem preserves case without honouring it, or hands out a short 8.3 name, the two never matched:
// a write INSIDE the memory tree read as outside it, and the external-directory permission was raised
// for the harness's own bookkeeping — which in headless mode has nobody to answer it.
describe("the memory root has one spelling, and every comparison uses it", () => {
  test("the root is canonical — normalising it again changes nothing", () => {
    const root = memoryRoot()
    expect(AppFileSystem.normalizePath(root)).toBe(root)
  })

  test("a path built under it is contained, canonicalised or not", () => {
    const target = path.join(Global.Path.data, "memory", "sessions", "ses_x", "progress.md")
    expect(AppFileSystem.contains(memoryRoot(), AppFileSystem.normalizePath(target))).toBe(true)
  })

  test("a sibling of the memory tree is NOT contained", () => {
    const sibling = path.join(Global.Path.data, "memory-notes", "x.md")
    expect(AppFileSystem.contains(memoryRoot(), AppFileSystem.normalizePath(sibling))).toBe(false)
  })

  // The rule may not be rebuilt inline: that is how the two spellings came to exist. A guard that
  // COMPARES must call the one definition.
  test("no guard builds the root by hand next to a containment check", async () => {
    const { Glob } = await import("bun")
    const offenders: string[] = []
    for await (const file of new Glob("src/**/*.ts").scan({ cwd: process.cwd() })) {
      const text = await Bun.file(file).text()
      for (const [i, line] of text.split("\n").entries()) {
        if (/contains\([^)]*Path\.data,\s*["']memory["']/.test(line)) offenders.push(`${file}:${i + 1}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
