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

// ── Canonicalisation must not depend on whether the last component EXISTS ──────────────────────────
//
// `realpathSync.native` answers only about a path that is there. The fallback for anything else was the
// merely-resolved string, so a directory and a file inside it came back in DIFFERENT spellings the moment
// the directory existed and the file did not — and every guard that compares "is this inside that" then
// compared two spellings of one place. On POSIX the function is the identity and these hold trivially;
// on a filesystem with short names or case-insensitive components they are the whole point.
describe("a path answers the same whether or not its leaf exists yet", () => {
  test("an existing directory and a not-yet-created file inside it share one prefix", () => {
    const dir = Global.Path.data
    const notYet = path.join(dir, "no-such-file-" + process.pid + ".md")
    const canonicalDir = AppFileSystem.normalizePath(dir)
    expect(AppFileSystem.normalizePath(notYet).startsWith(canonicalDir)).toBe(true)
    expect(AppFileSystem.contains(canonicalDir, AppFileSystem.normalizePath(notYet))).toBe(true)
  })

  test("depth does not change the answer — several missing components still hang off the same root", () => {
    const deep = path.join(Global.Path.data, "a" + process.pid, "b", "c.md")
    expect(AppFileSystem.contains(AppFileSystem.normalizePath(Global.Path.data), AppFileSystem.normalizePath(deep))).toBe(
      true,
    )
  })

  test("a path with nothing existing above it is still returned, not lost", () => {
    const nowhere = path.join(path.sep + "no-root-" + process.pid, "x", "y.md")
    expect(AppFileSystem.normalizePath(nowhere).length).toBeGreaterThan(0)
  })
})
