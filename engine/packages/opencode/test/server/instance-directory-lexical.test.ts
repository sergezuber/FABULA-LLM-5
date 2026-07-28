// The directory predicate must NEVER touch the filesystem for the candidate.
//
// MEASURED 2026-07-28: realpathSync on an iCloud-managed folder (Desktop/…) sleeps in the kernel
// while fileproviderd stalls. This predicate ran per session row in the chat-list and usage routes,
// so one stalled path froze the whole single-threaded engine — every route dead, 0% CPU, no wait
// channel — and the wedge came and went with the stall. "Under $HOME or the cwd" is a question about
// strings; the only canonicalization that matters lexically is the /var → /private/var twin.
import { describe, expect, test, beforeAll, spyOn } from "bun:test"
import * as fs from "node:fs"
import { dirname as pathDirname } from "node:path"
import { instanceDirectoryAllowed } from "../../src/server/routes/instance/middleware"

const HOME = process.env.HOME || "/Users/nobody"

describe("instanceDirectoryAllowed is lexical", () => {
  let rp: ReturnType<typeof spyOn>
  beforeAll(() => {
    instanceDirectoryAllowed(HOME) // prime the cached bases before counting
    rp = spyOn(fs, "realpathSync")
    rp.mockClear()
  })

  test("never calls realpath for a candidate — including one that would stall", () => {
    instanceDirectoryAllowed(HOME + "/Desktop/BOOK-NII-TRED")
    instanceDirectoryAllowed("/private/var/folders/xx/dead-fixture")
    instanceDirectoryAllowed("/Applications/Weird.app")
    expect(rp.mock.calls.length).toBe(0)
  })

  test("home and cwd stay allowed", () => {
    expect(instanceDirectoryAllowed(HOME + "/GitHub/some-project")).toBe(true)
    expect(instanceDirectoryAllowed(process.cwd())).toBe(true)
  })

  test("ancestors of home stay allowed (the picker lists down from /)", () => {
    // Derived from the EFFECTIVE home: the hermetic test env relocates $HOME under /var/folders, so a
    // hardcoded /Users would test the developer's machine, not the rule.
    expect(instanceDirectoryAllowed("/")).toBe(true)
    const resolvedHome = fs.realpathSync(HOME)
    expect(instanceDirectoryAllowed(pathDirname(resolvedHome))).toBe(true)
  })

  test("unrelated roots stay denied", () => {
    expect(instanceDirectoryAllowed("/etc")).toBe(false)
    expect(instanceDirectoryAllowed("/Applications")).toBe(false)
  })

  test("the /var twin is honored by string form, both directions", () => {
    // neither of these exists; the answer must come from strings alone
    const underCwdViaVar = "/var/folders/zz/nonexistent-fixture"
    // /var/... is outside home/cwd either way — but must ANSWER, not stall, and same for its twin
    expect(instanceDirectoryAllowed(underCwdViaVar)).toBe(instanceDirectoryAllowed("/private" + underCwdViaVar))
  })

  test("a relative path is normalized lexically, not resolved on disk", () => {
    expect(instanceDirectoryAllowed(HOME + "/GitHub/../GitHub/x")).toBe(true)
  })
})
