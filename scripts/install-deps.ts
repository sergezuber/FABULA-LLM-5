#!/usr/bin/env bun
// FABULA-LLM-5 — dependency installer. Reads plugin/lib/manifest.ts (the single source of truth),
// checks every plugin's dependencies, and installs the missing ones. Ships with the app and is called
// from app/build.sh; can also be run any time the user wants to (re)install deps.
//
// Usage:
//   bun scripts/install-deps.ts            # report status; install missing REQUIRED deps
//   bun scripts/install-deps.ts --all      # also install missing OPTIONAL deps
//   bun scripts/install-deps.ts --list     # report only, install nothing
//   bun scripts/install-deps.ts --plugin=multimodal   # scope to one plugin
//   bun scripts/install-deps.ts --yes      # non-interactive (assume yes)

import { MANIFEST, allDeps, pluginById, type Dep } from "../plugin/lib/manifest"
import { checkDep, installDep } from "../plugin/lib/manage"

const args = process.argv.slice(2)
const LIST = args.includes("--list")
const ALL = args.includes("--all")
const onlyId = args.find((a) => a.startsWith("--plugin="))?.split("=")[1]

// --md: print the dependency reference as markdown (source for DEPENDENCIES.md) and exit. No system checks.
if (args.includes("--md")) {
  const L: string[] = [
    "# FABULA-LLM-5 — dependencies",
    "",
    "Auto-generated from [`plugin/lib/manifest.ts`](plugin/lib/manifest.ts) (the single source of truth).",
    "Regenerate: `bun scripts/install-deps.ts --md > DEPENDENCIES.md`.",
    "",
    "Install everything missing: `bun scripts/install-deps.ts --all` (or `./setup.sh`). Install one plugin's deps:",
    "`bun scripts/install-deps.ts --plugin=<id>`, or the in-app `install_plugin_deps` tool. Toggle plugins with the",
    "in-app `enable_plugin` / `disable_plugin` tools (or `FABULA_DISABLE=id1,id2`).",
    "",
  ]
  for (const m of MANIFEST) {
    L.push(`## ${m.id} — ${m.name}${m.core ? " · core" : ""}`, "", m.description, "")
    if (m.tools.length) L.push(`**Tools:** ${m.tools.map((t) => "`" + t + "`").join(", ")}`, "")
    L.push("| Dependency | Kind | Required | Purpose | Install / note |", "|---|---|---|---|---|")
    for (const d of m.deps) L.push(`| ${d.name} | ${d.kind} | ${d.required ? "**yes**" : "optional"} | ${d.purpose} | ${d.install ? "`" + d.install + "`" : d.note || "—"} |`)
    L.push("")
  }
  console.log(L.join("\n"))
  process.exit(0)
}

const C = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" }

function depList(): Dep[] {
  if (onlyId) {
    const p = pluginById(onlyId)
    if (!p) { console.error(`No plugin "${onlyId}". Ids: ${MANIFEST.map((m) => m.id).join(", ")}`); process.exit(1) }
    // dedupe within the plugin
    const seen = new Set<string>(); const out: Dep[] = []
    for (const d of p.deps) { const k = `${d.kind}:${d.name}`; if (!seen.has(k)) { seen.add(k); out.push(d) } }
    return out
  }
  return allDeps()
}

const deps = depList()
console.log(`${C.b}FABULA-LLM-5 — dependencies${C.x}${onlyId ? ` (plugin: ${onlyId})` : ""}\n`)

// 1) check everything
const statuses = await Promise.all(deps.map(checkDep))
const present = statuses.filter((s) => s.present)
const missing = statuses.filter((s) => !s.present)

for (const s of statuses) {
  const tag = s.present ? `${C.g}✓ present${C.x}` : s.dep.required ? `${C.r}✗ MISSING (required)${C.x}` : `${C.y}○ missing (optional)${C.x}`
  console.log(`  ${tag}  ${C.b}${s.dep.name}${C.x} ${C.d}[${s.dep.kind}] — ${s.dep.purpose}${C.x}`)
  if (!s.present && s.dep.note) console.log(`        ${C.d}${s.dep.note}${C.x}`)
}
console.log(`\n  ${present.length} present, ${missing.length} missing (${missing.filter((m) => m.dep.required).length} required).\n`)

if (LIST) process.exit(missing.some((m) => m.dep.required) ? 1 : 0)

// 2) install missing (required always; optional only with --all). Dedupe by install command.
const toInstall = missing.filter((m) => m.dep.install && (m.dep.required || ALL))
const skippedOptional = missing.filter((m) => !m.dep.required && !ALL && m.dep.install)
const manual = missing.filter((m) => !m.dep.install)

const ranCmds = new Set<string>()
let failed = 0
for (const m of toInstall) {
  if (ranCmds.has(m.dep.install!)) continue // e.g. all npm share `cd plugin && bun install`
  ranCmds.add(m.dep.install!)
  console.log(`${C.b}→ installing:${C.x} ${m.dep.name}  ${C.d}(${m.dep.install})${C.x}`)
  const r = await installDep(m.dep)
  console.log(r.ok ? `  ${C.g}✓ done${C.x}` : `  ${C.r}✗ failed${C.x}\n${C.d}${r.out.slice(-500)}${C.x}`)
  if (!r.ok) failed++
}

if (skippedOptional.length) {
  console.log(`\n${C.y}Optional (not installed — run with --all, or per-plugin install_plugin_deps):${C.x}`)
  for (const m of skippedOptional) console.log(`  ○ ${m.dep.name} ${C.d}— ${m.dep.install}${C.x}`)
}
if (manual.length) {
  console.log(`\n${C.y}Manual / built-in (no auto-install):${C.x}`)
  for (const m of manual) console.log(`  • ${m.dep.name} ${C.d}— ${m.dep.note || m.dep.purpose}${C.x}`)
}

console.log(`\n${failed === 0 ? C.g + "✓ dependency install complete" : C.r + `✗ ${failed} install(s) failed`}${C.x}`)
process.exit(failed === 0 ? 0 : 1)
