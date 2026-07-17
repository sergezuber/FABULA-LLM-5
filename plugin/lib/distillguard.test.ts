import { test, expect } from "bun:test"
import {
  uncensoredPattern, isUncensoredModel, isDistillRun, shouldBlockDistill, DISTILL_SKIP_NOTICE,
} from "./distillguard"

const DISTILL_PROMPT =
  "Run one automatic distill pass for the current project.\n\n" +
  "Review the past month of sessions and identify repeated manual workflows worth packaging.\n" +
  "Use the raw mimocode trajectory database as the source of truth and memory files to spot cross-session patterns."

test("isUncensoredModel: default markers (heretic/uncensored/abliterated/dolphin) match; aligned ids don't", () => {
  const pat = uncensoredPattern({})
  expect(isUncensoredModel("qwen-7b-uncensored-heretic-mlx", pat)).toBe(true)
  expect(isUncensoredModel("qwen3.6-35b-a3b-uncensored", pat)).toBe(true)
  expect(isUncensoredModel("dolphin-2.9-llama3", pat)).toBe(true)
  expect(isUncensoredModel("mistral-7b-abliterated", pat)).toBe(true)
  // aligned / non-decensored ids must NOT match
  expect(isUncensoredModel("qwen3.6-35b-a3b-ud-mlx", pat)).toBe(false)
  expect(isUncensoredModel("z-ai/glm-5.1", pat)).toBe(false)
  expect(isUncensoredModel("openai/gpt-oss-20b", pat)).toBe(false)
  expect(isUncensoredModel(undefined, pat)).toBe(false)
})

test("uncensoredPattern: env override (regex and CSV)", () => {
  const re = uncensoredPattern({ FABULA_DISTILL_BLOCK_MODELS: "ud-mlx|special" })
  expect(isUncensoredModel("qwen3.6-35b-a3b-ud-mlx", re)).toBe(true)
  const csv = uncensoredPattern({ FABULA_DISTILL_BLOCK_MODELS: "ud-mlx, my-model" })
  expect(isUncensoredModel("qwen3.6-35b-a3b-ud-mlx", csv)).toBe(true)
  expect(isUncensoredModel("my-model-v2", csv)).toBe(true)
  expect(isUncensoredModel("qwen3.6-35b-a3b-uncensored", csv)).toBe(false) // override replaces default
})

test("isDistillRun: subagent name OR prompt signature; not a casual mention", () => {
  expect(isDistillRun({ agent: "distill" })).toBe(true)
  expect(isDistillRun({ agent: "Distill" })).toBe(true)
  expect(isDistillRun({ text: DISTILL_PROMPT })).toBe(true)
  // casual user mentions must NOT trigger
  expect(isDistillRun({ agent: "build", text: "please distill this idea into one sentence" })).toBe(false)
  expect(isDistillRun({ text: "what does distill mean?" })).toBe(false)
  expect(isDistillRun({})).toBe(false)
})

test("shouldBlockDistill: ONLY distill-run AND uncensored model", () => {
  const pat = uncensoredPattern({})
  // forbidden combo → block
  expect(shouldBlockDistill({ agent: "distill", text: DISTILL_PROMPT, modelID: "qwen-7b-uncensored-heretic-mlx", pat })).toBe(true)
  expect(shouldBlockDistill({ agent: "distill", modelID: "qwen3.6-35b-a3b-uncensored", pat })).toBe(true)
  // distill on an ALIGNED model → allowed (don't block)
  expect(shouldBlockDistill({ agent: "distill", text: DISTILL_PROMPT, modelID: "qwen3.6-35b-a3b-ud-mlx", pat })).toBe(false)
  expect(shouldBlockDistill({ agent: "distill", modelID: "z-ai/glm-5.1", pat })).toBe(false)
  // non-distill turn on an uncensored model → allowed (normal chat untouched)
  expect(shouldBlockDistill({ agent: "build", text: "hi", modelID: "qwen-7b-uncensored-heretic-mlx", pat })).toBe(false)
})

test("DISTILL_SKIP_NOTICE forbids studying + DB access", () => {
  expect(DISTILL_SKIP_NOTICE).toMatch(/do not inspect any database/i)
  expect(DISTILL_SKIP_NOTICE).toMatch(/disabled on uncensored models/i)
})

// ── dream: the second self-improvement pass, same policy (the 2026-07-17 gap) ──
import { isDreamRun, blockedSelfImprovePass, DREAM_SKIP_NOTICE } from "./distillguard"

const DREAM_PROMPT = [
  "Run one automatic dream memory consolidation pass for the current project.",
  "Use the memory files as the working index and the raw mimocode trajectory database as the source of truth.",
].join("\n")

test("isDreamRun: by agent name and by the stable prompt signature; casual 'dream' NOT caught", () => {
  expect(isDreamRun({ agent: "dream" })).toBe(true)
  expect(isDreamRun({ agent: "Dream " })).toBe(true)
  expect(isDreamRun({ text: DREAM_PROMPT })).toBe(true)
  expect(isDreamRun({ text: "i had a dream about my project" })).toBe(false)
  expect(isDreamRun({ text: "dream memory consolidation" })).toBe(false) // no corroborating marker
  expect(isDreamRun({})).toBe(false)
})

test("blockedSelfImprovePass: ONE decision for both passes", () => {
  const pat = uncensoredPattern({})
  // dream on uncensored → blocked with the DREAM notice
  expect(blockedSelfImprovePass({ agent: "dream", text: DREAM_PROMPT, modelID: "qwen3.6-35b-a3b-uncensored-heretic-mlx", pat })).toBe(DREAM_SKIP_NOTICE)
  // distill on uncensored → blocked with the DISTILL notice (regression)
  expect(blockedSelfImprovePass({ agent: "distill", modelID: "qwen-7b-uncensored", pat })).toBe(DISTILL_SKIP_NOTICE)
  // dream on an ALIGNED model → allowed
  expect(blockedSelfImprovePass({ agent: "dream", text: DREAM_PROMPT, modelID: "qwen3.6-35b-a3b-ud-mlx", pat })).toBe(null)
  // ordinary chat on an uncensored model → untouched
  expect(blockedSelfImprovePass({ agent: "build", text: "hello", modelID: "qwen-7b-uncensored", pat })).toBe(null)
})

test("DREAM_SKIP_NOTICE forbids memory writes + DB access", () => {
  expect(DREAM_SKIP_NOTICE).toMatch(/do not inspect any/i)
  expect(DREAM_SKIP_NOTICE).toMatch(/memory files/i)
  expect(DREAM_SKIP_NOTICE).toMatch(/disabled on uncensored models/i)
})
