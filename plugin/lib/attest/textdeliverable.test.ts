import { describe, expect, test } from "bun:test"
import {
  isTextDeliverable,
  shouldRemark,
  TEXT_DELIVERABLE_MIN_CHARS,
  SUBAGENT_ROLES,
  type TextDeliverableInput,
} from "./textdeliverable"

// A representative literary-analysis deliverable: chapter-by-chapter, structured, > MIN_CHARS.
const LIT_ANALYSIS = `
# Литературный анализ: «NII TRED»

## Глава 1
Тезис первой главы — столкновение героя с системой. Автор использует мотив дороги.

## Глава 2
Вывод второй главы: герой находит союзника. Структура повествования меняется.

## Глава 3
Разбор третьей главы показывает ретроспективную вставку. Итог — углубление конфликта.

## Заключение
Итоговый вывод: роман построен как концентрические круги, каждый пересматривает предыдущий.
Тезис подтверждается на материале всех глав: герой не меняется, меняется ракурс.
`.repeat(3) // ensure > MIN_CHARS

function base(over: Partial<TextDeliverableInput> = {}): TextDeliverableInput {
  return {
    armed: true,
    outcome: "completed",
    agentID: "main",
    finalText: LIT_ANALYSIS,
    hadWriteTool: false,
    subagents: new Set<string>(),
    alreadyChecked: false,
    ...over,
  }
}

describe("isTextDeliverable", () => {
  test("FIRES on an armed, completed, structured literary analysis (the motivating case)", () => {
    expect(isTextDeliverable(base())).toBe(true)
  })

  test("STAYS SILENT on a chat/opinion turn (not armed)", () => {
    expect(isTextDeliverable(base({ armed: false }))).toBe(false)
  })

  test("STAYS SILENT when outcome is not completed (error/cancelled)", () => {
    expect(isTextDeliverable(base({ outcome: "error" }))).toBe(false)
    expect(isTextDeliverable(base({ outcome: "cancelled" }))).toBe(false)
  })

  test("STAYS SILENT when a write/edit tool ran (deliverable is a FILE, not the text)", () => {
    expect(isTextDeliverable(base({ hadWriteTool: true }))).toBe(false)
  })

  test("STAYS SILENT on recursion (alreadyChecked)", () => {
    expect(isTextDeliverable(base({ alreadyChecked: true }))).toBe(false)
  })

  test("STAYS SILENT when finalText is missing or too short", () => {
    expect(isTextDeliverable(base({ finalText: undefined }))).toBe(false)
    expect(isTextDeliverable(base({ finalText: "" }))).toBe(false)
    expect(isTextDeliverable(base({ finalText: "Краткий ответ без структуры." }))).toBe(false)
  })

  test("STAYS SILENT on a long but UNSTRUCTURED wall of prose (the false-positive guard)", () => {
    const prose = "Это просто длинный разговорный ответ без заголовков и разбиения на главы. ".repeat(30)
    expect(prose.length).toBeGreaterThan(TEXT_DELIVERABLE_MIN_CHARS)
    expect(isTextDeliverable(base({ finalText: prose }))).toBe(false)
  })

  test("EXCLUDES subagent slices (compaction/summarizer/summary are internal, not the deliverable)", () => {
    expect(isTextDeliverable(base({ agentID: "compaction" }))).toBe(false)
    expect(isTextDeliverable(base({ agentID: "summarizer" }))).toBe(false)
    expect(isTextDeliverable(base({ agentID: "summary" }))).toBe(false)
    expect(isTextDeliverable(base({ agentID: "explore" }))).toBe(false)
    // case-insensitive
    expect(isTextDeliverable(base({ agentID: "COMPACTION" }))).toBe(false)
    // an explicit subagent set
    expect(isTextDeliverable(base({ agentID: "aux-xyz", subagents: new Set(["aux-xyz"]) }))).toBe(false)
  })

  test("FIRES on an English chapter-by-chapter analysis too", () => {
    const en = `
# Literary Analysis of NII TRED

## Chapter 1
The thesis of chapter 1 is the protagonist's confrontation with the system.

## Chapter 2
Conclusion: the protagonist finds an ally. Narrative structure shifts.

## Conclusion
Finding: the novel is built as concentric circles.
`.repeat(3)
    expect(en.length).toBeGreaterThan(TEXT_DELIVERABLE_MIN_CHARS)
    expect(isTextDeliverable(base({ finalText: en }))).toBe(true)
  })

  test("FIRES on a bullet-list structured deliverable", () => {
    const bullets = `
Анализ по пунктам:
- Глава 1: столкновение героя с системой
- Глава 2: герой находит союзника
- Глава 3: ретроспективная вставка
- Глава 4: углубление конфликта
- Глава 5: итоговый вывод о структуре романа
`.repeat(6)
    expect(bullets.length).toBeGreaterThan(TEXT_DELIVERABLE_MIN_CHARS)
    expect(isTextDeliverable(base({ finalText: bullets }))).toBe(true)
  })

  test("SUBAGENT_ROLES contains the known background roles", () => {
    expect(SUBAGENT_ROLES.has("compaction")).toBe(true)
    expect(SUBAGENT_ROLES.has("summarizer")).toBe(true)
    expect(SUBAGENT_ROLES.has("summary")).toBe(true)
    expect(SUBAGENT_ROLES.has("explore")).toBe(true)
  })
})

describe("shouldRemark", () => {
  test("remarks when done is false AND at least one load-bearing claim was refuted", () => {
    expect(shouldRemark(false, 1)).toBe(true)
    expect(shouldRemark(false, 3)).toBe(true)
  })
  test("does NOT remark when done is true (the deliverable passed)", () => {
    expect(shouldRemark(true, 0)).toBe(false)
    expect(shouldRemark(true, 1)).toBe(false) // edge: done but somehow a refuted — done wins, no remark
  })
  test("does NOT remark when nothing was refuted (no signal to deliver)", () => {
    expect(shouldRemark(false, 0)).toBe(false)
  })
  test("respects a custom minRefuted threshold", () => {
    expect(shouldRemark(false, 1, 2)).toBe(false)
    expect(shouldRemark(false, 2, 2)).toBe(true)
  })
})
