import path from "path"
import { Effect } from "effect"
import { EffectLogger } from "@/effect"
import { InstanceState } from "@/effect"
import { Global } from "@/global"
import type * as Tool from "./tool"
import { Instance } from "../project/instance"
import { ProjectID } from "../project/schema"
import { assertMemoryWriteAllowed } from "./memory-path-guard"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { memoryRoot, memoryTarget } from "@/session/checkpoint-paths"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return

  if (options?.bypass) return

  const ins = yield* InstanceState.context
  const full = process.platform === "win32" ? AppFileSystem.normalizePath(target) : target
  if (Instance.containsPath(full, ins)) return

  // Memory tree has its own finer authority (memory-path-guard), which the write
  // tools invoke right after this call. Defer to it: asking external_directory here
  // is redundant and, in headless run mode (no permission replier), deadlocks on a
  // never-resolved Deferred. memory-path-guard allows a task-bound subagent its own
  // tasks/<taskId>/*.md and rejects cross-task / wrong-agent writes.
  if (AppFileSystem.contains(memoryRoot(), full)) return

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options).pipe(Effect.provide(EffectLogger.layer)))
}

/**
 * The single write-permission gate for file-mutating tools (edit, write,
 * apply_patch). Runs the two checks every write must pass, in order:
 *   1. external_directory — asks before touching paths outside the worktree
 *      (defers the memory subtree to the memory guard; see the early return above).
 *   2. memory-path-guard — finer authority over the memory tree: a task-bound
 *      subagent may write its own tasks/<taskId>/*.md, the checkpoint-writer its
 *      canonical paths, and everything else is rejected.
 *
 * Collapsing both into one call removes the per-tool duplication and, more
 * importantly, makes "call external_directory but forget the memory guard"
 * unrepresentable — a new write tool that calls this one gate cannot drift into
 * leaving the memory tree unguarded. Read-only tools (read/grep/glob/lsp) keep
 * calling assertExternalDirectoryEffect directly; the memory guard is write-only.
 */
export const assertWriteAllowed = Effect.fn("Tool.assertWriteAllowed")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  yield* assertExternalDirectoryEffect(ctx, target, options)
  if (!target) return

  // Instance.current is a getter that THROWS when no instance is ALS-bound
  // (detached fibers, tests without a project fixture). The optional chain runs
  // only after the getter returns, so it cannot save us — the try/catch is
  // load-bearing, not defensive dead code. Fall back to ProjectID.global so the
  // guard can still resolve a canonical memory path. Mirrors session/checkpoint.ts.
  const projectID = (() => {
    try {
      return (Instance.current?.project?.id as ProjectID | undefined) ?? ProjectID.global
    } catch {
      return ProjectID.global
    }
  })()

  assertMemoryWriteAllowed({
    // Both sides in ONE spelling, brought together HERE because this is where both describe THIS machine.
    // The root is canonical and the target arrived as the caller wrote it, so a filesystem with more than
    // one spelling for a path had the guard compare two of them, decide the write was not in the memory
    // tree, and hand it to the permission ask this guard exists to take over from. The guard itself stays
    // purely lexical, so it can still be asked about paths that are not on this machine.
    target: memoryTarget(target),
    agentName: ctx.agent,
    memoryRoot: memoryRoot(),
    projectID,
    sessionID: ctx.sessionID,
    taskId: ctx.taskId,
  })
})

/**
 * Perform the per-write `edit` permission ask, EXCEPT for targets under
 * <data>/memory/. The memory tree's authority is memory-path-guard (invoked by
 * assertWriteAllowed, which every write tool calls first): it already allows the
 * checkpoint-writer / task-bound subagent their canonical paths and rejects
 * everything else. Asking `edit` there is redundant and — for a background fork
 * inheriting a parent's `edit:ask`/`deny` — would deny/skip the checkpoint write.
 * Outside the memory tree, ask exactly as the write tools did inline before.
 *
 * Mirrors the external_directory memory-region deferral added in the 2026-06-04
 * poststop-progress-permission-deadlock fix (see assertExternalDirectoryEffect).
 */
export const askEditUnlessMemory = Effect.fn("Tool.askEditUnlessMemory")(function* (
  ctx: Tool.Context,
  filepath: string,
  input: { patterns: string[]; diff: string; files?: unknown },
) {
  const full = process.platform === "win32" ? AppFileSystem.normalizePath(filepath) : filepath
  if (AppFileSystem.contains(memoryRoot(), full)) return
  yield* ctx.ask({
    permission: "edit",
    patterns: input.patterns,
    always: ["*"],
    metadata: { filepath, diff: input.diff, ...(input.files !== undefined ? { files: input.files } : {}) },
  })
})
