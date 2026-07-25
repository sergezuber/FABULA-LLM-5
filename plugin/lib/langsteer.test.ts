import { describe, expect, test } from "bun:test"
import {
  dominantScript,
  intrudingScripts,
  languageSteer,
  scriptCounts,
  scriptName,
  INTRUSION_MAX_SHARE,
} from "./langsteer"

// The live defect, verbatim: a Russian answer with Chinese spliced into its own sentences.
const MIXED = "### Откуда, скорее всего, 这个故事: структура 看似 абсурдную инструкцию даёт мастер ученику"
const CLEAN_RU = "Расскажи в двух абзацах, чем притча отличается от басни и приведи пример каждой"

describe("dominantScript", () => {
  test("a Russian question reads as Cyrillic", () => {
    expect(dominantScript(CLEAN_RU)).toBe("cyrillic")
  })

  test("an English question reads as Latin", () => {
    expect(dominantScript("Find this parable and tell me which book it is from")).toBe("latin")
  })

  test("the mixed answer is still dominantly Russian — the intrusion is the minority", () => {
    expect(dominantScript(MIXED)).toBe("cyrillic")
  })

  test("too few letters to tell → null, and the steer stays silent rather than guessing", () => {
    expect(dominantScript("ok")).toBeNull()
    expect(dominantScript("")).toBeNull()
    expect(languageSteer("ok")).toBe("")
  })
})

describe("intrudingScripts", () => {
  test("the spliced Chinese is flagged", () => {
    expect(intrudingScripts(MIXED, "cyrillic")).toContain("han")
  })

  test("clean Russian has nothing to flag", () => {
    expect(intrudingScripts(CLEAN_RU, "cyrillic")).toEqual([])
  })

  test("Latin is NEVER an intrusion — names, URLs and code live in it inside every language", () => {
    const t = "Смотри в файле web_search.ts на GitHub, ссылка https://example.com — там есть ответ"
    expect(intrudingScripts(t, "cyrillic")).toEqual([])
  })

  test("a genuinely bilingual message is not a defect: past the share threshold it is not an intrusion", () => {
    const half = "текст ".repeat(10) + "文字文字文字文字文字文字文字文字文字文字文字文字文字文字文字"
    const counts = scriptCounts(half)
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    expect(counts.han / total).toBeGreaterThan(INTRUSION_MAX_SHARE)
    expect(intrudingScripts(half, "cyrillic")).toEqual([])
  })
})

describe("languageSteer", () => {
  test("a Russian ask is pinned to Russian, by name", () => {
    const s = languageSteer(CLEAN_RU)
    expect(s).toContain("Russian")
    expect(s).toContain("entire answer")
  })

  test("an English ask is pinned to English", () => {
    expect(languageSteer("Explain the difference between a parable and a fable in two paragraphs")).toContain(
      "English",
    )
  })

  test("technical terms are explicitly left alone, so the steer cannot mangle code", () => {
    expect(languageSteer(CLEAN_RU)).toMatch(/code|Technical/)
  })

  test("scriptName is human-readable for every script we detect", () => {
    expect(scriptName("han")).toBe("Chinese")
    expect(scriptName("cyrillic")).toBe("Russian")
  })

  test("malformed input never throws", () => {
    expect(() => languageSteer(undefined as any)).not.toThrow()
    expect(languageSteer(undefined as any)).toBe("")
  })
})
