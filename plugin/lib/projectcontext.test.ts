import { test, expect } from "bun:test"
import { formatProjectContext, parsePorcelain } from "./projectcontext"

test("clean tree + detected verify", () => {
  const s = formatProjectContext({ cwd: "/p", branch: "main", changed: [], changedTotal: 0, verifyCmd: "npm test", verifyLabel: "package test script" })
  expect(s).toContain("Working directory: /p")
  expect(s).toContain("Git branch: main")
  expect(s).toContain("working tree clean")
  expect(s).toContain("`npm test`")
  expect(s).toContain("verify_done")
})
test("changed files listed + truncation note", () => {
  const many = Array.from({ length: 40 }, (_, i) => ` M file${i}.ts`)
  const s = formatProjectContext({ cwd: "/p", branch: "dev", changed: many.slice(0, 25), changedTotal: 40 })
  expect(s).toContain("40 changed file(s)")
  expect(s).toContain("showing 25")
  expect(s).toContain("file0.ts")
  expect(s).not.toContain("file39.ts")
})
test("no verify command → cautionary note", () => {
  const s = formatProjectContext({ cwd: "/p", verifyCmd: null })
  expect(s).toContain("no test/build command auto-detected")
})
test("non-git dir omits git lines", () => {
  const s = formatProjectContext({ cwd: "/p" })
  expect(s).not.toContain("Git branch")
  expect(s).toContain("Working directory")
})
test("lsp nudge only when the native lsp tool is exposed", () => {
  const withTool = formatProjectContext({ cwd: "/p", lspTool: true })
  expect(withTool).toContain("built-in `lsp` tool")
  expect(withTool).toContain("findReferences")
  expect(withTool).toContain("not the serena tools")
  const without = formatProjectContext({ cwd: "/p" })
  expect(without).not.toContain("built-in `lsp` tool")
})
test("parsePorcelain truncates + counts", () => {
  const p = Array.from({ length: 30 }, (_, i) => ` M f${i}`).join("\n")
  const r = parsePorcelain(p)
  expect(r.total).toBe(30)
  expect(r.lines.length).toBe(25)
})
test("parsePorcelain handles empty", () => {
  expect(parsePorcelain("").total).toBe(0)
  expect(parsePorcelain("\n\n").total).toBe(0)
})
