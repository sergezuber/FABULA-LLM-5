// Read-only agent contract (Item 3). Pure, unit-testable core + a tiny session→agent registry.
//
// The engine spawns sub-agents (native `actor`/`task`) under their own sessionID; the built-in
// `explore` agent is meant for READ-ONLY research. The `tool.execute.before` hook only receives
// { tool, sessionID, callID } (no agent), but `chat.message` gives { sessionID, agent } — so we
// record the agent per session there and consult it in the before-hook.
//
// When a session is read-only (an `explore`-class agent, any agent named in FABULA_READONLY_AGENTS,
// or the whole run via FABULA_READONLY=1), a WRITE tool is hard-blocked by throwing in the security
// before-hook. Research fan-out physically cannot mutate the workspace.

/** Tools that mutate the workspace or persist state. */
export const WRITE_TOOLS = new Set<string>([
  "write", "edit", "patch",
  // apply_patch/notebook_edit are the gpt-class edit path (the engine routes ALL their file edits
  // through apply_patch) — omitting them would let a read-only agent write files.
  "apply_patch", "notebook_edit", "str_replace_editor", "view_str_replace",
  "create_file", "str_replace", "note_append",
  "save_skill", "save_handoff",
  "schedule_task", "cancel_scheduled",
])

/** Bash commands that mutate the filesystem / repo / system. Heuristic (read-only mode, not a
 *  security boundary — cmdguard handles the catastrophic cases). Redirections to files count. */
const MUTATING_CMD = new RegExp(
  [
    /\brm\b|\brmdir\b|\bmv\b|\bcp\b|\bdd\b|\btruncate\b|\bshred\b/.source,
    /\bmkdir\b|\btouch\b|\bchmod\b|\bchown\b|\bln\b|\btee\b/.source,
    /\bsed\b[^|]*\s-\w*i|\bperl\b[^|]*\s-\w*i|\bawk\b[^|]*>/.source,
    /\bgit\s+(commit|add|push|reset|checkout|restore|rm|clean|stash|merge|rebase|apply|mv|tag|branch\s+-[dD])/.source,
    /\bnpm\s+(i\b|install|ci|update|uninstall)|\byarn\s+add|\bpnpm\s+(add|install)|\bbun\s+(add|install)/.source,
    /\bpip\d*\s+install|\bbrew\s+(install|uninstall|upgrade)|\bcargo\s+(add|install)/.source,
    /\bkill\b|\bpkill\b|\blaunchctl\b|\bdefaults\s+write|\bcrontab\b/.source,
    />>|(^|[^0-9<>])>[^>&]/.source, // output redirection to a file
  ].join("|"),
)

/** True if this tool call would write/mutate. For bash, inspects the command string. */
export function isWriteTool(tool: string | undefined, args?: any): boolean {
  if (!tool) return false
  if (WRITE_TOOLS.has(tool)) return true
  if (tool === "bash" || tool === "bash_tool") {
    const cmd = String(args?.command ?? args?.cmd ?? "")
    return MUTATING_CMD.test(cmd)
  }
  return false
}

/** Agents treated as read-only. `explore` is the engine's built-in research agent; extend via
 *  FABULA_READONLY_AGENTS (comma-separated). */
export function readOnlyAgents(): Set<string> {
  const extra = (process.env.FABULA_READONLY_AGENTS || "")
    .split(",").map((s) => s.trim()).filter(Boolean)
  return new Set<string>(["explore", ...extra])
}

export function isReadOnlyAgent(agent: string | undefined): boolean {
  if (!agent) return false
  return readOnlyAgents().has(agent)
}

/** Global read-only run (look, don't touch) via env. */
export function isGlobalReadOnly(): boolean {
  const v = (process.env.FABULA_READONLY || "").toLowerCase()
  return v === "1" || v === "true" || v === "yes"
}

// ── session → agent registry (populated from chat.message) ───────────────────────────────────
const sessionAgent = new Map<string, string>()

export function recordSessionAgent(sessionID: string | undefined, agent: string | undefined): void {
  if (!sessionID || !agent) return
  sessionAgent.set(sessionID, agent)
  if (sessionAgent.size > 2000) { // bound the map; drop the oldest insertion
    const first = sessionAgent.keys().next().value
    if (first !== undefined) sessionAgent.delete(first)
  }
}

export function agentForSession(sessionID: string | undefined): string | undefined {
  return sessionID ? sessionAgent.get(sessionID) : undefined
}

/** Should this (session, tool, args) be blocked as a read-only violation? */
export function isReadOnlyViolation(sessionID: string | undefined, tool: string | undefined, args?: any): boolean {
  if (!isWriteTool(tool, args)) return false
  if (isGlobalReadOnly()) return true
  return isReadOnlyAgent(agentForSession(sessionID))
}

export function readOnlyBlockMessage(tool: string | undefined): string {
  return `[BLOCKED] read-only agent: the tool "${tool}" would modify the workspace, but this session ` +
    `is running as a read-only agent (research/explore). Do the investigation and REPORT your findings; ` +
    `a writing step (a non-read-only agent) will apply changes.`
}

/** Test-only: clear the registry between tests. */
export function _resetRolesRegistry(): void {
  sessionAgent.clear()
}
