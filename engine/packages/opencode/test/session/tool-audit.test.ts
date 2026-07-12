// Tests for session/tool-audit.ts — Context OS Phase 0 per-source schema accounting (pure).
import { describe, expect, test } from "bun:test"
import { auditEntry, mcpSourceFor, schemaTokenBreakdown, renderBreakdown, type ToolAuditEntry } from "../../src/session/tool-audit"

describe("auditEntry", () => {
  test("counts schema JSON chars + description chars", () => {
    const e = auditEntry("bash", "builtin/plugin", { type: "object", properties: {} }, "run a command")
    expect(e.key).toBe("bash")
    expect(e.source).toBe("builtin/plugin")
    expect(e.chars).toBe(JSON.stringify({ type: "object", properties: {} }).length + "run a command".length)
  })

  test("missing description contributes zero", () => {
    const e = auditEntry("x", "builtin/plugin", {})
    expect(e.chars).toBe(2) // "{}"
  })

  test("circular schema never throws — falls back to description only", () => {
    const circ: Record<string, unknown> = {}
    circ.self = circ
    const e = auditEntry("weird", "mcp:serena", circ, "desc")
    expect(e.chars).toBe(4)
  })
})

describe("schemaTokenBreakdown", () => {
  const entries: ToolAuditEntry[] = [
    { key: "bash", source: "builtin/plugin", chars: 400 },
    { key: "edit", source: "builtin/plugin", chars: 100 },
    { key: "serena:find_symbol", source: "mcp:serena", chars: 4000 },
    { key: "serena:read_file", source: "mcp:serena", chars: 3999 },
    { key: "searxng:web_search", source: "mcp:searxng", chars: 1 },
  ]

  test("groups per source with ceil(chars/4) tokens", () => {
    const b = schemaTokenBreakdown(entries)
    expect(b.bySource["builtin/plugin"]).toEqual({ count: 2, tokens: 100 + 25 })
    expect(b.bySource["mcp:serena"]).toEqual({ count: 2, tokens: 1000 + 1000 }) // ceil(3999/4)=1000
    expect(b.bySource["mcp:searxng"]).toEqual({ count: 1, tokens: 1 }) // ceil(1/4)=1
    expect(b.total).toEqual({ count: 5, tokens: 125 + 2000 + 1 })
  })

  test("sources are sorted deterministically", () => {
    const b = schemaTokenBreakdown(entries)
    expect(Object.keys(b.bySource)).toEqual(["builtin/plugin", "mcp:searxng", "mcp:serena"])
  })

  test("empty input", () => {
    const b = schemaTokenBreakdown([])
    expect(b.total).toEqual({ count: 0, tokens: 0 })
    expect(Object.keys(b.bySource)).toEqual([])
  })
})

describe("mcpSourceFor — server grouping from LIVE client names", () => {
  const SERVERS = ["code-go-serena", "code-structural-search", "web-search-internet", "current-time"]
  test("groups underscore-form keys by their real server (longest prefix wins)", () => {
    expect(mcpSourceFor("code-go-serena_find_symbol", SERVERS)).toBe("mcp:code-go-serena")
    expect(mcpSourceFor("code-structural-search_find_code", SERVERS)).toBe("mcp:code-structural-search")
    expect(mcpSourceFor("web-search-internet_searxng_web_search", SERVERS)).toBe("mcp:web-search-internet")
    expect(mcpSourceFor("current-time_get_utc_datetime", SERVERS)).toBe("mcp:current-time")
  })
  test("colon-form keys group too; unknown keys fall back to mcp:?", () => {
    expect(mcpSourceFor("code-go-serena:find_symbol", SERVERS)).toBe("mcp:code-go-serena")
    expect(mcpSourceFor("mystery_tool", SERVERS)).toBe("mcp:?")
    expect(mcpSourceFor("anything", [])).toBe("mcp:?")
  })
  test("server names needing sanitize match their sanitized keys", () => {
    expect(mcpSourceFor("my_server_tool_x", ["my server"])).toBe("mcp:my server")
  })
})

describe("renderBreakdown", () => {
  test("compact one-liner with k-formatting above 1000", () => {
    const s = renderBreakdown(
      schemaTokenBreakdown([
        { key: "a", source: "builtin/plugin", chars: 400 },
        { key: "b", source: "mcp:serena", chars: 8000 },
      ]),
    )
    expect(s).toBe("builtin/plugin=1/100 mcp:serena=1/2.0k")
  })

  test("empty breakdown renders empty string", () => {
    expect(renderBreakdown(schemaTokenBreakdown([]))).toBe("")
  })
})
