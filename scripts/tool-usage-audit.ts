#!/usr/bin/env bun
// Context OS Phase 0 (design section 9 Phase 0.4): derive the T0/T1/T2 tool tiers from REAL usage
// history in fabula.db. Read-only; native sessions are the primary signal, imported (external-import)
// history is mapped by name and reported SEPARATELY (secondary, never merged silently).
//
//   bun scripts/tool-usage-audit.ts [--json] [--db <path>]
//
// Exclusions mirror the fabula data-isolation rules: external_import sessions and the
// engine's background checkpoint-writer/dream/distill sessions.
import { Database } from "bun:sqlite"
import os from "node:os"
import path from "node:path"
import { computeTiers, mapImportedName, renderTiers, type UsageRow } from "../plugin/lib/toolusage"

const args = process.argv.slice(2)
const asJson = args.includes("--json")
const dbFlag = args.indexOf("--db")
const dbPath =
  dbFlag >= 0
    ? args[dbFlag + 1]
    : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "fabula", "fabula.db")

const db = new Database(dbPath, { readonly: true })

// Native rows: tool parts from non-imported, non-background sessions.
const nativeRows = db
  .query(
    `SELECT p.session_id AS sessionId, json_extract(p.data, '$.tool') AS tool
     FROM part p
     JOIN session s ON s.id = p.session_id
     WHERE json_extract(p.data, '$.type') = 'tool'
       AND p.session_id NOT IN (SELECT session_id FROM external_import)
       AND s.title NOT LIKE 'checkpoint-writer:%'
       AND s.title NOT LIKE 'auto dream%'
       AND s.title NOT LIKE 'auto distill%'`,
  )
  .all() as UsageRow[]

// Imported rows: mapped by name; unmapped names counted for the report.
const importedRaw = db
  .query(
    `SELECT p.session_id AS sessionId, json_extract(p.data, '$.tool') AS tool
     FROM part p
     WHERE json_extract(p.data, '$.type') = 'tool'
       AND p.session_id IN (SELECT session_id FROM external_import)`,
  )
  .all() as UsageRow[]

const importedRows: UsageRow[] = []
const unmapped = new Map<string, number>()
for (const r of importedRaw) {
  const mapped = mapImportedName(r.tool)
  if (mapped) importedRows.push({ sessionId: r.sessionId, tool: mapped })
  else unmapped.set(r.tool, (unmapped.get(r.tool) ?? 0) + 1)
}

const native = computeTiers(nativeRows)
const imported = computeTiers(importedRows)

if (asJson) {
  console.log(
    JSON.stringify(
      {
        db: dbPath,
        native: { rows: nativeRows.length, t0: native.t0, t1: native.t1, t2: native.t2, stats: native.stats },
        imported: { rows: importedRaw.length, mapped: importedRows.length, t0: imported.t0, unmapped: Object.fromEntries(unmapped) },
      },
      null,
      2,
    ),
  )
} else {
  console.log(`db: ${dbPath}`)
  console.log(`\n===== NATIVE history (${nativeRows.length} tool calls) — PRIMARY signal =====`)
  console.log(renderTiers(native))
  console.log(`\n===== IMPORTED history (${importedRaw.length} calls, ${importedRows.length} mapped) — secondary =====`)
  console.log(renderTiers(imported, 10))
  if (unmapped.size) {
    const top = [...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    console.log(`\nunmapped imported names (top): ${top.map(([n, c]) => `${n}×${c}`).join(", ")}`)
  }
}
