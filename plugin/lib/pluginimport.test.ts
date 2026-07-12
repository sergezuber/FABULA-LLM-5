// Unit tests for the external-plugin import mapping (lib/pluginimport.ts). Pure, no filesystem.
import { test, expect } from "bun:test"
import { interpolateRoot, toEngineServer, planImport, mergeMcp, manifestEntryFor } from "./pluginimport"

const ROOT = "/home/u/plugins/my-plugin"

test("interpolateRoot resolves both dialects and both ${} / $ forms", () => {
  expect(interpolateRoot("${CLAUDE_PLUGIN_ROOT}/dist/server.js", ROOT)).toBe(`${ROOT}/dist/server.js`)
  expect(interpolateRoot("${FABULA_PLUGIN_ROOT}/x", ROOT)).toBe(`${ROOT}/x`)
  expect(interpolateRoot("$CLAUDE_PLUGIN_ROOT/y", ROOT)).toBe(`${ROOT}/y`)
  expect(interpolateRoot("no vars here", ROOT)).toBe("no vars here")
})

test("toEngineServer: stdio → local with command[] and interpolated args/env", () => {
  const eng = toEngineServer(
    { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/index.js", "--flag"], env: { ROOTVAR: "${CLAUDE_PLUGIN_ROOT}/data" } },
    ROOT,
  ) as any
  expect(eng.type).toBe("local")
  expect(eng.command).toEqual(["node", `${ROOT}/dist/index.js`, "--flag"])
  expect(eng.environment.ROOTVAR).toBe(`${ROOT}/data`)
  expect(eng.enabled).toBe(true)
})

test("toEngineServer: http/sse → remote with url", () => {
  expect(toEngineServer({ type: "http", url: "https://mcp.example.com/" }, ROOT)).toEqual({ type: "remote", url: "https://mcp.example.com/", enabled: true })
  expect(toEngineServer({ url: "https://x/" }, ROOT)).toEqual({ type: "remote", url: "https://x/", enabled: true }) // url implies remote
})

test("toEngineServer: no command and no url → null (skipped)", () => {
  expect(toEngineServer({ env: { A: "1" } }, ROOT)).toBeNull()
})

test("planImport: maps servers from .mcp.json + inline, namespaces by plugin name, records skills", () => {
  const pluginJson = { name: "my-plugin", description: "does things", mcpServers: { inline: { command: "python", args: ["${CLAUDE_PLUGIN_ROOT}/s.py"] } } }
  const mcpJson = { mcpServers: { search: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/search.js"] }, broken: { env: {} } } }
  const plan = planImport(pluginJson, mcpJson, ROOT, ["skill-a", "skill-b"])
  expect(plan.name).toBe("my-plugin")
  expect(Object.keys(plan.servers).sort()).toEqual(["my-plugin-inline", "my-plugin-search"])
  expect((plan.servers["my-plugin-search"] as any).command).toEqual(["node", `${ROOT}/dist/search.js`])
  expect(plan.skillNames).toEqual(["skill-a", "skill-b"])
  expect(plan.warnings.some((w) => w.includes("broken"))).toBe(true) // no command/url → warned
})

test("planImport: sanitizes an unsafe plugin name", () => {
  expect(planImport({ name: "../evil name!" }, {}, ROOT).name).toBe("evil-name") // no dots, collapsed, trimmed
  expect(planImport({ name: "!!!" }, {}, ROOT).name).toBe("external-plugin")     // empty after sanitize → fallback
})

test("mergeMcp is idempotent and non-mutating", () => {
  const cfg = { mcp: { existing: { type: "local", command: ["x"], enabled: true } } }
  const servers = { "p-a": { type: "local", command: ["a"], enabled: true } as any }
  const once = mergeMcp(cfg, servers)
  const twice = mergeMcp(once, servers)
  expect(Object.keys(once.mcp).sort()).toEqual(["existing", "p-a"])
  expect(twice.mcp).toEqual(once.mcp)            // re-import = no duplicate/change
  expect(cfg.mcp).not.toHaveProperty("p-a")      // original untouched
})

test("manifestEntryFor produces an external-flagged entry", () => {
  const plan = planImport({ name: "p", description: "d" }, { mcpServers: { s: { command: "node" } } }, ROOT, ["k"])
  const entry = manifestEntryFor(plan, ROOT)
  expect(entry.id).toBe("p")
  expect(entry.external).toBe(true)
  expect(entry.mcpKeys).toEqual(["p-s"])
  expect(entry.skills).toEqual(["k"])
})
