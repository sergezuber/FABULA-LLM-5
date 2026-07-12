// Context OS Phase 1 — the CLOSED belt-profile registry + tool cards for routing (design §4/§7).
// Profiles are HIDE-deltas (deny-lists): unknown/new tools stay visible by construction, and the
// visible sets NEST (coding subset of full), so a profile switch re-prefills only the delta (design K3).
// Cards feed the BM25/RRF router; MCP servers are represented as ONE card per server and hidden
// via server globs — the engine masks both `server:tool` and `server_tool` key forms.

import { readFileSync } from "node:fs"
import { codingMask, ALWAYS_ON } from "./toolbelt"
import { TOOL_META } from "./toolmeta"
import { GATE_REQUIRED_TOOLS } from "./toolusage"
import type { ToolCard } from "./toolrouter"

/** Engine builtin tools (stable ids) with routing utterances for the head of the distribution.
 *  Kept curated — the engine registry can't be enumerated from plugin land at load time. */
export const ENGINE_BUILTIN_CARDS: ToolCard[] = [
  { id: "bash", description: "Run a shell command", params: ["command"], tags: ["code"], utterances: ["запусти команду", "собери проект", "прогони тесты", "запусти тесты", "run the build", "run tests", "execute a command"] },
  { id: "edit", description: "Edit a file by exact replacement", params: ["file_path", "old_string", "new_string"], tags: ["files", "code"], utterances: ["поправь файл", "исправь код", "почини баг", "исправь ошибку", "edit the file", "fix the bug", "fix the code"] },
  { id: "read", description: "Read a file", params: ["file_path"], tags: ["files"], utterances: ["прочитай файл", "покажи код", "изучи код", "read the file"] },
  { id: "write", description: "Write/create a file", params: ["file_path", "content"], tags: ["files"], utterances: ["создай файл", "запиши в файл", "create a file"] },
  { id: "grep", description: "Search file contents by regex", params: ["pattern"], tags: ["files", "code"], utterances: ["найди в коде", "поищи по файлам", "search the codebase"] },
  { id: "glob", description: "Find files by name pattern", params: ["pattern"], tags: ["files"], utterances: ["найди файлы", "list files matching"] },
  { id: "task", description: "Spawn a subagent for a subtask", params: ["prompt"], tags: ["agents"], utterances: ["запусти субагента", "делегируй подзадачу"] },
  { id: "skill", description: "Load a skill's full instructions", params: ["name"], tags: ["skills"], utterances: ["загрузи навык"] },
  { id: "webfetch", description: "Fetch a URL", params: ["url"], tags: ["web"], utterances: ["открой ссылку", "fetch this url"] },
]

// ---- MCP servers: names come from the LIVE engine config, never hardcoded (RULE #13 —
// deployments name servers freely, e.g. "code-go-serena" / "web-search-internet"). ----

