import * as path from "path"
import type { ProjectID } from "../project/schema"
import type { SessionID } from "../session/schema"

const VALID_SCOPES = ["global", "projects", "sessions"] as const

const TASK_ID_RE = /^T\d+(\.\d+)*$/

/**
 * Returns true when the relative path under <root>/memory/ is one of the
 * precise paths the checkpoint-writer subagent is permitted to write:
 *   projects/<pid>/memory.md          (or memory-<topic>.md spillover)
 *   sessions/<sid>/checkpoint.md      (or checkpoint-<topic>.md spillover)
 *   sessions/<sid>/notes.md
 *   sessions/<sid>/tasks/<task_id>/*.md
 *
 * Rejects anything else. Catches writer drift like
 * `<pid>/pinned.md` (v4 name) at write time.
 */
function isCheckpointWriterAllowed(parts: string[]): boolean {
  if (parts.length < 3) return false

  if (parts[0] === "projects") {
    if (parts.length !== 3) return false
    const file = parts[2]
    if (!file.endsWith(".md")) return false
    const lower = file.toLowerCase()
    return lower === "memory.md" || lower.startsWith("memory-")
  }

  if (parts[0] === "sessions") {
    const rest = parts.slice(2)
    if (rest.length === 1) {
      const file = rest[0]
      if (!file.endsWith(".md")) return false
      return file === "checkpoint.md" || file === "notes.md" || file.startsWith("checkpoint-")
    }
    if (rest.length === 3 && rest[0] === "tasks") {
      return TASK_ID_RE.test(rest[1]) && rest[2].endsWith(".md")
    }
    return false
  }

  return false
}

/**
 * Format the multi-line "where to write memory" hint shown to main agent
 * when it attempts a path with no scope dir or an invalid scope. Both throws
 * use byte-identical bodies — the corrective action is the same.
 */
function formatMainAgentHelp(memoryFile: string, notesFile: string, target: string): string {
  return (
    `Memory writes go under <memoryRoot>/<scope>/<scope_id>/<key>.md (scope: global | projects | sessions). You attempted: ${target}.\n` +
    `\n` +
    `Canonical main-agent paths (copy verbatim):\n` +
    `  ${memoryFile}\n` +
    `    Edit ## Rules / ## Architecture decisions / ## Discovered durable knowledge.\n` +
    `  ${notesFile}\n` +
    `    Append \`## [turn N · ISO-Z]\` entries for free-form scratch.\n` +
    `\n` +
    `Other free-form <key>.md under a valid scope dir are also allowed.\n` +
    `checkpoint.md, task progress, and memory-/checkpoint-<topic>.md spillovers are checkpoint-writer's domain.`
  )
}

/**
 * Returns true when the path is reserved-by-pattern for the checkpoint-writer
 * subagent — main agent must not write it directly.
 *
 * In v5 only the writer-managed task directory remains reserved-by-pattern.
 * Main agent CAN write <pid>/MEMORY.md and <sid>/checkpoint.md (system prompt
 * teaches it the rules).
 */
function isReservedForCheckpointWriter(parts: string[]): boolean {
  if (parts[0] !== "sessions" || parts.length < 4) return false
  // Anything under <sid>/tasks/ is writer-managed (use task tool revise action).
  if (parts[2] === "tasks") return true
  return false
}

/**
 * Throws if the target write would violate memory-scope or reserved-path
 * rules. Pure function — does not touch the filesystem.
 *
 * Two policies:
 *   - For checkpoint-writer subagent: must be in the precise allowlist above
 *     (<pid>/MEMORY.md, <sid>/checkpoint.md, <sid>/tasks/<id>/*.md, plus
 *     memory-/checkpoint- spillover variants).
 *   - For all other agents: cannot write <sid>/tasks/* — that's
 *     checkpoint-writer-only.
 *
 * Non-memory paths and free keys under valid scopes pass through unmodified.
 */
