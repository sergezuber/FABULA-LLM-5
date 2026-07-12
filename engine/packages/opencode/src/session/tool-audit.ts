// Context OS Phase 0.3: per-source accounting of
// the tool-schema weight that actually reaches the model. Pure — unit-tested without engine
// boot; resolveTools feeds it entries at schema-build time and logs the breakdown on the
// existing `fabula-belt` line. Token counts are the chars/4 estimate used across the audit
// tooling (proxy/context_audit.py) so layers are comparable end-to-end.

export type ToolAuditEntry = {
  key: string
  /** "builtin/plugin" for registry tools, "mcp:<server>" for MCP tools. */
  source: string
  /** serialized schema + description length in chars */
  chars: number
}

const estTokens = (chars: number) => Math.ceil(chars / 4)

/** Build one audit entry from what resolveTools has in hand at schema-build time. */
export function auditEntry(key: string, source: string, schemaJson: unknown, description?: string): ToolAuditEntry {
  let schemaChars = 0
  try {
    schemaChars = JSON.stringify(schemaJson)?.length ?? 0
  } catch {
    schemaChars = 0 // circular/unserializable schema: count only the description, never throw
  }
  return { key, source, chars: schemaChars + (description?.length ?? 0) }
}

export type SchemaBreakdown = {
  bySource: Record<string, { count: number; tokens: number }>
  total: { count: number; tokens: number }
}

/** Group audit entries per source with token estimates. Deterministic: sources sorted. */
export function schemaTokenBreakdown(entries: readonly ToolAuditEntry[]): SchemaBreakdown {
  const bySource: Record<string, { count: number; tokens: number }> = {}
  const total = { count: 0, tokens: 0 }
  for (const e of entries) {
    const b = (bySource[e.source] ??= { count: 0, tokens: 0 })
    const t = estTokens(e.chars)
    b.count += 1
    b.tokens += t
    total.count += 1
    total.tokens += t
  }
  const sorted: typeof bySource = {}
  for (const k of Object.keys(bySource).sort()) sorted[k] = bySource[k]
  return { bySource: sorted, total }
}

/** Compact one-line rendering for the fabula-belt log: "mcp:serena=28/6.2k builtin/plugin=87/9.1k". */
export function renderBreakdown(b: SchemaBreakdown): string {
  const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n))
  return Object.entries(b.bySource)
    .map(([src, v]) => `${src}=${v.count}/${fmt(v.tokens)}`)
    .join(" ")
}

/** Same sanitize as mcp/index.ts — MCP tool keys are `sanitize(server)_sanitize(tool)`. */
const sanitizeMcp = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")

/** Resolve an MCP tool key to its server source ("mcp:<server>") given the REAL connected
 *  server names. Longest sanitized prefix wins (server names may themselves contain '_').
 *  Unmatched keys fall back to "mcp:?" — counted, never dropped. */
export function mcpSourceFor(key: string, serverNames: readonly string[]): string {
  let best: string | undefined
  let bestLen = -1
  for (const name of serverNames) {
    const san = sanitizeMcp(name)
    if ((key.startsWith(san + "_") || key.startsWith(san + ":")) && san.length > bestLen) {
      best = name
      bestLen = san.length
    }
  }
  return "mcp:" + (best ?? "?")
}
