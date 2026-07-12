// FABULA-LLM-5 — shadow-git checkpoint / undo (one plugin per file).
// Before each write-batch, snapshots the target file(s) into a PRIVATE git store (never the user's
// real .git — see lib/checkpoint.ts). Exposes list_checkpoints / restore_checkpoint / diff_checkpoints
// so the agent (or user) can time-travel edits even in non-git projects. Best-effort: a snapshot
// failure never blocks the actual tool.

import { tool } from "@mimo-ai/plugin"
import type { Plugin } from "@mimo-ai/plugin"
import * as path from "node:path"
import { gate } from "./lib/manage"
import { snapshot, restore, listCheckpoints, diffCheckpoints, CheckpointEntry } from "./lib/checkpoint"
import { EDIT_TOOLS, editPaths } from "./lib/edittools"
import { WRITE_TOOLS, isWriteTool } from "./lib/roles"

const z = tool.schema

// Tools whose target files we can pinpoint from args (path-carrying writers) — the shared edit-tool
// source of truth (incl. apply_patch/notebook_edit, the gpt-class edit path) plus note_append.
const PATH_WRITE_TOOLS = new Set([...EDIT_TOOLS, "note_append"])

// Monotonic id without relying on Date precision alone.
let _seq = 0
function nextId(): string {
  const t = (() => { try { return Date.now() } catch { return 0 } })()
  return `${t}_${++_seq}`
}

// A short, human ledger line.
function renderEntry(e: CheckpointEntry): string {
  const when = e.ts ? new Date(e.ts).toISOString().replace("T", " ").slice(0, 19) : "?"
  const what = e.skipped ? `(skipped: ${e.skipped})` : e.affected.map((a) => a.path).join(", ") || "(whole tree)"
  return `${e.id}  ${when}  [${e.tool || "?"}]  ${what}`
}

export const FabulaCheckpoint: Plugin = async (input: any) => gate("checkpoint", ({
  // Snapshot BEFORE a write runs, so restore returns the pre-write state. Never throws.
  "tool.execute.before": async (hookInput: any, output: any) => {
    try {
      const workspace = input?.directory || process.cwd()
      const toolName = hookInput?.tool
      const args = output?.args || {}
      if (!isWriteTool(toolName, args)) return
      if (PATH_WRITE_TOOLS.has(toolName)) {
        const rels: string[] = []
        for (const raw of editPaths(toolName, args)) {
          const abs = path.isAbsolute(raw) ? raw : path.resolve(workspace, raw)
          const rel = path.relative(workspace, abs)
          // only checkpoint files inside the workspace (don't snapshot arbitrary system paths)
          if (rel.startsWith("..") || path.isAbsolute(rel)) continue
          rels.push(rel)
        }
        if (!rels.length) return
        snapshot(workspace, rels, { id: nextId(), ts: safeNow(), label: `before ${toolName} ${rels.join(", ")}`, tool: toolName })
      } else {
        // bash mutation: whole-tree snapshot (bounded inside lib/checkpoint)
        snapshot(workspace, null, { id: nextId(), ts: safeNow(), label: `before ${toolName}`, tool: toolName })
      }
    } catch { /* checkpointing is best-effort — never block the real tool */ }
  },

  tool: {
    list_checkpoints: tool({
      description: "List shadow-git checkpoints for this workspace (each one is the pre-write state saved " +
        "automatically before an edit). Use to find a point to restore to.",
      args: {},
      async execute() {
        const list = listCheckpoints(input?.directory || process.cwd())
        if (!list.length) return "No checkpoints yet — they're created automatically before each file edit."
        const recent = list.slice(-40).reverse()
        return "Checkpoints (newest first):\n" + recent.map(renderEntry).join("\n")
      },
    }),

    restore_checkpoint: tool({
      description: "Undo edits by restoring the workspace to a checkpoint (from list_checkpoints). Files captured " +
        "in that checkpoint revert to their saved content; files created afterward are removed. Does NOT touch " +
        "your real git repo.",
      args: { id: z.string().describe("Checkpoint id from list_checkpoints") },
      async execute(args: any) {
        const res = restore(input?.directory || process.cwd(), String(args.id))
        if (res.error) return `restore_checkpoint: ${res.error}`
        const parts: string[] = []
        if (res.restored.length) parts.push(`restored ${res.restored.length} file(s): ${res.restored.join(", ")}`)
        if (res.deleted.length) parts.push(`removed ${res.deleted.length} file(s) created after: ${res.deleted.join(", ")}`)
        return parts.length ? `Checkpoint ${args.id} — ${parts.join("; ")}.` : `Checkpoint ${args.id} — nothing to change.`
      },
    }),

    diff_checkpoints: tool({
      description: "Show a unified diff between two checkpoints, or between one checkpoint and the current files " +
        "(omit `to`).",
      args: {
        from: z.string().describe("Base checkpoint id"),
        to: z.string().nullish().describe("Target checkpoint id (omit to diff against the current working tree)"),
      },
      async execute(args: any) {
        const d = diffCheckpoints(input?.directory || process.cwd(), String(args.from), args.to ? String(args.to) : undefined)
        return d.trim() ? d : "(no differences)"
      },
    }),
  },
}))

function safeNow(): number { try { return Date.now() } catch { return 0 } }
