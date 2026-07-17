// FABULA-LLM-5 — plugin manager (separate plugin per rule #4). The user-facing control surface for the
// whole plugin/dependency system: list status + dep health, enable/disable any plugin, and install a
// plugin's missing dependencies on demand — at any stage (before, during, or long after install).
// This plugin is NOT self-gated: it must stay available so the user can re-enable others.

import { tool } from "@mimo-ai/plugin"
import type { Plugin } from "@mimo-ai/plugin"
import { MANIFEST, pluginById, checkDep, installDep, pluginStatus, isEnabled, setEnabled } from "./lib/manage"

const z = tool.schema

export const FabulaManage: Plugin = async () => ({
  tool: {
    list_plugins: tool({
      description: "List all FABULA plugins with their enabled/disabled state, the tools each provides, and " +
        "dependency health. Use this to see what is installed, what is on, and what still needs setup.",
      args: {},
      async execute() {
        const out: string[] = ["FABULA plugins (toggle with enable_plugin/disable_plugin, then Restart Server ⌘⇧R):", ""]
        for (const m of MANIFEST) {
          const st = await pluginStatus(m, isEnabled(m.id))
          const flag = st.enabled ? "● ON " : "○ off"
          const health = st.missingRequired.length
            ? `⚠ MISSING required: ${st.missingRequired.join(", ")} (install_plugin_deps ${m.id})`
            : st.missingOptional.length ? `optional missing: ${st.missingOptional.join(", ")}` : "deps ok"
          out.push(`${flag}  ${m.id.padEnd(14)} ${m.name} — ${m.tools.length} tool(s) — ${health}`)
        }
        return out.join("\n")
      },
    }),

    check_deps: tool({
      description: "Check dependency health for one plugin (by id) or all plugins. Reports each dependency as " +
        "present/missing (required vs optional) and the command to install it.",
      args: { plugin: z.string().nullish().describe("plugin id, or omit for all plugins") },
      async execute(args: any) {
        const metas = args.plugin ? ([pluginById(args.plugin)].filter(Boolean) as any[]) : MANIFEST
        if (args.plugin && !metas.length) return `No plugin "${args.plugin}". Ids: ${MANIFEST.map((m) => m.id).join(", ")}`
        const out: string[] = []
        for (const m of metas) {
          out.push(`## ${m.id} — ${m.name}${isEnabled(m.id) ? " (on)" : " (off)"}`)
          for (const d of m.deps) {
            const s = await checkDep(d)
            const mark = s.present ? "✓" : d.required ? "✗ MISSING(required)" : "○ missing(optional)"
            out.push(`  ${mark} ${d.name} [${d.kind}] — ${d.purpose}` + (!s.present && d.install ? `\n      install: ${d.install}` : !s.present && d.note ? `\n      ${d.note}` : ""))
          }
        }
        return out.join("\n")
      },
    }),

    install_plugin_deps: tool({
      description: "Install a plugin's MISSING dependencies on this machine (runs the manifest install commands). " +
        "Ask the user before running. Required deps are always installed; optional ones unless include_optional=false.",
      args: {
        plugin: z.string().describe("plugin id"),
        include_optional: z.boolean().nullish().describe("also install optional deps (default true)"),
      },
      async execute(args: any) {
        const m = pluginById(args.plugin)
        if (!m) return `No plugin "${args.plugin}". Ids: ${MANIFEST.map((x) => x.id).join(", ")}`
        const inclOpt = args.include_optional !== false
        const out: string[] = [`Installing dependencies for "${m.id}" — ${m.name}:`]
        const ran = new Set<string>()
        let failed = 0
        for (const d of m.deps) {
          const s = await checkDep(d)
          if (s.present) { out.push(`  ✓ ${d.name} already present`); continue }
          if (!d.required && !inclOpt) { out.push(`  ○ ${d.name} (optional) — skipped`); continue }
          if (!d.install || d.manual) { out.push(`  • ${d.name} — manual step: ${d.install || d.note || d.purpose}`); continue }
          if (ran.has(d.install)) continue
          ran.add(d.install)
          out.push(`  → ${d.name}: ${d.install}`)
          const r = await installDep(d)
          out.push(r.ok ? "    ✓ done" : `    ✗ failed: ${r.out.slice(-200)}`)
          if (!r.ok) failed++
        }
        out.push("", failed === 0 ? "✓ done. Restart Server (⌘⇧R) so the plugin picks up its new deps." : `⚠ ${failed} install(s) failed — see output above.`)
        return out.join("\n")
      },
    }),

    enable_plugin: tool({
      description: "Enable a FABULA plugin so it loads on the next Restart Server (⌘⇧R).",
      args: { plugin: z.string().describe("plugin id") },
      async execute(args: any) {
        if (!pluginById(args.plugin)) return `No plugin "${args.plugin}". Ids: ${MANIFEST.map((m) => m.id).join(", ")}`
        setEnabled(args.plugin, true)
        return `Enabled "${args.plugin}". Restart the server (⌘⇧R) to load it.`
      },
    }),

    disable_plugin: tool({
      description: "Disable a FABULA plugin so it stops loading on the next Restart Server (⌘⇧R). The plugin " +
        "manager itself cannot be disabled.",
      args: { plugin: z.string().describe("plugin id") },
      async execute(args: any) {
        if (args.plugin === "manage") return "The plugin manager ('manage') cannot disable itself."
        if (!pluginById(args.plugin)) return `No plugin "${args.plugin}". Ids: ${MANIFEST.map((m) => m.id).join(", ")}`
        setEnabled(args.plugin, false)
        return `Disabled "${args.plugin}". Restart the server (⌘⇧R) to apply. Re-enable any time with enable_plugin.`
      },
    }),
  },
})