export function assertMemoryWriteAllowed(input: {
  target: string
  agentName: string
  memoryRoot: string
  projectID: ProjectID
  sessionID: SessionID
  taskId?: string
}): void {
  const { target, agentName, memoryRoot, projectID, sessionID } = input
  const memoryFile = path.join(memoryRoot, "projects", projectID, "MEMORY.md")
  const notesFile = path.join(memoryRoot, "sessions", sessionID, "notes.md")
  const checkpointFile = path.join(memoryRoot, "sessions", sessionID, "checkpoint.md")
  const taskMemDir = path.join(memoryRoot, "sessions", sessionID, "tasks")
  const normalizedRoot = memoryRoot.endsWith(path.sep) ? memoryRoot : memoryRoot + path.sep
  if (!target.startsWith(normalizedRoot)) return

  const rel = path.relative(memoryRoot, target)
  const parts = rel.split(path.sep)

  if (parts.length < 2) {
    throw new Error(formatMainAgentHelp(memoryFile, notesFile, target))
  }
  const scope = parts[0]
  if (!VALID_SCOPES.includes(scope as (typeof VALID_SCOPES)[number])) {
    throw new Error(formatMainAgentHelp(memoryFile, notesFile, target))
  }

  if (agentName === "checkpoint-writer") {
    if (!isCheckpointWriterAllowed(parts)) {
      throw new Error(
        `Path '${rel}' is not in the checkpoint-writer allowlist.\n` +
          `Writer may only write to:\n` +
          `  ${memoryFile}                           — project memory (or memory-<topic>.md spillover)\n` +
          `  ${checkpointFile}                       — session checkpoint (or checkpoint-<topic>.md spillover)\n` +
          `  ${taskMemDir}/<task_id>/*.md            — per-task narratives (any .md filename)\n` +
          `You attempted: ${target}.`,
      )
    }
    return
  }

  if (isReservedForCheckpointWriter(parts)) {
    // Spec ② follow-up: subagent bound to a specific TID may write anywhere
    // under ITS OWN tasks/<TID>/ subtree. Cross-task writes still rejected.
    // parts shape under tasks: ["sessions", sid, "tasks", "<TID>", "<file>.md", ...]
    // NOTE: `parts.length >= 5` is deliberately looser than the checkpoint-writer
    // path (which requires exactly tasks/<TID>/<file>.md). A subagent may nest
    // its own workspace (tasks/<TID>/sub/foo.md); the `parts[3] === input.taskId`
    // guard still confines it to its own task, so the extra depth is safe.
    if (
      input.taskId &&
      parts[2] === "tasks" &&
      parts[3] === input.taskId &&
      parts.length >= 5 &&
      parts[parts.length - 1].endsWith(".md")
    ) {
      return
    }
    throw new Error(
      `Path '${rel}' is reserved for the checkpoint-writer subagent.\n` +
        `Main agent writes to:\n` +
        `  ${memoryFile}\n` +
        `  ${notesFile}\n` +
        `Subagent bound to task <TID> may write to tasks/<TID>/*.md (pass task_id when spawning).\n` +
        `You attempted: ${target}.`,
    )
  }
}

/**
 * READ counterpart to assertMemoryWriteAllowed, for the checkpoint-writer only.
 *
 * Why this exists — measured, not theorised. The checkpoint-writer is a child agent whose whole job is
 * to write a state summary of the parent session from the transcript it is handed. Its runtime tool
 * whitelist grants unrestricted `read` over the project, and on a session whose task is "read every
 * chapter / all files" the writer was observed doing exactly that: it read the project DIRECTORY, then
 * every corpus file, before touching its own checkpoint. On a small corpus it survived and wrote a
 * partial checkpoint; on a real one (18 chapters of a novel) it exhausted its context and never reached
 * the write at all, leaving every section of checkpoint.md as "(none yet)". The harness then reset the
 * conversation onto that empty checkpoint and the main agent restarted its task from zero — losing all
 * completed work and looping. Eight writers ran for that session and not one produced state.
 *
 * Reproduced twice end-to-end with unique markers planted in the corpus, which were then found in the
 * writer's own session — so this is what the writer read, not an inference about what it might read.
 *
 * The rule: a summarizer summarises what it was GIVEN. Its four working paths (checkpoint / memory /
 * notes / tasks) live under the memory root and stay readable; the project tree does not. This removes
 * no capability its contract has — reconstructing session state by re-reading the project is precisely
 * the behaviour that destroys the checkpoint — and it is scoped to this one agent, so every other agent
 * is untouched.
 *
 * KNOWN LIMIT, stated rather than buried: `glob` and `grep` remain unguarded. They were not the measured
 * vector (they return paths and matching lines, not whole files, so they do not drown a context the way
 * 18 file reads do), but a writer could still reach project content through them.
 */
export function assertCheckpointWriterReadAllowed(input: {
  target: string
  agentName: string
  /** LAZY on purpose: resolving the memory root touches Global, and an eagerly-evaluated argument runs
   *  for EVERY read by EVERY agent. A first version passed the resolved string, so one bad Global import
   *  threw on every read in the product — including the writer's own files — and the resulting `[error]`
   *  status was indistinguishable, at a glance, from the guard correctly refusing a project file. Only
   *  the error TEXT gave it away. Keeping it a thunk means non-writers never evaluate it at all. */
  memoryRoot: () => string
}): void {
  if (input.agentName !== "checkpoint-writer") return
  const memoryRoot = input.memoryRoot()
  const normalizedRoot = memoryRoot.endsWith(path.sep) ? memoryRoot : memoryRoot + path.sep
  if (input.target === memoryRoot || input.target.startsWith(normalizedRoot)) return
  throw new Error(
    `checkpoint-writer may not read project files — it summarises the transcript it was given.\n` +
      `Readable: everything under ${memoryRoot}\n` +
      `You attempted: ${input.target}\n` +
      `Write the checkpoint from the conversation you were handed. If it contains nothing to record, ` +
      `write the sections you can and leave the rest as-is rather than exploring the project.`,
  )
}
