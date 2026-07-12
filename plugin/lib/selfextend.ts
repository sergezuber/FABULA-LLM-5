// Self-extension core (pure, unit-testable): scaffold a NEW fabula plugin from a spec and validate it
// against the one-plugin-per-file contract BEFORE it is written. This is the RULE #9 way to let the
// supervised model grow its own supervised tool belt: the harness scaffolds + enforces the contract
// deterministically, so a malformed self-written plugin can never break loading. The plugin file it
// produces is a valid `Fabula*` factory exporting exactly one tool; the model supplies the execute body.

export function slug(name: string): string {
  const s = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  return s || "custom"
}

export function pluginFileName(name: string): string {
  return `fabula-${slug(name)}.ts`
}

export function factoryName(name: string): string {
  const pascal = slug(name).split("-").filter(Boolean).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("")
  return `Fabula${pascal || "Custom"}`
}

export interface ScaffoldSpec {
  name: string          // plugin name, e.g. "csv tools"
  toolName: string      // tool id the model will call, e.g. "csv_stats"
  toolDescription: string
  argDescription?: string
  body: string          // the execute() body the model supplies; must `return` a string or {output}
}

const IDENT = /^[a-z_][a-z0-9_]*$/i

export function scaffoldPlugin(spec: ScaffoldSpec): string {
  const factory = factoryName(spec.name)
  const tn = spec.toolName
  const desc = JSON.stringify(spec.toolDescription || tn)
  const argDesc = JSON.stringify(spec.argDescription || "input for this tool")
  return `// FABULA self-authored plugin: ${slug(spec.name)}. One Fabula* factory, one tool (one-plugin-per-file rule).
import { tool } from "@mimo-ai/plugin"
import type { Plugin } from "@mimo-ai/plugin"
import { z } from "zod"

export const ${factory}: Plugin = async () => ({
  tool: {
    ${tn}: tool({
      description: ${desc},
      args: { input: z.string().describe(${argDesc}) },
      async execute(args: { input: string }, ctx: any) {
${spec.body.split("\n").map((l) => "        " + l).join("\n")}
      },
    }),
  },
})
`
}

export interface Validation { ok: boolean; errors: string[] }

/** Enforce the one-plugin-per-file contract on a plugin source string. */
export function validatePluginSource(src: string): Validation {
  const errors: string[] = []
  const exports = [...String(src).matchAll(/^export\s+(?:const|function|class)\s+(\w+)/gm)].map((m) => m[1])
  if (exports.length === 0) errors.push("no top-level export found — a plugin file must export one Fabula* factory")
  if (exports.length > 1) errors.push(`must export EXACTLY one symbol (mimo runs every export as a plugin); found ${exports.length}: ${exports.join(", ")}`)
  if (exports.length === 1 && !/^Fabula/.test(exports[0])) errors.push(`the single export must be named Fabula* (got "${exports[0]}")`)
  return { ok: errors.length === 0, errors }
}

/** Validate a spec before scaffolding (identifiers, non-empty body). */
export function validateSpec(spec: ScaffoldSpec): Validation {
  const errors: string[] = []
  if (!spec.name || !slug(spec.name)) errors.push("name is required")
  if (!spec.toolName || !IDENT.test(spec.toolName)) errors.push("toolName must be a valid identifier (letters/digits/underscore)")
  if (!spec.body || !/\breturn\b/.test(spec.body)) errors.push("body must contain a `return` (a string or an {output} object)")
  return { ok: errors.length === 0, errors }
}
