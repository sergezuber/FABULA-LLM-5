// "Inside the project" must stay false across filesystem ROOTS.
//
// The rule was "the relative path does not climb", and climbing is spelled `..`. Between two roots there
// is no relative path at all, so the platform answers with an ABSOLUTE one — no `..` anywhere — and the
// rule read that as inside. On a filesystem with a single root the case cannot be produced, which is
// exactly why it survived every machine it was tested on.
//
// MEASURED consequence, and it is not cosmetic: with a project on one drive, every path on another read
// as inside it, so nothing was ever external, so the permission that exists to ask before touching
// anything outside the project was never requested. The guard was present and silent. Found by asking a
// failing check what it HAD been asked for, and getting an empty list.
//
// The decision is separated from the platform so it can be checked here, on a machine that has one root.

import { describe, expect, test } from "bun:test"
import * as path from "path"
import { contains, isContainedRelative } from "../../src/util/filesystem"

describe("containment survives a filesystem with more than one root", () => {
  test("an ordinary relative answer is inside", () => {
    expect(isContainedRelative("sub/file.txt")).toBe(true)
    expect(isContainedRelative("")).toBe(true) // a path is inside itself
  })

  test("a climbing answer is outside, in either spelling", () => {
    expect(isContainedRelative("..")).toBe(false)
    expect(isContainedRelative("../x")).toBe(false)
    expect(isContainedRelative("..\\x")).toBe(false)
  })

  test("an ABSOLUTE answer is outside — that is what a second root produces", () => {
    // These are the shapes `path.relative` hands back when the two paths share no root at all.
    expect(isContainedRelative("C:\\Windows")).toBe(false)
    expect(isContainedRelative("D:/data")).toBe(false)
    expect(isContainedRelative("\\\\server\\share")).toBe(false)
    expect(isContainedRelative("/etc")).toBe(false)
  })

  test("the real relative answer between two roots is judged outside", () => {
    // Computed rather than spelled, so this asserts what the platform ACTUALLY produces there.
    expect(isContainedRelative(path.win32.relative("D:\\project", "C:\\Windows"))).toBe(false)
    expect(isContainedRelative(path.win32.relative("C:\\project", "C:\\project\\sub"))).toBe(true)
  })

  test("contains itself still answers the ordinary cases on this machine", () => {
    expect(contains(path.join(path.sep, "a"), path.join(path.sep, "a", "b"))).toBe(true)
    expect(contains(path.join(path.sep, "a"), path.join(path.sep, "b"))).toBe(false)
    expect(contains(path.join(path.sep, "a"), path.join(path.sep, "a"))).toBe(true)
  })
})
