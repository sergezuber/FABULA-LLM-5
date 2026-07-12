import { describe, expect, test } from "bun:test"
import {
  TextNgramMonitor,
  detectRepeatedNgram,
  tokenizeForNgram,
} from "../../src/session/prompt/text-ngram-detection"

describe("tokenizeForNgram", () => {
  test("normalizes whitespace and case", () => {
    expect(tokenizeForNgram("  Hello   WORLD  ")).toEqual(["hello", "world"])
  })
})

describe("detectRepeatedNgram", () => {
  test("returns false when window is too small", () => {
    expect(detectRepeatedNgram(["a", "b", "c"], 6, 3)).toBe(false)
  })

  test("detects repeated 6-gram appearing 3 times", () => {
    const gram = ["one", "two", "three", "four", "five", "six"]
    const tokens = [...gram, ...gram, ...gram]
    expect(detectRepeatedNgram(tokens, 6, 3)).toBe(true)
  })

  test("returns false when same phrase appears only twice", () => {
    const gram = ["one", "two", "three", "four", "five", "six"]
    const tokens = [...gram, ...gram]
    expect(detectRepeatedNgram(tokens, 6, 3)).toBe(false)
  })
})

describe("TextNgramMonitor", () => {
  test("detects repetition across incremental appends", () => {
    const monitor = new TextNgramMonitor(6, 3, 500)
    const chunk = "one two three four five six "
    expect(monitor.append(chunk)).toBe(false)
    expect(monitor.append(chunk)).toBe(false)
    expect(monitor.append(chunk)).toBe(true)
  })

  test("reset clears prior repetition state", () => {
    const monitor = new TextNgramMonitor(6, 3, 500)
    const chunk = "one two three four five six "
    monitor.append(chunk)
    monitor.append(chunk)
    monitor.append(chunk)
    monitor.reset()
    expect(monitor.append(chunk)).toBe(false)
  })

  test("respects sliding window token limit", () => {
    const monitor = new TextNgramMonitor(3, 3, 10)
    const filler = Array.from({ length: 10 }, (_, i) => `f${i}`).join(" ") + " "
    const repeated = "alpha beta gamma "
    expect(monitor.append(filler + repeated + repeated + repeated)).toBe(true)
    monitor.reset()
    monitor.append(filler)
    expect(monitor.append(repeated)).toBe(false)
    expect(monitor.append(repeated)).toBe(false)
    expect(monitor.append(repeated)).toBe(true)
  })
})

import { ngramRecoveryStage, TEXT_NGRAM_RECOVERY_WRAPUP } from "../../src/session/prompt/text-ngram-detection"

describe("ngramRecoveryStage — graceful wrap-up before termination", () => {
  test("default cap 2: remind → replan → WRAPUP → terminate (one directed finish before the kill)", () => {
    expect(ngramRecoveryStage(0, 2)).toBe("remind")
    expect(ngramRecoveryStage(1, 2)).toBe("replan")
    expect(ngramRecoveryStage(2, 2)).toBe("wrapup")   // was: terminate — discarded a whole run's work
    expect(ngramRecoveryStage(3, 2)).toBe("terminate")
  })
  test("raised cap (env FABULA_NGRAM_MAX_RECOVERY): more replans, still exactly one wrap-up", () => {
    expect(ngramRecoveryStage(1, 4)).toBe("replan")
    expect(ngramRecoveryStage(3, 4)).toBe("replan")
    expect(ngramRecoveryStage(4, 4)).toBe("wrapup")
    expect(ngramRecoveryStage(5, 4)).toBe("terminate")
  })
  test("wrap-up text routes to the finish contract: verify_done or a clean stop, no prose", () => {
    expect(TEXT_NGRAM_RECOVERY_WRAPUP).toContain("verify_done")
    expect(TEXT_NGRAM_RECOVERY_WRAPUP).toContain("FINAL WARNING")
  })
})
