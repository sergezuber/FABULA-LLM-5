import { readFileSync } from "node:fs"
import path from "node:path"
import solidPlugin from "vite-plugin-solid"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

// FABLE: compile Tailwind v4 ourselves instead of via @tailwindcss/vite. In this toolchain the
// @tailwindcss/vite plugin's transform never fires (verified under BOTH vite 6 and 7), so vite
// inlines the raw cross-package `@import "@mimo-ai/ui/styles/tailwind"` (with the v4 `source(...)`
// directive) and its postcss parser dies with "Missed semicolon". We intercept the entry CSS in an
// enforce:"pre" transform — before vite touches it — and run the Tailwind compiler directly
// (@tailwindcss/node, proven healthy by a standalone compile), so vite only ever sees finished CSS.
// Tailwind scans this dir for class names — the monorepo `packages/` root, matching the
// `source("../../../../")` directive in @mimo-ai/ui's tailwind entry. compiler.sources comes back
// empty when the entry is compiled from a string (the source() auto-detection doesn't fire), so we
// hand the scanner this explicit root.
const SCAN_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..")

function fableTailwind() {
  return {
    name: "fable-tailwind",
    enforce: "pre",
    async transform(code, id) {
      const file = id.split("?")[0]
      if (!file.endsWith(".css")) return
      if (!/@import\s+["'][^"']*tailwind/.test(code) && !/@tailwind\b/.test(code)) return
      const compiler = await compile(code, { base: path.dirname(file), onDependency() {} })
      // Scope to the UI packages (app + ui). The upstream `source("../../../../")` scans ALL of
      // packages/, which drags in junk arbitrary-property candidates from non-UI code (e.g. the
      // string "[data-url:mime[:filename]]" in packages/plugin) that compile to invalid CSS and
      // crash vite's postcss pass. app + ui is everything this bundle actually renders.
      const sources = compiler.sources.length
        ? compiler.sources
        : [{ base: SCAN_ROOT, pattern: "{app,ui}/src/**/*.{ts,tsx,js,jsx,html,svg}", negated: false }]
      const scanner = new Scanner({ sources })
      return { code: compiler.build(scanner.scan()), map: null }
    },
  }
}

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "opencode-desktop:theme-preload",
    transformIndexHtml(html) {
      return html.replace(
        '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
        `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  fableTailwind(),
  solidPlugin(),
]
