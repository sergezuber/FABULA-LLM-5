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
import { AppFileSystem } from "@mimo-ai/shared/filesystem"

const { contains, isContainedRelative, isFilesystemRoot } = AppFileSystem

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

// ── A filesystem root is recognised in EVERY spelling it has ───────────────────────────────────────
//
// A project with no version control has its worktree set to the root, which contains every absolute path
// there is — so consulting it would answer "inside the project" for the whole machine. The guard against
// that compared with `"/"`, and a filesystem may have many roots and spell them differently.
//
// MEASURED: on a Windows runner `C:\Windows` came back as inside the project, so the permission that
// exists to ask before touching anything outside was never requested — sixty-seven checks red for one
// root written the other way.
describe("a filesystem root is recognised however it is spelled", () => {
  test("every spelling of a root is one", () => {
    expect(isFilesystemRoot("/")).toBe(true)
    expect(isFilesystemRoot("C:\\")).toBe(true)
    expect(isFilesystemRoot("C:/")).toBe(true)
    expect(isFilesystemRoot("\\\\server\\share\\")).toBe(true)
    expect(isFilesystemRoot("\\\\server\\share")).toBe(true)
  })

  test("an ordinary directory is not a root, however deep or shallow", () => {
    expect(isFilesystemRoot("/task")).toBe(false)
    expect(isFilesystemRoot("C:\\Windows")).toBe(false)
    expect(isFilesystemRoot("D:\\a\\project")).toBe(false)
    expect(isFilesystemRoot("")).toBe(false)
    expect(isFilesystemRoot("relative")).toBe(false)
  })
})

// ── `contains` must ASK the rule, not carry its own opinion ───────────────────────────────────────
//
// The rule and its caller were verified separately, so a caller that had stopped consulting it passed
// every check. The binding needs a case the two answer DIFFERENTLY, and it is not a Windows-only one:
// the older reading asked whether the relative path starts with the two characters "..", so a directory
// genuinely named `..cache` inside the project was reported as outside it — on every platform.
describe("containment delegates to the rule instead of re-deciding", () => {
  test("a directory whose NAME begins with two dots is inside, not outside", () => {
    expect(isContainedRelative("..cache")).toBe(true)
    expect(contains("/project", "/project/..cache")).toBe(true)
    expect(contains("/project", "/project/..cache/notes.md")).toBe(true)
  })

  test("the real parent reference is still outside", () => {
    expect(contains("/project", "/project/../sibling")).toBe(false)
    expect(contains("/project", "/elsewhere")).toBe(false)
  })
})
