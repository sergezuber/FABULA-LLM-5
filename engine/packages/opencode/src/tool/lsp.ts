import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import path from "path"
import { LSP } from "../lsp"
import DESCRIPTION from "./lsp.txt"
import { Instance } from "../project/instance"
import { pathToFileURL } from "url"
import { assertExternalDirectoryEffect } from "./external-directory"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

export const LspTool = Tool.define(
  "lsp",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        operation: z.enum(operations).describe("The LSP operation to perform"),
        // OPTIONAL, because `workspaceSymbol` is a search ACROSS the workspace and has no position in it.
        // MEASURED live 2026-08-01 through the running app: asked for workspaceSymbol the model's first
        // call was refused with "expected string, received undefined → at file_path" and its second had
        // to invent a file (it passed the workspace DIRECTORY and line 1, character 1), which then failed
        // "No LSP server available for this file type" — a directory has no file type. Every other
        // operation is positional and still requires all three; this one never could use them.
        file_path: z.string().optional().describe("The absolute or relative path to the file (all operations EXCEPT workspaceSymbol)"),
        line: z.number().int().min(1).optional().describe("The line number (1-based, as shown in editors)"),
        character: z.number().int().min(1).optional().describe("The character offset (1-based, as shown in editors)"),
        // MEASURED 2026-08-01: `workspaceSymbol` called `lsp.workspaceSymbol("")` — a HARDCODED empty
        // query — and the schema had no field in which a caller could say what to look for. So the one
        // operation whose entire purpose is "find this symbol by name" could not be told a name, and
        // answered with whatever an empty query returns. Symbol search across a workspace is the exact
        // capability the posture nudge steers the model toward instead of grepping.
        query: z
          .string()
          .optional()
          .describe("For workspaceSymbol ONLY: the symbol name to search for across the workspace"),
      }),
      execute: (
        args: {
          operation: (typeof operations)[number]
          file_path?: string
          line?: number
          character?: number
          query?: string
        },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "lsp", patterns: ["*"], always: ["*"], metadata: {} })

          // A WORKSPACE search asks the workspace, not a file. It takes no position, needs no file to
          // exist, and must not be gated on "an LSP server for this file type" — there is no file.
          if (args.operation === "workspaceSymbol") {
            const query = (args.query ?? "").trim()
            if (!query) throw new Error("workspaceSymbol needs a `query`: the symbol name to search for.")
            // A language server starts on FIRST USE of a file, and a workspace search touches no file —
            // so on a cold session there is nothing to ask, and `workspace/symbol` over an empty client
            // list returns [] . That is indistinguishable from "no such symbol", which is exactly the
            // defect this operation is being repaired for. `file_path` is accepted here as an optional
            // HINT: naming any source file starts the right server for that language, after which the
            // search is real. Measured live 2026-08-01 — cold, this answered "no match" for a symbol
            // that was in the workspace.
            if (args.file_path) {
              const hint = path.isAbsolute(args.file_path) ? args.file_path : path.join(Instance.directory, args.file_path)
              yield* assertExternalDirectoryEffect(ctx, hint)
              if (yield* fs.existsSafe(hint)) yield* lsp.touchFile(hint, true)
            }
            const running = yield* lsp.status()
            if (!running.length) {
              return {
                title: `workspaceSymbol ${query}`,
                metadata: { result: [] },
                output:
                  `No language server is running for this workspace yet, so nothing could be searched — ` +
                  `this is NOT "the symbol does not exist". A server starts on first use of a file: read ` +
                  `one source file of the language you are searching, or call this again with ` +
                  `\`file_path\` naming any file of that language, then retry.`,
              }
            }
            const found: unknown[] = yield* lsp.workspaceSymbol(query)
            return {
              title: `workspaceSymbol ${query}`,
              metadata: { result: found },
              output: found.length
                ? JSON.stringify(found, null, 2)
                : `No workspace symbol matches ${JSON.stringify(query)} (${running.length} language server(s) were asked).`,
            }
          }

          if (!args.file_path) throw new Error(`${args.operation} needs a \`file_path\`.`)
          if (args.line === undefined || args.character === undefined) {
            throw new Error(`${args.operation} needs \`line\` and \`character\` (1-based, as shown in editors).`)
          }
          const file = path.isAbsolute(args.file_path) ? args.file_path : path.join(Instance.directory, args.file_path)
          yield* assertExternalDirectoryEffect(ctx, file)

          const uri = pathToFileURL(file).href
          const position = { file, line: args.line - 1, character: args.character - 1 }
          const relPath = path.relative(Instance.worktree, file)
          const title = `${args.operation} ${relPath}:${args.line}:${args.character}`

          const exists = yield* fs.existsSafe(file)
          if (!exists) throw new Error(`File not found: ${file}`)

          const available = yield* lsp.hasClients(file)
          if (!available) throw new Error("No LSP server available for this file type.")

          yield* lsp.touchFile(file, true)

          const result: unknown[] = yield* (() => {
            switch (args.operation) {
              case "goToDefinition":
                return lsp.definition(position)
              case "findReferences":
                return lsp.references(position)
              case "hover":
                return lsp.hover(position)
              case "documentSymbol":
                return lsp.documentSymbol(uri)
              case "goToImplementation":
                return lsp.implementation(position)
              case "prepareCallHierarchy":
                return lsp.prepareCallHierarchy(position)
              case "incomingCalls":
                return lsp.incomingCalls(position)
              case "outgoingCalls":
                return lsp.outgoingCalls(position)
            }
          })()

          return {
            title,
            metadata: { result },
            output: result.length === 0 ? `No results found for ${args.operation}` : JSON.stringify(result, null, 2),
          }
        }),
    }
  }),
)
