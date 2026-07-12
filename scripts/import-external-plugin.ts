#!/usr/bin/env bun
// Import an external agent-plugin bundle into FABULA (the portable plugin format used across the
// ecosystem). Reads <dir>/.claude-plugin/plugin.json (+ a sibling .mcp.json or an inline mcpServers),
// maps its MCP servers into fabula.config.json → mcp (resolving the plugin-root vars
// ${CLAUDE_PLUGIN_ROOT}/${FABULA_PLUGIN_ROOT}), and links its skills into .fabula/skills. The dotted
// path and env-var names above are the external format's own contract strings — kept verbatim so
// existing bundles import unchanged.
// Idempotent (re-import overwrites the same keys). Pure mapping lives in plugin/lib/pluginimport.ts.
//
//   bun scripts/import-external-plugin.ts <plugin-dir> [--dry-run] [--config <path>]
//
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, cpSync } from "node:fs"
import * as path from "node:path"
import { planImport, mergeMcp, manifestEntryFor } from "../plugin/lib/pluginimport"

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith("--")))
const pos = argv.filter((a) => !a.startsWith("--"))
const dir = pos[0]
const dryRun = flags.has("--dry-run")
const REPO = path.resolve(import.meta.dir, "..")
const configPath = (() => {
  const i = argv.indexOf("--config")
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1])
  return process.env.MIMOCODE_CONFIG || path.join(REPO, "fabula.config.json")
})()

function die(msg: string): never { console.error(`import-external-plugin: ${msg}`); process.exit(1) }

if (!dir) die("usage: import-external-plugin.ts <plugin-dir> [--dry-run] [--config <path>]")
const root = path.resolve(dir)
if (!existsSync(root)) die(`plugin dir not found: ${root}`)

const manifestPath = path.join(root, ".claude-plugin", "plugin.json")
if (!existsSync(manifestPath)) die(`no .claude-plugin/plugin.json in ${root}`)

let pluginJson: any = {}
try { pluginJson = JSON.parse(readFileSync(manifestPath, "utf8")) } catch (e: any) { die(`bad plugin.json: ${e.message}`) }

let mcpJson: any = {}
const mcpPath = path.join(root, ".mcp.json")
if (existsSync(mcpPath)) { try { mcpJson = JSON.parse(readFileSync(mcpPath, "utf8")) } catch (e: any) { die(`bad .mcp.json: ${e.message}`) } }

// discover skill dirs (skills/<name>/SKILL.md)
const skillsRoot = path.join(root, "skills")
let skillDirs: string[] = []
if (existsSync(skillsRoot)) {
  skillDirs = readdirSync(skillsRoot).filter((n) => {
    try { return statSync(path.join(skillsRoot, n)).isDirectory() && existsSync(path.join(skillsRoot, n, "SKILL.md")) }
    catch { return false }
  })
}

const plan = planImport(pluginJson, mcpJson, root, skillDirs)

console.log(`\nPlugin:      ${plan.name}${plan.description ? "  — " + plan.description : ""}`)
console.log(`Root:        ${root}`)
console.log(`MCP servers: ${Object.keys(plan.servers).length ? Object.keys(plan.servers).join(", ") : "(none)"}`)
console.log(`Skills:      ${plan.skillNames.length ? plan.skillNames.join(", ") : "(none)"}`)
for (const w of plan.warnings) console.log(`  ⚠ ${w}`)
console.log(`\nSuggested manifest entry (plugin/lib/manifest.ts):`)
console.log(JSON.stringify(manifestEntryFor(plan, root), null, 2))

if (dryRun) { console.log("\n(--dry-run: no files written)"); process.exit(0) }

// 1) merge MCP servers into the engine config
if (Object.keys(plan.servers).length) {
  let config: any = {}
  if (existsSync(configPath)) { try { config = JSON.parse(readFileSync(configPath, "utf8")) } catch (e: any) { die(`cannot read config ${configPath}: ${e.message}`) } }
  const next = mergeMcp(config, plan.servers)
  writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n")
  console.log(`\n✓ merged ${Object.keys(plan.servers).length} MCP server(s) into ${configPath}`)
}

// 2) link skills into .fabula/skills (skip existing; idempotent)
if (plan.skillNames.length) {
  const dest = process.env.FABULA_SKILLS_DIR || path.join(REPO, ".fabula", "skills")
  mkdirSync(dest, { recursive: true })
  let copied = 0
  for (const name of plan.skillNames) {
    const to = path.join(dest, name)
    if (existsSync(to)) { console.log(`  • skill "${name}" already present — skipped`); continue }
    cpSync(path.join(skillsRoot, name), to, { recursive: true })
    copied++
  }
  console.log(`✓ imported ${copied} skill(s) into ${dest}`)
}

console.log(`\nDone. Restart the engine (⌘⌥R / Restart Server) to load the imported MCP servers.`)
