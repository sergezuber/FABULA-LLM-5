import { test, expect } from "bun:test"
import { exportRange, toCsv, type Row } from "./export"

const ROWS: Row[] = [
  { id: 3, date: "2026-07-03", amount: 30 },
  { id: 1, date: "2026-07-01", amount: 10 },
  { id: 2, date: "2026-07-02", amount: 20 },
  { id: 4, date: "2026-07-04", amount: 40 },
]

test("rows inside the range are returned", () => {
  const out = exportRange(ROWS, "2026-07-01", "2026-07-04")
  expect(out.map((r) => r.id)).toContain(1)
  expect(out.map((r) => r.id)).toContain(2)
  expect(out.map((r) => r.id)).toContain(3)
})

test("rows before the range are excluded", () => {
  const out = exportRange(ROWS, "2026-07-02", "2026-07-04")
  expect(out.map((r) => r.id)).not.toContain(1)
})

test("empty range returns nothing", () => {
  expect(exportRange(ROWS, "2026-08-01", "2026-08-02")).toEqual([])
})

test("rows come back sorted by date then id", () => {
  const out = exportRange(ROWS, "2026-07-01", "2026-07-04")
  const dates = out.map((r) => r.date)
  expect(dates).toEqual([...dates].sort())
})

test("toCsv renders a header and fixed-point amounts", () => {
  const csv = toCsv([{ id: 1, date: "2026-07-01", amount: 10 }])
  expect(csv.split("\n")[0]).toBe("id,date,amount")
  expect(csv).toContain("1,2026-07-01,10.00")
})
