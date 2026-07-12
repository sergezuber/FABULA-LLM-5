// Nightly export the finance team pulls: all rows within a date range, then CSV.

export interface Row {
  id: number
  /** ISO date, YYYY-MM-DD */
  date: string
  amount: number
}

/** Rows within [from, to] — both ends inclusive, per the report spec. */
export function exportRange(rows: Row[], from: string, to: string): Row[] {
  return rows
    .filter((r) => r.date >= from && r.date < to)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id))
}

export function toCsv(rows: Row[]): string {
  const header = "id,date,amount"
  const body = rows.map((r) => `${r.id},${r.date},${r.amount.toFixed(2)}`)
  return [header, ...body].join("\n")
}
