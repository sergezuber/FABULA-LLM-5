// Import external plugins shipped in the .claude-plugin/.codex-plugin format (Item 5). Pure mapping core — the IO lives in
// scripts/import-external-plugin.ts. Reads a plugin's `.claude-plugin/plugin.json` (+ `.mcp.json` or an inline `mcpServers`)
// and maps its MCP servers into FABULA's engine config format, resolving the ecosystem-standard
// `${CLAUDE_PLUGIN_ROOT}` (and a `${FABULA_PLUGIN_ROOT}` alias) to the plugin's directory. The
// `.claude-plugin` path and `${CLAUDE_PLUGIN_ROOT}` variable are external on-disk contracts — kept
// literal (like `.mcp.json`) so third-party plugins load unchanged.

/** An MCP-standard server entry (stdio or http/sse), as shipped by an external plugin. */
export interface ExternalServer {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: string // "stdio" | "http" | "sse"
  url?: string
}

/** The engine's MCP entry format (as used in fabula.config.json → mcp). */
export type EngineServer =
  | { type: "local"; command: string[]; environment?: Record<string, string>; enabled: boolean }
  | { type: "remote"; url: string; enabled: boolean }

/** Replace ${CLAUDE_PLUGIN_ROOT} / ${FABULA_PLUGIN_ROOT} (and $CLAUDE_PLUGIN_ROOT forms) with `root`. */
export function interpolateRoot(value: string, root: string): string {
  return value
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root)
    .replace(/\$\{FABULA_PLUGIN_ROOT\}/g, root)
    .replace(/\$CLAUDE_PLUGIN_ROOT\b/g, root)
    .replace(/\$FABULA_PLUGIN_ROOT\b/g, root)
}

function interpObj<T>(v: T, root: string): T {
  if (typeof v === "string") return interpolateRoot(v, root) as any
  if (Array.isArray(v)) return v.map((x) => interpObj(x, root)) as any
  if (v && typeof v === "object") {
    const o: any = {}
    for (const [k, val] of Object.entries(v)) o[k] = interpObj(val, root)
    return o
  }
  return v
}

/** Convert one external MCP server entry into the engine's format, resolving ${...ROOT}. */
export function toEngineServer(server: ExternalServer, root: string): EngineServer | null {
  const s = interpObj(server, root)
  const kind = (s.type || (s.url ? "http" : "stdio")).toLowerCase()
  if (kind === "http" || kind === "sse") {
    if (!s.url) return null
    return { type: "remote", url: s.url, enabled: true }
  }
  // stdio
  if (!s.command) return null
  const command = [s.command, ...(Array.isArray(s.args) ? s.args : [])]
  const out: EngineServer = { type: "local", command, enabled: true }
  if (s.env && Object.keys(s.env).length) (out as any).environment = s.env
  return out
}

export interface ImportedPlugin {
  name: string
  description: string
  servers: Record<string, EngineServer>
  skillNames: string[] // basenames of skill dirs found under skills/
  warnings: string[]
}

/**
 * Build the import plan from a plugin's parsed manifest + optional .mcp.json + the list of skill dir
 * basenames. Pure — no filesystem access. `root` is the plugin's resolved absolute directory.
 */
export function planImport(
  pluginJson: any,
  mcpJson: any,
  root: string,
  skillDirs: string[] = [],
): ImportedPlugin {
  const warnings: string[] = []
  // sanitize to a safe config-key / skill-namespace: no dots (path-traversal), collapse runs, trim dashes
  const name = (String(pluginJson?.name || "external-plugin").replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-").replace(/^-+|-+$/g, "")) || "external-plugin"
  const description = String(pluginJson?.description || "")

  // MCP servers may live in .mcp.json (standard) or inline under plugin.json.mcpServers.
  const rawServers: Record<string, ExternalServer> = {
    ...(mcpJson?.mcpServers && typeof mcpJson.mcpServers === "object" ? mcpJson.mcpServers : {}),
    ...(pluginJson?.mcpServers && typeof pluginJson.mcpServers === "object" ? pluginJson.mcpServers : {}),
  }
  const servers: Record<string, EngineServer> = {}
  for (const [key, srv] of Object.entries(rawServers)) {
    const eng = toEngineServer(srv, root)
    if (eng) servers[`${name}-${key}`] = eng
    else warnings.push(`skipped MCP server "${key}": no command/url`)
  }

  return { name, description, servers, skillNames: skillDirs.slice(), warnings }
}

/**
 * Merge imported servers into a config object's `mcp` map. Idempotent: re-importing overwrites the
 * same keys instead of duplicating. Returns a NEW config object (does not mutate the input).
 */
export function mergeMcp(config: any, servers: Record<string, EngineServer>): any {
  const next = { ...(config || {}) }
  next.mcp = { ...(config?.mcp || {}) }
  for (const [key, srv] of Object.entries(servers)) next.mcp[key] = srv
  return next
}

/** A suggested plugin/lib/manifest.ts entry for the imported plugin (npm/system deps are the user's). */
export function manifestEntryFor(plugin: ImportedPlugin, root: string): Record<string, any> {
  return {
    id: plugin.name,
    file: `(external: ${root})`,
    name: plugin.description ? plugin.description.slice(0, 40) : plugin.name,
    defaultEnabled: true,
    description: plugin.description || `Imported external plugin ${plugin.name}`,
    tools: [],
    external: true,
    mcpKeys: Object.keys(plugin.servers),
    skills: plugin.skillNames,
  }
}
