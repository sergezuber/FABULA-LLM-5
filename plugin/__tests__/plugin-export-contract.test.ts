// Suite-wide guard for the plugin-load contract (CLAUDE.md): "Each plugin/fabula-*.ts file exports
// EXACTLY ONE Fabula* factory and nothing else." The engine loader enforces this HARD — getLegacyPlugins()
// iterates Object.values(mod) over EVERY export and applyPlugin() invokes each as `await server(input,
// options)`, throwing on any export that isn't a valid plugin factory. A single stray export therefore
// crashes the whole plugin at load (this is the exact `export { attested }` bug in fabula-witness.ts,
// commit efb5cba: attested(pluginInput) → "entries.some is not a function" → failed to load plugin).
//
// This test imports every fabula-*.ts and asserts its RUNTIME exports are exactly one Fabula* function —
// so a stray helper re-export can never silently ship again on any plugin.
import { test, expect } from "bun:test"
import { readdirSync } from "node:fs"
import * as path from "node:path"

const PLUGIN_DIR = path.resolve(__dirname, "..")
const files = readdirSync(PLUGIN_DIR)
  .filter((f) => /^fabula-.*\.ts$/.test(f) && !f.endsWith(".d.ts") && !f.endsWith(".test.ts"))
  .sort()

test("discovery sanity: we actually found the fabula plugins", () => {
  expect(files.length).toBeGreaterThan(20)
})

test("every fabula-*.ts exports EXACTLY ONE Fabula* factory and nothing else (loader contract)", async () => {
  const violations: string[] = []
  for (const f of files) {
    let mod: Record<string, unknown>
    try {
      mod = (await import(path.join(PLUGIN_DIR, f))) as Record<string, unknown>
    } catch (e: any) {
      violations.push(`${f}: module failed to import — ${e?.message || e}`)
      continue
    }
    // Runtime exports only (TS types are erased). The loader invokes each of these.
    const entries = Object.entries(mod)
    const fnExports = entries.filter(([, v]) => typeof v === "function").map(([k]) => k)
    const nonFnExports = entries.filter(([, v]) => typeof v !== "function").map(([k]) => k)

    if (fnExports.length !== 1 || !/^Fabula/.test(fnExports[0] ?? "")) {
      violations.push(
        `${f}: function exports = [${fnExports.join(", ")}] — must be EXACTLY ONE, named Fabula* ` +
          `(every export is invoked as a plugin factory by the engine loader)`,
      )
    }
    for (const k of nonFnExports) {
      violations.push(`${f}: stray non-function export '${k}' — the loader invokes every export as a plugin`)
    }
  }
  if (violations.length) {
    console.error("Plugin one-export-per-file contract violations:\n" + violations.join("\n"))
  }
  expect(violations).toEqual([])
})
