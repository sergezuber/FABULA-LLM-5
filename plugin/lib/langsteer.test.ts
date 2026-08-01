import { describe, expect, test } from "bun:test"
import {
  dominantScript,
  intrudingScripts,
  languageSteer,
  scriptCounts,
  scriptName,
  INTRUSION_MAX_SHARE,
  languagePosture,
  foreignScriptNames,
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

// MEASURED 2026-08-01: the forbidden list was hardcoded "Chinese, Japanese, Korean or Arabic" whatever
// was detected, so a Chinese question got "[Write the entire answer in Chinese ... check it contains no
// Chinese ... characters]" — an instruction that forbids the script it demands, in one sentence. The
// file had 13 tests and not one asserted the steer TEXT for a CJK or Arabic dominant script.
describe("the steer never forbids the language it demands", () => {
  const ASKS: Array<[string, string]> = [
    ["Chinese", "请解释一下这段代码的作用，并给出改进建议好吗"],
    ["Japanese", "このコードの動作を説明して、改善案を提案してください"],
    ["Korean", "이 코드가 무엇을 하는지 설명하고 개선 방법을 제안해 주세요"],
    ["Arabic", "اشرح لي ما تفعله هذه الشفرة وقدم اقتراحات للتحسين من فضلك"],
    ["Russian", "объясни что делает этот код и предложи улучшения пожалуйста"],
    ["English", "explain what this code does and suggest some improvements please"],
  ]
  for (const [lang, ask] of ASKS) {
    test(`${lang}: demanded, and absent from its own forbidden list`, () => {
      for (const text of [languageSteer(ask), languagePosture(ask)]) {
        expect(text).toContain(lang)
        // The two channels phrase it differently ("contains no X characters" / "Never emit X characters").
        const forbidden = text.match(/(?:contains no|Never emit) ([^.]+?) characters/)
        expect(forbidden).not.toBeNull()
        expect(forbidden![1]).not.toContain(lang)
      }
    })
  }

  test("Japanese still permits Han — kanji is not an intrusion into Japanese", () => {
    expect(foreignScriptNames("hiragana")).not.toContain("Chinese")
    // and the reverse is NOT true: hiragana in a Chinese answer is an intrusion.
    expect(foreignScriptNames("han")).toContain("Japanese")
  })

  test("Latin is never forbidden — names, URLs and identifiers live in it in every language", () => {
    for (const id of ["cyrillic", "han", "hangul", "hiragana", "arabic"] as const) {
      expect(foreignScriptNames(id)).not.toContain("English")
    }
  })
})
