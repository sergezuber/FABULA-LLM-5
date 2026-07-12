// session_search query helpers (pure, unit-testable). The engine already maintains an FTS5
// index `history_fts_idx(body)` with external content `history_fts` (part_id, session_id, message_id,
// project_id, kind, tool_name, body, time_created). We query it read-only. The tool adds dedup,
// per-session grouping, and a threat-scan of recalled text (past sessions may contain injection).

/** Turn a free-text query into a safe FTS5 MATCH string: quote each term as a phrase, OR-join.
 *  (Prevents FTS5 from parsing `circuit-breaker`/`AND`/columns as operators.) */
export function toFtsMatch(query: string, mode: "or" | "and" = "or"): string {
  const terms = (query || "").match(/[\p{L}\p{N}_]+/gu) || []
  if (!terms.length) return ""
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(mode === "and" ? " AND " : " OR ")
}

export interface SearchRow {
  session_id: string; message_id: string; kind: string; tool_name: string | null
  snip: string; time_created: number; score: number
}

/** SQL to search the FTS index; bind [match, (excludeSession?), limit]. */
export function searchSql(opts: { excludeSession?: boolean }): string {
  return `SELECT h.session_id, h.message_id, h.kind, h.tool_name,
       snippet(history_fts_idx, 0, '«', '»', '…', 14) AS snip,
       h.time_created, bm25(history_fts_idx) AS score
FROM history_fts_idx JOIN history_fts h ON h.rowid = history_fts_idx.rowid
WHERE history_fts_idx MATCH ?${opts.excludeSession ? " AND h.session_id != ?" : ""}
ORDER BY score LIMIT ?`
}

/** Collapse near-duplicate hits (same message_id repeated across part revisions). */
export function dedupeRows(rows: SearchRow[]): SearchRow[] {
  const seen = new Set<string>()
  const out: SearchRow[] = []
  for (const r of rows) {
    const key = r.message_id + "::" + r.snip.replace(/\s+/g, " ").trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}
