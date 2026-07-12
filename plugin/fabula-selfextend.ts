// FABULA-LLM-5 — self-extension. The supervised model can grow its OWN supervised tool belt: the
// create_plugin tool scaffolds a new fabula-*.ts plugin from a spec, ENFORCES the one-plugin-per-file
// contract deterministically (RULE #9 — the harness validates, the model never breaks loading), and
// writes it next to the other plugins. Activation is on the next engine start (same model as the
// existing plugin toggles); engine-side hot-reload is a follow-up. Docs for the plugin API live on
// disk (engine self-extend skill) so a LOCAL model needs zero training-data knowledge of the API.
import { tool } from "@mimo-ai/plugin"
import type { Plugin } from "@mimo-ai/plugin"
import { z } from "zod"
import { writeFileSync, existsSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { gate } from "./lib/manage"
import { scaffoldPlugin, validatePluginSource, validateSpec, pluginFileName } from "./lib/selfextend"

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))

export const FabulaSelfExtend: Plugin = async () =>
  gate("selfextend", {
    tool: {
      create_plugin: tool({
        description:
          "Author a NEW FABULA tool/plugin for yourself when a capability is missing. Provide the tool " +
          "name, what it does, and the execute() body (plain TypeScript that ends in `return \"...\"` or " +
          "`return { output: \"...\" }`; `args.input` is your string argument, `ctx.directory` is the cwd). " +
          "The harness validates the one-plugin-per-file contract and writes the plugin; it becomes " +
          "callable after the next engine start. Read the on-disk plugin API docs before using.",
        args: {
          plugin_name: z.string().describe("short human name for the plugin, e.g. 'csv tools'"),
          tool_name: z.string().describe("the tool id you will call, a valid identifier e.g. 'csv_rows'"),
          tool_description: z.string().describe("one line: what the tool does"),
          arg_description: z.string().nullish().describe("what the `input` argument means"),
          body: z.string().describe("the execute() body: TypeScript that returns a string or {output}"),
        },
        async execute(args) {
          const spec = {
            name: args.plugin_name,
            toolName: args.tool_name,
            toolDescription: args.tool_description,
            argDescription: args.arg_description ?? undefined,
            body: args.body,
          }
          const sv = validateSpec(spec)
          if (!sv.ok) return `create_plugin rejected: ${sv.errors.join("; ")}`
          const src = scaffoldPlugin(spec)
          const pv = validatePluginSource(src)
          if (!pv.ok) return `create_plugin rejected (contract): ${pv.errors.join("; ")}`
          const file = pluginFileName(args.plugin_name)
          const dest = path.join(PLUGIN_DIR, file)
          if (existsSync(dest)) return `create_plugin: ${file} already exists — pick another plugin_name or edit it directly.`
          try {
            writeFileSync(dest, src)
          } catch (e: any) {
            return `create_plugin: could not write ${dest}: ${e?.message ?? e}`
          }
          return {
            output:
              `Created ${file} exposing the ${args.tool_name} tool. It passed the one-plugin-per-file ` +
              `contract check and will be callable after the next engine start (restart the app / server). ` +
              `Path: ${dest}`,
            metadata: { file, path: dest, tool: args.tool_name },
          }
        },
      }),
    },
  })
