// FABULA-LLM-5 — the engine's file-editing tools, ONE source of truth shared by every gate that
// tracks the change set (fabula-receipt, fabula-reproduce-gate, fabula-change-quiz). A tool missing
// here silently bypasses mint gating AND pending-green invalidation — exactly the false-VERIFIED bug
// class. apply_patch matters most: the engine's registry disables edit/write and routes ALL file
// edits through apply_patch for gpt-* models (engine tool/registry.ts), so without it a gpt-class
// model in the socket edits source invisibly.
//
// bash edits (sed -i / git apply / heredoc redirect / tee) ALSO mutate source but are not a distinct
// tool id — a model routinely patches via the shell and stops, and before this was a hole through the
// WHOLE verdict stack (no forced verify, receipt/reproduce/quiz blind → a green "done" with zero
// gating). bashEditsTree() detects the common tree-mutating idioms so the gates treat such a bash call
// as an edit. This same detector is MIRRORED (pure copy) in the engine's session/verify-gate.ts so the
// hard force-verify gate fires too — keep the two in sync.

/** Tool ids whose successful execution changes files in the workspace. */
export const EDIT_TOOLS = new Set([
  "create_file", "str_replace", "write", "edit", "str_replace_editor", "view_str_replace",
  "apply_patch", "notebook_edit",
])

export const BASH_TOOLS = new Set(["bash", "bash_tool"])

/** Every file path an edit-tool call touched. apply_patch carries them in patch_text headers;
 *  a tree-mutating bash carries them in redirect/tee targets (best-effort). */
export function editPaths(toolName: string, args: any): string[] {
  if (toolName === "apply_patch") return patchPaths(args?.patch_text)
  if (BASH_TOOLS.has(toolName)) return bashEditPaths(args?.command ?? args?.cmd ?? args?.script)
  const p = args?.file_path ?? args?.path ?? args?.filePath ?? args?.file ?? args?.notebook_path
  return typeof p === "string" && p ? [p] : []
}

/** True iff a bash command mutates files in the tree (redirect/tee to a real file, or an in-place /
 *  apply idiom). Heuristic, deliberately conservative: a false positive only forces a (safe) verify;
 *  a false negative is the hole we are closing. Not a shell parser. */
export function bashEditsTree(command: unknown): boolean {
  if (typeof command !== "string" || !command) return false
  if (bashEditPaths(command).length > 0) return true
  // in-place stream editors and patch application (no obvious redirect target)
  return /\b(?:sed\s+(?:-\S+\s+)*-i|perl\s+(?:-\S+\s+)*-i|ruby\s+(?:-\S+\s+)*-i)\b/.test(command)
    || /\bgit\s+apply\b/.test(command)
    || /\bpatch\b[^|]*<|\bpatch\s+(?:-\S+\s+)*-i\b/.test(command)
}

/** Best-effort file targets a bash command writes: `> f`, `>> f`, `| tee f`, `cat > f <<EOF`, and
 *  `sed -i … path` (the in-place target is the last bare arg). Skips /dev/*. */
export function bashEditPaths(command: unknown): string[] {
  if (typeof command !== "string" || !command) return []
  const out: string[] = []
  for (const m of command.matchAll(/(?:>>?|\btee(?:\s+-a)?)\s+(['"]?)([^\s'"|;&>]+)\1/g)) {
    const p = m[2]
    if (p && !p.startsWith("/dev/") && !/^\d+$/.test(p)) out.push(p) // skip /dev/*, fd numbers (2>&1)
  }
  // sed/perl/ruby -i <expr> <file>: the last non-flag token is the edited file (best-effort).
  const inplace = command.match(/\b(?:sed|perl|ruby)\s+(?:-\S+\s+)*-i\S*\s+(?:-\S+\s+)*(?:['"][^'"]*['"]\s+)?(['"]?)([^\s'"|;&<>]+)\1\s*$/)
  if (inplace && inplace[2] && !inplace[2].startsWith("-")) out.push(inplace[2])
  return out
}

/** A tree edit whose file we can't name (git apply / patch < diff) — still a SOURCE change the gates
 *  must not ignore. classifyPath() maps it to "source" (see lib/reprogate.ts). */
export const BASH_EDIT_MARKER = "«bash-tree-edit»"

/** The "edit units" a tool call contributes to gate change-tracking: real paths where we can name them,
 *  else the bash marker for a confirmed-but-unnamed tree edit. Empty = not an edit. This is what the
 *  reproduce/change-quiz/receipt gates iterate to recordEdit(). */
export function editUnits(toolName: string, args: any): string[] {
  if (BASH_TOOLS.has(toolName)) {
    if (!bashEditsTree(args?.command ?? args?.cmd ?? args?.script)) return []
    const paths = bashEditPaths(args?.command ?? args?.cmd ?? args?.script)
    return paths.length ? paths : [BASH_EDIT_MARKER]
  }
  return editPaths(toolName, args)
}

/** Parse the apply_patch envelope headers (mirrors the engine's parser in patch/): `*** <Verb> File: path`. */
function patchPaths(text: unknown): string[] {
  if (typeof text !== "string" || !text) return []
  const out: string[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    for (const h of ["*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:"]) {
      if (line.startsWith(h)) {
        const p = line.slice(h.length).trim()
        if (p) out.push(p)
      }
    }
  }
  return out
}
