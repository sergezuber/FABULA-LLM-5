// Coding-context posture (pure formatter). Builds the system-prompt block injected each
// turn so the model knows where it is, what changed, and how to verify. The plugin (fabula-context.ts)
// gathers git/verify data with a timeout+cache; this module just formats (unit-testable).

export interface ProjectFacts {
  cwd: string
  branch?: string | null
  changed?: string[]          // `git status --porcelain` lines
  changedTotal?: number       // real total before truncation
  verifyCmd?: string | null   // detected verify command
  verifyLabel?: string | null
  // The engine's native `lsp` tool is gated behind MIMOCODE_EXPERIMENTAL_LSP_TOOL; the plugin sets
  // this ONLY when the tool is actually in the toolset, so we never advise a nonexistent tool.
  // Measured (2026-07-06, Qwen3.6-35B, isolated runs): with the tool present but unprompted, the
  // model made 0 lsp calls on symbol-navigation tasks (grep/read only, up to 14 calls where one
  // lsp call would do) — hence this explicit nudge.
  lspTool?: boolean
}

const MAX_CHANGED = 25

/** Format facts into system-prompt lines (returns "" if there's nothing useful to say). */
export function formatProjectContext(f: ProjectFacts): string {
  const lines: string[] = ["[FABULA PROJECT CONTEXT]", `Working directory: ${f.cwd}`]

  if (f.branch) lines.push(`Git branch: ${f.branch}`)
  if (Array.isArray(f.changed)) {
    const total = f.changedTotal ?? f.changed.length
    if (total === 0) lines.push("Git: working tree clean.")
    else {
      lines.push(`Git: ${total} changed file(s)${total > MAX_CHANGED ? ` (showing ${MAX_CHANGED})` : ""}:`)
      for (const l of f.changed.slice(0, MAX_CHANGED)) lines.push(`  ${l}`)
    }
  }

  if (f.verifyCmd)
    lines.push(`Verification: detected \`${f.verifyCmd}\`${f.verifyLabel ? ` (${f.verifyLabel})` : ""}. ` +
      `Call verify_done before declaring a coding task complete.`)
  else
    lines.push("Verification: no test/build command auto-detected — confirm how to verify before declaring done.")

  lines.push(
    "Editing: read a file (view) before str_replace; use real newlines; every write is byte-checked.",
  )
  if (f.lspTool)
    lines.push(
      "Symbols: for definitions/references/call hierarchy use the built-in `lsp` tool " +
        "(operations: workspaceSymbol, findReferences, incomingCalls, outgoingCalls) instead of repeated grep/read. " +
        "The tool is named exactly `lsp` — not the serena tools.",
    )
  return lines.join("\n")
}

/** Truncate porcelain output to MAX_CHANGED lines; returns {lines, total}. */
export function parsePorcelain(porcelain: string): { lines: string[]; total: number } {
  const all = (porcelain || "").split("\n").map((l) => l.replace(/\s+$/, "")).filter(Boolean)
  return { lines: all.slice(0, MAX_CHANGED), total: all.length }
}
