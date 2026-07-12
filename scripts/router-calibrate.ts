#!/usr/bin/env bun
// Context OS section 7 calibration — offline router evaluation over the REAL fabula.db golden set.
// Gates Phase 1 (design §9): sweeps the hysteresis margin and prints the recall/size curve.
// Read-only. Native history is the primary signal; imported (external-import) history is mapped and
// evaluated SEPARATELY (secondary).
//
//   bun scripts/router-calibrate.ts [--db <path>] [--cards <cards.json>] [--json]
//
// Tool cards: with --cards, the REAL exported registry cards are used (Phase 1 artifact).
// Without it, minimal id-only cards are synthesized from history — an honest LOWER BOUND:
// only the verbatim/id-token arm carries signal (no descriptions/utterances yet).
import { Database } from "bun:sqlite"
import os from "node:os"
import path from "node:path"
import { buildGoldenCases, evaluateRouter, type SessionRow } from "../plugin/lib/goldenset"
import { GATE_REQUIRED_TOOLS, computeTiers, mapImportedName, type UsageRow } from "../plugin/lib/toolusage"
import type { Profile, ToolCard } from "../plugin/lib/toolrouter"

const args = process.argv.slice(2)
const asJson = args.includes("--json")
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const dbPath =
  flag("--db") ?? path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "fabula", "fabula.db")

const db = new Database(dbPath, { readonly: true })

// (sessionId, firstUserText, tool) rows. First user text = the text part of the session's
// earliest user message (non-synthetic paths only exist as parts; imported history included
// via the same query then split by external_import membership).
const ROWS_SQL = `
  WITH first_user AS (
    SELECT m.session_id AS sid, MIN(m.id) AS mid
    FROM message m
    WHERE json_extract(m.data, '$.role') = 'user'
    GROUP BY m.session_id
  ),
  first_text AS (
    SELECT fu.sid AS sid, (
      SELECT p.data FROM part p
      WHERE p.message_id = fu.mid AND json_extract(p.data, '$.type') = 'text'
      ORDER BY p.id LIMIT 1
    ) AS tdata
    FROM first_user fu
  )
  SELECT p.session_id AS sessionId,
         json_extract(ft.tdata, '$.text') AS firstUserText,
         json_extract(p.data, '$.tool') AS tool,
         CASE WHEN p.session_id IN (SELECT session_id FROM external_import) THEN 1 ELSE 0 END AS imported
  FROM part p
  JOIN session s ON s.id = p.session_id
  LEFT JOIN first_text ft ON ft.sid = p.session_id
  WHERE json_extract(p.data, '$.type') = 'tool'
    AND s.title NOT LIKE 'checkpoint-writer:%'
    AND s.title NOT LIKE 'auto dream%'
    AND s.title NOT LIKE 'auto distill%'`

type RawRow = SessionRow & { imported: number }
const raw = db.query(ROWS_SQL).all() as RawRow[]

const nativeRows: SessionRow[] = []
const importedRows: SessionRow[] = []
for (const r of raw) {
  if (r.imported) {
    const mapped = mapImportedName(r.tool)
    if (mapped) importedRows.push({ sessionId: r.sessionId, firstUserText: r.firstUserText, tool: mapped })
  } else {
    nativeRows.push({ sessionId: r.sessionId, firstUserText: r.firstUserText, tool: r.tool })
  }
}

// Tool cards: real registry export, or honest id-only synthesis from history.
const cardsPath = flag("--cards")
let cards: ToolCard[]
let cardsSource: string
if (cardsPath) {
  cards = JSON.parse(await Bun.file(cardsPath).text()) as ToolCard[]
  cardsSource = cardsPath
} else {
  const ids = new Set<string>([...GATE_REQUIRED_TOOLS])
  for (const r of [...nativeRows, ...importedRows]) if (r.tool) ids.add(r.tool)
  cards = [...ids].sort().map((id) => ({ id, description: "" }))
  cardsSource = "synthesized-from-history (id-only, LOWER BOUND — no descriptions/utterances)"
}

// Profiles for calibration: tier-derived nesting (lean=T0 … full=everything). The REAL
// profile registry ships in Phase 1 (toolbelt); this yields the shape of the curve now.
const usage: UsageRow[] = [...nativeRows, ...importedRows]
  .filter((r) => r.tool)
  .map((r) => ({ sessionId: r.sessionId, tool: r.tool }))
const tiers = computeTiers(usage)
const t0 = new Set<string>(tiers.t0)
const profiles: Profile[] = [
  { id: "lean-t0", tools: tiers.t0 },
  { id: "mid-t0t1", tools: [...tiers.t0, ...tiers.t1] },
  { id: "full", tools: [...tiers.t0, ...tiers.t1, ...tiers.t2] },
]

const nativeCases = buildGoldenCases(nativeRows)
const importedCases = buildGoldenCases(importedRows)

const MARGINS = [0, 0.1, 0.15, 0.25, 0.5, 1]
type CurvePoint = { margin: number; cases: number; fullCoverage: number; meanCoverage: number; meanVisible: number; misses: number }
const curve = (cases: ReturnType<typeof buildGoldenCases>): CurvePoint[] =>
  MARGINS.map((margin) => {
    const r = evaluateRouter(cases, cards, profiles, t0, { margin })
    return {
      margin,
      cases: r.cases,
      fullCoverage: +r.fullCoverage.toFixed(3),
      meanCoverage: +r.meanCoverage.toFixed(3),
      meanVisible: +r.meanVisible.toFixed(1),
      misses: r.misses.length,
    }
  })

const nativeCurve = curve(nativeCases)
const importedCurve = curve(importedCases)

if (asJson) {
  console.log(JSON.stringify({ db: dbPath, cards: cardsSource, profiles: profiles.map((p) => ({ id: p.id, size: p.tools.length })), native: nativeCurve, imported: importedCurve }, null, 2))
} else {
  console.log(`db: ${dbPath}\ncards: ${cardsSource}`)
  console.log(`profiles: ${profiles.map((p) => `${p.id}(${p.tools.length})`).join(", ")}\n`)
  const render = (label: string, pts: CurvePoint[], n: number) => {
    console.log(`===== ${label} (${n} golden cases) =====`)
    console.log(`  margin  full-cov  mean-cov  mean-visible  misses`)
    for (const p of pts)
      console.log(
        `  ${String(p.margin).padEnd(6)}  ${String(p.fullCoverage).padEnd(8)}  ${String(p.meanCoverage).padEnd(8)}  ${String(p.meanVisible).padEnd(12)}  ${p.misses}`,
      )
    console.log("")
  }
  render("NATIVE (primary)", nativeCurve, nativeCases.length)
  render("IMPORTED-mapped (secondary)", importedCurve, importedCases.length)
}
