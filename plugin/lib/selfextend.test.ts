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
