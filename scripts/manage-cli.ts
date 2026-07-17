#!/usr/bin/env bun
// FABULA-LLM-5 — plugin management CLI. Backs both the in-app Plugins page (via the Swift bridge) and the
// terminal. Mirrors the fabula-manage tools. Reads plugin/lib/manifest.ts (the source of truth).
//
//   bun scripts/manage-cli.ts list [--json]          # status + dep health of every plugin
//   bun scripts/manage-cli.ts enable  <id>
//   bun scripts/manage-cli.ts disable <id>
//   bun scripts/manage-cli.ts install <id> [--required-only]
//   bun scripts/manage-cli.ts check   <id|all>

import { MANIFEST, pluginById, isEnabled, setEnabled, pluginStatus, checkDep, installDep } from "../plugin/lib/manage"
import { PLUGIN_I18N } from "../plugin/lib/i18n"

// Merge each plugin's manifest name/description with its localized name + human "what it's for" text,
// plus its capability tags (the same vocabulary as the session timeline and the README plugins table).
const tr = (id: string, name: string, desc: string) => {
  const t = PLUGIN_I18N[id]
  return { name, nameRu: t?.nameRu || name, description: t?.descEn || desc, descRu: t?.descRu || desc, tags: t?.tags ?? [] }
}

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith("--")))
const pos = argv.filter((a) => !a.startsWith("--"))
const cmd = pos[0], arg = pos[1]

async function listJson() {
  const plugins = await Promise.all(MANIFEST.map(async (m) => {
    const st = await pluginStatus(m, isEnabled(m.id))
    return {
      id: m.id, ...tr(m.id, m.name, m.description), file: m.file, core: !!m.core, enabled: st.enabled,
      tools: m.tools,
      deps: st.deps.map((d) => ({ name: d.dep.name, kind: d.dep.kind, required: d.dep.required, present: d.present, install: d.dep.install || null, purpose: d.dep.purpose })),
      missingRequired: st.missingRequired, missingOptional: st.missingOptional,
    }
  }))
  return { plugins }
}

switch (cmd) {
  case "list": {
    if (flags.has("--fast")) {
      // id/name/enabled only — no dependency shell-checks (instant; used to build the app's Plugins menu).
      const plugins = MANIFEST.map((m) => ({ id: m.id, ...tr(m.id, m.name, m.description), core: !!m.core, enabled: isEnabled(m.id), tools: m.tools.length }))
      console.log(JSON.stringify({ plugins }))
      break
    }
    const data = await listJson()
    if (flags.has("--json")) { console.log(JSON.stringify(data)); break }
    for (const p of data.plugins) {
      const dep = p.missingRequired.length ? `⚠ missing required: ${p.missingRequired.join(", ")}`
        : p.missingOptional.length ? `optional missing: ${p.missingOptional.join(", ")}` : "deps ok"
      console.log(`${p.enabled ? "● ON " : "○ off"}  ${p.id.padEnd(14)} ${p.name} — ${p.tools.length} tool(s) — ${dep}`)
    }
    break
  }
  case "enable":
  case "disable": {
    if (!arg || !pluginById(arg)) { console.error(JSON.stringify({ ok: false, error: `unknown plugin "${arg}"` })); process.exit(1) }
    if (cmd === "disable" && arg === "manage") { console.error(JSON.stringify({ ok: false, error: "the manager cannot disable itself" })); process.exit(1) }
    setEnabled(arg, cmd === "enable")
    console.log(JSON.stringify({ ok: true, id: arg, enabled: cmd === "enable", restart: "Restart Server (⌘⇧R) to apply" }))
    break
  }
  case "install": {
    const m = pluginById(arg)
    if (!m) { console.error(JSON.stringify({ ok: false, error: `unknown plugin "${arg}"` })); process.exit(1) }
    const inclOpt = !flags.has("--required-only")
    const log: string[] = []
    const ran = new Set<string>(); let failed = 0
    for (const d of m.deps) {
      const s = await checkDep(d)
      if (s.present) { log.push(`✓ ${d.name} present`); continue }
      if (!d.required && !inclOpt) { log.push(`○ ${d.name} optional skipped`); continue }
      if (!d.install || d.manual) { log.push(`• ${d.name} manual: ${d.install || d.note || d.purpose}`); continue }
      if (ran.has(d.install)) continue
      ran.add(d.install)
      log.push(`→ ${d.name}: ${d.install}`)
      const r = await installDep(d)
      log.push(r.ok ? `  ✓ done` : `  ✗ failed`)
      if (!r.ok) failed++
    }
    console.log(JSON.stringify({ ok: failed === 0, id: m.id, log, failed }))
    break
  }
  case "check": {
    const metas = !arg || arg === "all" ? MANIFEST : [pluginById(arg)].filter(Boolean) as any[]
    const out: any = {}
    for (const m of metas) out[m.id] = await Promise.all(m.deps.map(async (d) => ({ name: d.name, present: (await checkDep(d)).present, required: d.required, install: d.install || null })))
    console.log(JSON.stringify(out))
    break
  }
  case "pmode": {
    // get/set the permission mode (Item 6/7) — backs the in-app permission-mode picker.
    const { permissionMode, setPermissionMode } = await import("../plugin/lib/permissions")
    if (arg) { const r = setPermissionMode(arg); if (!r.ok) { console.error(JSON.stringify(r)); process.exit(1) } }
    console.log(JSON.stringify({ mode: permissionMode() }))
    break
  }
  default:
    console.error("usage: manage-cli.ts list [--json] | enable <id> | disable <id> | install <id> [--required-only] | check <id|all> | pmode [mode]")
    process.exit(1)
}
