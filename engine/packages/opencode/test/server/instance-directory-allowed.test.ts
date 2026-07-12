import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { instanceDirectoryAllowed } from "../../src/server/routes/instance/middleware"

// The single access predicate shared by the instance middleware (403 gate) and the global
// fabula routes (hide sessions the app can never open). Live case 2026-07-10: CLI test runs
// under /private/tmp left sessions in the DB; the app listed them, tried to bootstrap the
// directory, got 403 and error-toasted on every Home load.
describe("instanceDirectoryAllowed", () => {
  // Same source the predicate reads. The test preload remaps HOME to an isolated tmp dir,
  // so os.homedir() (the REAL home) would disagree with it.
  const home = process.env.HOME!

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
