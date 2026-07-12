import { test, expect } from "bun:test"
import { EDIT_TOOLS, editPaths } from "./edittools"
import { WRITE_TOOLS, isWriteTool } from "./roles"

test("every edit tool is also a write tool (read-only agents cannot edit through ANY of them)", () => {
  for (const t of EDIT_TOOLS) expect(WRITE_TOOLS.has(t)).toBe(true)
  expect(isWriteTool("apply_patch")).toBe(true)
  expect(isWriteTool("notebook_edit")).toBe(true)
})

test("editPaths extracts every file from an apply_patch envelope", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/export.ts",
    "@@", "-a", "+b",
    "*** Add File: src/export.test.ts",
    "+test", 
    "*** Delete File: old.ts",
    "*** End Patch",
  ].join("\n")
  const paths = editPaths("apply_patch", { patch_text: patch })
  expect(paths).toEqual(["src/export.ts", "src/export.test.ts", "old.ts"])
})

test("editPaths handles plain path-carrying tools and empty args", () => {
  expect(editPaths("str_replace", { file_path: "a.ts" })).toEqual(["a.ts"])
  expect(editPaths("notebook_edit", { notebook_path: "n.ipynb" })).toEqual(["n.ipynb"])
  expect(editPaths("apply_patch", {})).toEqual([])
  expect(editPaths("str_replace", {})).toEqual([])
})

import { bashEditsTree, bashEditPaths, editUnits, BASH_EDIT_MARKER } from "./edittools"
import { classifyPath } from "./reprogate"

test("bashEditsTree: tree-mutating idioms are detected", () => {
  for (const c of [
    "sed -i 's/a/b/' src/export.ts",
    "sed -i.bak 's/a/b/g' file.py",
    "git apply /tmp/fix.diff",
    "patch -p1 < /tmp/fix.diff",
    "echo 'x' > src/new.ts",
    "cat >> config.py <<'EOF'\nX=1\nEOF",
    "printf 'hi' | tee out.txt",
    "perl -i -pe 's/x/y/' a.rb",
  ]) expect(bashEditsTree(c)).toBe(true)
})

test("bashEditsTree: read-only / non-mutating bash is NOT an edit", () => {
  for (const c of [
    "ls -la", "grep -r foo src/", "python -m pytest -q", "cat file.py",
    "echo hi", "go build ./...", "curl -s localhost:1235/v1/models > /dev/null",
    "cmd 2>&1", "git status", "git diff HEAD",
  ]) expect(bashEditsTree(c)).toBe(false)
})

test("bashEditPaths: extracts redirect/tee/sed-i targets, skips /dev and fds", () => {
  expect(bashEditPaths("echo x > src/a.ts")).toContain("src/a.ts")
  expect(bashEditPaths("printf y | tee build/out.txt")).toContain("build/out.txt")
  expect(bashEditPaths("sed -i 's/a/b/' pkg/mod.go")).toContain("pkg/mod.go")
  expect(bashEditPaths("run 2>&1 >/dev/null")).toEqual([])
})

test("editUnits: bash edits become units; git apply → marker; non-edit bash → []", () => {
  expect(editUnits("bash", { command: "echo x > a.ts" })).toContain("a.ts")
  expect(editUnits("bash_tool", { command: "git apply f.diff" })).toEqual([BASH_EDIT_MARKER])
  expect(editUnits("bash", { command: "ls -la" })).toEqual([])
  expect(editUnits("str_replace", { file_path: "a.ts" })).toEqual(["a.ts"])
})

test("classifyPath maps the bash marker to source (conservative — never ignore a shell patch)", () => {
  expect(classifyPath(BASH_EDIT_MARKER)).toBe("source")
})
