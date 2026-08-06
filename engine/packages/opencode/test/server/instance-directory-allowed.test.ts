import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { instanceDirectoryAllowed } from "../../src/server/routes/instance/middleware"
import os from "os"

// The single access predicate shared by the instance middleware (403 gate) and the global
// fabula routes (hide sessions the app can never open). Live case 2026-07-10: CLI test runs
// under /private/tmp left sessions in the DB; the app listed them, tried to bootstrap the
// directory, got 403 and error-toasted on every Home load.
describe("instanceDirectoryAllowed", () => {
  // Same source the predicate reads. The test preload remaps HOME to an isolated tmp dir,
  // so os.homedir() (the REAL home) would disagree with it.
  // The same rule the predicate uses: the named HOME when there is one, the platform's answer
  // otherwise. Reading only the variable made this compare against a home the guard never had.
  const home = process.env["HOME"] || os.homedir()

  test("allows directories inside $HOME", () => {
    // Must exist: canonicalization (symlinked /var → /private/var on the isolated test HOME)
    // only applies to real paths, mirroring reality — session directories existed when created.
    const dir = path.join(home, "GitHub", "some-project")
    fs.mkdirSync(dir, { recursive: true })
    expect(instanceDirectoryAllowed(dir)).toBe(true)
  })

  test("allows the cwd subtree", () => {
    expect(instanceDirectoryAllowed(process.cwd())).toBe(true)
    expect(instanceDirectoryAllowed(path.join(process.cwd(), "sub"))).toBe(true)
  })

  test("allows ancestors of $HOME (the picker lists down from /)", () => {
    expect(instanceDirectoryAllowed("/")).toBe(true)
    expect(instanceDirectoryAllowed(path.dirname(home))).toBe(true)
  })

  test("denies /private/tmp scratch dirs (the live-observed garbage)", () => {
    expect(instanceDirectoryAllowed("/private/tmp/claude-501/whatever/scratchpad/localtest")).toBe(false)
    expect(instanceDirectoryAllowed("/tmp/x")).toBe(false)
  })

  test("denies unrelated roots", () => {
    expect(instanceDirectoryAllowed("/etc")).toBe(false)
    expect(instanceDirectoryAllowed("/Applications")).toBe(false)
  })
})

// ── The base is kept in BOTH spellings, because only the base may be canonicalised ─────────────────
//
// The candidate is never resolved — that is what froze the server on an iCloud-managed folder, and it is
// the whole reason this predicate is lexical. So wherever a filesystem has more than one spelling for a
// directory (a short 8.3 name, a differing case), the canonical base and the raw candidate describe the
// same place in different words. MEASURED: a project under the user's own profile answered "not allowed"
// because the base said `runneradmin` and the candidate said `RUNNER~1`.
// STATED LIMIT: on a filesystem with ONE spelling per directory the two forms are identical, so these
// assertions pass whether or not the second spelling is kept — a mutation removing it cannot be killed
// here. The row that exercises it is the one whose filesystem hands out short names.
describe("a base is recognised in the spelling it was given, as well as the canonical one", () => {
  test("the home directory as the environment spells it is allowed", () => {
    const named = process.env["HOME"] || os.homedir()
    expect(instanceDirectoryAllowed(named)).toBe(true)
    expect(instanceDirectoryAllowed(path.join(named, "some-project"))).toBe(true)
  })

  test("the launch directory as the process spells it is allowed", () => {
    expect(instanceDirectoryAllowed(process.cwd())).toBe(true)
    expect(instanceDirectoryAllowed(path.join(process.cwd(), "nested", "dir"))).toBe(true)
  })

  test("and an unrelated place is still refused — the extra spellings widen nothing", () => {
    const away = path.resolve(path.sep + "definitely-not-here-" + process.pid)
    expect(instanceDirectoryAllowed(away)).toBe(false)
  })
})

// ── A filesystem root is listable, in every spelling a root has ────────────────────────────────────
//
// The picker walks down from the top, and on a machine with more than one root there is no single top:
// "/" resolves to the root of the CURRENT one, which does not contain a home living on another. The
// ancestor chain the picker needs simply ended there. This permits LISTING, never opening — a root as a
// project directory is refused outright by the guard that decides whether work may happen.
// STATED LIMIT: where there is exactly ONE root, the ancestor chain already reaches it and these pass
// whether or not the rule exists — a mutation removing it cannot be killed here. The machine with more
// than one root is the instrument.
describe("a filesystem root is a navigation step, not a project", () => {
  test("every spelling of a root is listable", () => {
    expect(instanceDirectoryAllowed(path.parse(process.cwd()).root)).toBe(true)
    expect(instanceDirectoryAllowed(path.parse(os.homedir()).root)).toBe(true)
  })

  test("and opening one as a project is still refused, by the guard whose job that is", async () => {
    const { Instance } = await import("../../src/project/instance")
    await expect(
      Instance.provide({ directory: path.parse(process.cwd()).root, fn: () => {} }),
    ).rejects.toThrow("Access denied")
  })
})
