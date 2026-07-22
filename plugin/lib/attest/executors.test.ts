import { test, expect } from "bun:test"
import { checkCitation, checkMeasurement, checkProcess, checkConsistency } from "./executors"
import type { Claim, SourceDoc, LedgerView } from "./types"

const SOURCES: SourceDoc[] = [
  { label: "глава_01", text: "Кружка тёплая сама по себе. Линолеум с трещиной у стены. Корреляция 0.9999." },
  { label: "глава_05", text: "Девять аналитиков за сорок семь лет пришли к одному результату." },
]
const cite = (text: string, attribution?: string): Claim => ({ id: "c", text, type: "citation", attribution, loadBearing: true })

test("checkCitation: verbatim quote in the claimed source → PASS", () => {
  const r = checkCitation(cite('The text: «Кружка тёплая сама по себе.»', "глава_01"), SOURCES)
  expect(r.outcome).toBe("PASS")
  expect(r.span).toBe("глава_01")
})

test("checkCitation: verbatim but attributed to the WRONG chapter → SIGNAL (mis-attribution, not a free pass)", () => {
  // the quote IS in глава_01 but the claim attributes it to глава_05
  const r = checkCitation(cite('глава_05 says «Кружка тёплая сама по себе.»', "глава_05"), SOURCES)
  expect(r.outcome).toBe("SIGNAL")
})

test("checkCitation: fabricated quote present nowhere → SIGNAL", () => {
  const r = checkCitation(cite('«Этой строки нет ни в одной главе никогда.»', "глава_01"), SOURCES)
  expect(r.outcome).toBe("SIGNAL")
})

test("checkCitation: no sources → NA (never a false confirm)", () => {
  expect(checkCitation(cite('«whatever»'), []).outcome).toBe("NA")
})

test("checkMeasurement: number present in source → PASS; fabricated → SIGNAL; no number → NA", () => {
  const m = (text: string): Claim => ({ id: "m", text, type: "measurement", loadBearing: true })
  expect(checkMeasurement(m("correlation reaches 0.9999"), SOURCES).outcome).toBe("PASS")
  expect(checkMeasurement(m("correlation reaches 0.7777"), SOURCES).outcome).toBe("SIGNAL")
  expect(checkMeasurement(m("nine analysts"), SOURCES).outcome).toBe("NA")
})

test("checkProcess: partial ledger → NA (honest, never a false process-lie)", () => {
  const claim: Claim = { id: "p", text: "Прочитаны все 29 файлов глав", type: "process", loadBearing: true }
  const ledger: LedgerView = { readLabels: ["глава_01", "глава_05"], partial: true }
  const r = checkProcess(claim, ledger)
  expect(r.outcome).toBe("NA")
  expect(r.coverageNote).toContain("partial")
})

test("checkProcess: complete ledger, claimed count > reads → SIGNAL (process-lie)", () => {
  const claim: Claim = { id: "p", text: "read all 29 files", type: "process", loadBearing: true }
  const ledger: LedgerView = { readLabels: ["a", "b", "c"], partial: false }
  expect(checkProcess(claim, ledger).outcome).toBe("SIGNAL")
})

test("checkProcess: no ledger → NA", () => {
  expect(checkProcess({ id: "p", text: "read all", type: "process", loadBearing: true }, null).outcome).toBe("NA")
})

test("checkConsistency: same subject, different numbers → contradiction", () => {
  const claims: Claim[] = [
    { id: "1", text: "nine analysts worked there", type: "measurement", loadBearing: true },
    { id: "2", text: "seven analysts worked there", type: "measurement", loadBearing: true },
    { id: "3", text: "the cup was warm", type: "citation", loadBearing: false },
  ]
  // "nine"/"seven" are words not digits — use digit forms to exercise the numeric detector
  const claims2: Claim[] = [
    { id: "1", text: "9 analysts worked there", type: "measurement", loadBearing: true },
    { id: "2", text: "7 analysts worked there", type: "measurement", loadBearing: true },
  ]
  expect(checkConsistency(claims2).length).toBe(1)
  expect(checkConsistency([claims[2]]).length).toBe(0)
})
