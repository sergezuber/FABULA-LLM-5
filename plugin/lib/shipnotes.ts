// implementation-notes + pitch-packager (Thariq Shihipar). DURING: log every deviation/decision as you
// build (take the reversible option, keep going) — the harness auto-captures the edit trail so nothing
// is lost even if the model forgets to. AFTER: pitch-packager bundles the change + the notes into a
// DEMO-FIRST buy-in doc. PURE core: the notes store shape, the auto-log describer, the pitch prompt.

export type NoteKind = "edit" | "note"
export interface Note { kind: NoteKind; text: string }

export interface NotesLog {
  notes: Note[]
}
export function newNotesLog(): NotesLog {
  return { notes: [] }
}

/** Describe a file edit as a one-line note for the auto-captured trail (no timestamps — deterministic). */
export function describeEdit(toolName: string, args: any): string | null {
  const p = args?.file_path ?? args?.path ?? args?.filePath ?? args?.file
  if (typeof p !== "string" || !p) return null
  const verb = toolName === "create_file" || toolName === "write" ? "created" : "edited"
  return `${verb} ${p}`
}

/** Append a note, de-duping consecutive identical edit lines (a model may re-edit the same file). */
export function addNote(log: NotesLog, kind: NoteKind, text: string): void {
  const t = (text || "").trim()
  if (!t) return
  const last = log.notes[log.notes.length - 1]
  if (last && last.kind === kind && last.text === t) return
  log.notes.push({ kind, text: t })
  if (log.notes.length > 200) log.notes.shift()
}

/** Render the notes trail for humans / for the pitch prompt. */
export function renderNotes(log: NotesLog): string {
  if (!log.notes.length) return "(no notes logged this task)"
  return log.notes.map((n) => (n.kind === "note" ? `• DECISION: ${n.text}` : `· ${n.text}`)).join("\n")
}

/** Prompt: turn the change + the notes trail into a DEMO-FIRST reviewer buy-in doc (lead with what it
 * does / how to see it, THEN why, THEN the notable decisions & risks — never a wall of mechanics). */
export function pitchPrompt(task: string, diff: string, notes: string): string {
  return [
    "Write a short DEMO-FIRST pitch for this change so a reviewer can buy in fast. Structure:",
    "  ## What it does  — the user-visible behavior, and the ONE command / step to see it work.",
    "  ## Why  — the problem it solves, in 1-2 lines.",
    "  ## Notable decisions  — the choices a reviewer would question (from the notes), each 1 line.",
    "  ## Risks / what to check  — the riskiest part and how it was handled.",
    "Lead with the demo, not the mechanics. Be concise. Ground every claim in the diff/notes; invent nothing.",
    "",
    "=== TASK ===",
    (task || "").trim(),
    "",
    "=== CHANGE (diff) ===",
    (diff || "(no diff)").trim().slice(0, 9000),
    "",
    "=== NOTES TRAIL (what happened while building) ===",
    (notes || "(none)").trim().slice(0, 4000),
  ].join("\n")
}