function configPath(): string {
  if (process.env.MIMOCODE_CONFIG) return process.env.MIMOCODE_CONFIG
  const xdg = process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`
  return `${xdg}/fabula/fabula.config.json`
}

/** MCP server names from the engine config ([] when unreadable — fail open). */
export function mcpServersFromConfig(): string[] {
  try {
    const cfg = JSON.parse(readFileSync(configPath(), "utf8"))
    return Object.keys(cfg?.mcp ?? {})
  } catch {
    return []
  }
}

/** Same sanitize as the engine's mcp key builder. */
export const sanitizeMcpName = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")

/** Classify a server as code-navigation-ish from its NAME tokens (heuristic, documented:
 *  covers serena / ast-grep / structural-search style servers under any deployment name). */
export function isCodeNavServer(name: string): boolean {
  return /serena|ast[-_]?grep|structural|lsp/i.test(name)
}

/** Classify a server as web-ish (kept visible in web-research). */
export function isWebServer(name: string): boolean {
  return /searx|web|search|browser|fetch/i.test(name)
}

/** One routing card per LIVE MCP server; descriptions/utterances derived by kind. */
export function mcpServerCards(servers: string[] = mcpServersFromConfig()): ToolCard[] {
  return servers.map((name) => {
    const id = sanitizeMcpName(name)
    if (isCodeNavServer(name))
      return { id, description: "Code navigation / structural code search across the repo", tags: ["code", "mcp"], utterances: ["найди символ", "кто вызывает функцию", "find references", "структурный поиск по коду"] }
    if (isWebServer(name))
      return { id, description: "Web search / fetch pages from the internet", tags: ["web", "mcp"], utterances: ["поищи в интернете", "найди в сети", "search the web"] }
    return { id, description: `MCP server ${name}`, tags: ["mcp"] }
  })
}

/** All routing cards: engine builtins + plugin tools from TOOL_META (snippet = description) +
 *  MCP servers from the LIVE config. */
export function buildToolCards(servers: string[] = mcpServersFromConfig()): ToolCard[] {
  const pluginCards: ToolCard[] = Object.entries(TOOL_META).map(([id, m]) => ({
    id,
    description: m.snippet ?? "",
    tags: m.coding === false ? ["non-coding"] : ["code"],
  }))
  const engineIds = new Set(ENGINE_BUILTIN_CARDS.map((c) => c.id))
  return [...ENGINE_BUILTIN_CARDS, ...pluginCards.filter((c) => !engineIds.has(c.id)), ...mcpServerCards(servers)]
}

/** Web-relevant tools that the web-research profile KEEPS from the non-coding mask. */
const WEB_KEEP = new Set(["web_fetch", "web_search", "image_search", "weather_fetch", "places_search", "webfetch"])

export type BeltProfile = {
  id: string
  /** exact tool ids this profile hides */
  hideExact: () => string[]
  /** server globs this profile hides (engine masks both `srv:*` and `srv_*` forms);
   *  servers injectable for hermetic tests, defaults to the live config */
  hideGlobs: (servers?: string[]) => string[]
  /** visible ids for router SCORING (nested: coding ⊂ full) */
  visibleForScoring: (cards: readonly ToolCard[], servers?: string[]) => string[]
}

/** The CLOSED profile registry (§4): 3 nested byte-stable profiles. Order matters only for
 *  documentation; selection is score-argmax with widest fallback (= "full"). */
export const BELT_PROFILES: BeltProfile[] = [
  {
    id: "coding",
    // the proven live belt: hide the ~25 non-coding schemas (125→101 measured)
    hideExact: () => codingMask(TOOL_META),
    hideGlobs: () => [],
    visibleForScoring: (cards) => {
      const hide = new Set(codingMask(TOOL_META))
      return cards.map((c) => c.id).filter((id) => !hide.has(id))
    },
  },
  {
    id: "web-research",
    // web tools stay; code-navigation MCP servers hide (a research task reads pages, not ASTs).
    // Server names come from the LIVE config — never hardcoded (deployments name them freely).
    hideExact: () => codingMask(TOOL_META).filter((id) => !WEB_KEEP.has(id)),
    hideGlobs: (servers = mcpServersFromConfig()) =>
      servers
        .filter(isCodeNavServer)
        .map((n) => sanitizeMcpName(n) + "_*")
        .sort(),
    visibleForScoring: (cards, servers = mcpServersFromConfig()) => {
      const hide = new Set(codingMask(TOOL_META).filter((id) => !WEB_KEEP.has(id)))
      for (const n of servers.filter(isCodeNavServer)) hide.add(sanitizeMcpName(n))
      return cards.map((c) => c.id).filter((id) => !hide.has(id))
    },
  },
  {
    id: "full",
    hideExact: () => [],
    hideGlobs: () => [],
    visibleForScoring: (cards) => cards.map((c) => c.id),
  },
]

/** Final hide sets for a profile: never hide gate tools / ALWAYS_ON / verbatim-pinned ids.
 *  `servers` injectable for hermetic tests; defaults to the live config. */
export function hideSetFor(
  profileId: string,
  pinned: readonly string[] = [],
  servers?: string[],
): { exact: string[]; globs: string[] } {
  const p = BELT_PROFILES.find((x) => x.id === profileId)
  if (!p) return { exact: [], globs: [] } // unknown profile → hide nothing (fail open)
  const never = new Set<string>([...GATE_REQUIRED_TOOLS, ...ALWAYS_ON, ...pinned])
  const exact = p.hideExact().filter((id) => !never.has(id))
  // a pinned MCP server id un-hides its glob
  const globs = p.hideGlobs(servers).filter((g) => !pinned.some((pin) => g.startsWith(pin)))
  return { exact: exact.sort(), globs: globs.sort() }
}
