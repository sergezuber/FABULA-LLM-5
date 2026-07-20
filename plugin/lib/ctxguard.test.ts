// Pure-core guards for the context-budget guard. The wiring test drives the REAL hook; this file pins the
// decision logic — including the two properties that make it safe to ship default-on: it is INERT below
// the high-water mark (the efficiency contract), and a bulk-read ask is recognised in EN and RU.
import { test, expect } from "bun:test"
import {
  estimateTokens,
  estimateChars,
  nearCeiling,
  isBulkReadAsk,
  decide,
  contextWindow,
  highWater,
  DEFAULT_CONTEXT_WINDOW,
  CONSOLIDATE_MARKER,
  BOUNDED_MARKER,
} from "./ctxguard"

const msg = (role: string, text: string) => ({ info: { role }, parts: [{ type: "text", text }] })

test("estimateChars sums string leaves across messages and parts, skipping id/time noise", () => {
  const messages = [
    { info: { role: "user", id: "should-not-count", time: 123 }, parts: [{ text: "hello" }] },
    { info: { role: "assistant" }, parts: [{ text: "world!!" }, { state: { output: "tool-output-text" } }] },
  ]
  // "hello"(5) + "world!!"(7) + "tool-output-text"(16) = 28; ids/time excluded
  expect(estimateChars(messages)).toBe(28)
})

test("estimateTokens is monotonic in content size", () => {
  const small = [msg("user", "x".repeat(100))]
  const big = [msg("user", "x".repeat(100000))]
  expect(estimateTokens(big)).toBeGreaterThan(estimateTokens(small))
})

test("nearCeiling flips exactly at high-water * window", () => {
  const env = { FABULA_CONTEXT_WINDOW: "1000", FABULA_CTX_HIGH_WATER: "0.75" } as any
  expect(contextWindow(env)).toBe(1000)
  expect(highWater(env)).toBe(0.75)
  expect(nearCeiling(749, env)).toBe(false)
  expect(nearCeiling(750, env)).toBe(true)
})

test("default window matches the loaded serving window", () => {
  expect(contextWindow({} as any)).toBe(DEFAULT_CONTEXT_WINDOW) // 131072 = 128K
})

test("bulk-read ask recognised in EN", () => {
  expect(isBulkReadAsk("read all chapters and give a deep analysis")).toBe(true)
  expect(isBulkReadAsk("please review every file in the repo")).toBe(true)
  expect(isBulkReadAsk("analyze the entire codebase")).toBe(true)
  expect(isBulkReadAsk("go through all the documents")).toBe(true)
})

test("bulk-read ask recognised in RU (the exact crash prompt shape)", () => {
  expect(isBulkReadAsk("прочти все главы и проведи глубочайший анализ")).toBe(true)
  expect(isBulkReadAsk("проанализируй все файлы проекта")).toBe(true)
  expect(isBulkReadAsk("разбери каждую главу книги")).toBe(true)
  expect(isBulkReadAsk("прочитай всю книгу целиком")).toBe(true)
})

test("ordinary asks do NOT read as bulk (no false positive → no efficiency cost)", () => {
  expect(isBulkReadAsk("read the config file at src/config.ts")).toBe(false)
  expect(isBulkReadAsk("fix the failing test in utils")).toBe(false)
  expect(isBulkReadAsk("what does this function do?")).toBe(false)
  expect(isBulkReadAsk("добавь кнопку на главный экран")).toBe(false)
  expect(isBulkReadAsk("")).toBe(false)
})

test("decide: below the ceiling with an ordinary ask → NONE (inert = the efficiency contract)", () => {
  const env = { FABULA_CONTEXT_WINDOW: "131072" } as any
  const d = decide([msg("user", "fix the bug in loader.ts")], "fix the bug in loader.ts", env)
  expect(d.action).toBe("none")
})

test("decide: near the ceiling → CONSOLIDATE, and it wins over a bulk-read ask", () => {
  const env = { FABULA_CONTEXT_WINDOW: "1000", FABULA_CTX_HIGH_WATER: "0.75", FABULA_CTX_CHARS_PER_TOKEN: "1" } as any
  // 4000 chars / 1 char-per-token = 4000 tokens ≫ 750 → consolidate, even though the ask is a bulk read
  const d = decide([msg("user", "read all chapters " + "z".repeat(4000))], "read all chapters", env)
  expect(d.action).toBe("consolidate")
  expect(d.pct).toBeGreaterThanOrEqual(100)
})

test("decide: bulk-read ask BELOW the ceiling → BOUNDED (steer from the start)", () => {
  const env = { FABULA_CONTEXT_WINDOW: "131072" } as any
  const d = decide([msg("user", "read all chapters and analyze")], "read all chapters and analyze", env)
  expect(d.action).toBe("bounded")
})

test("directive markers are distinct so the hook's idempotency check is unambiguous", () => {
  expect(CONSOLIDATE_MARKER).not.toBe(BOUNDED_MARKER)
})
