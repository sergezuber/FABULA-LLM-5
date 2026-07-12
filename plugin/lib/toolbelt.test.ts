import { test, expect } from "bun:test"
import { codingMask, maskedTools, activeTools, beltPromptBlock, ALWAYS_ON, type ToolMeta } from "./toolbelt"
import { TOOL_META } from "./toolmeta"

const META: Record<string, ToolMeta> = {
  view: { snippet: "read a file", guidelines: ["read whole files"] },
  str_replace: { snippet: "exact edit", guidelines: ["keep oldText minimal", "read whole files"] },
  verify_done: { snippet: "verify" },
  vision_analyze: { coding: false, snippet: "describe image" },
  browser_click: { coding: false },
}

test("codingMask = only coding:false ids, never ALWAYS_ON", () => {
  const m = codingMask(META)
  expect(m.sort()).toEqual(["browser_click", "vision_analyze"])
  // even if view were marked coding:false it would not be masked (ALWAYS_ON)
  expect(codingMask({ view: { coding: false }, verify_done: { coding: false } })).toEqual([])
})

test("maskedTools drops non-coding in coding profile, nothing in full", () => {
  const all = ["view", "str_replace", "vision_analyze", "browser_click", "verify_done", "some_new_tool"]
  expect(maskedTools(all, META, "coding").sort()).toEqual(["browser_click", "vision_analyze"])
  expect(maskedTools(all, META, "full")).toEqual([])
  // unknown tool (not in META) is NOT masked — deny-list safety
  expect(maskedTools(all, META, "coding")).not.toContain("some_new_tool")
})

test("activeTools preserves order and keeps unknowns", () => {
  const all = ["view", "vision_analyze", "some_new_tool", "browser_click", "str_replace"]
  expect(activeTools(all, META, "coding")).toEqual(["view", "some_new_tool", "str_replace"])
})

test("prompt block lists only active tools with snippets + merged deduped guidelines", () => {
  const block = beltPromptBlock(["view", "str_replace"], META)
  expect(block).toContain("- view: read a file")
  expect(block).toContain("- str_replace: exact edit")
  expect(block).not.toContain("vision_analyze")
  expect(block.match(/read whole files/g)?.length).toBe(1)
})

test("real TOOL_META masks the expected ~24 non-coding tools and keeps coding core", () => {
  const mask = new Set(codingMask(TOOL_META))
  for (const nc of ["browser_navigate", "vision_analyze", "schedule_task", "weather_fetch", "image_search", "places_search", "text_to_speech"])
    expect(mask.has(nc)).toBe(true)
  for (const c of ["view", "str_replace", "bash_tool", "verify_done", "workflow_graph", "web_fetch"])
    expect(mask.has(c)).toBe(false)
  expect(mask.size).toBeGreaterThanOrEqual(20)
})
