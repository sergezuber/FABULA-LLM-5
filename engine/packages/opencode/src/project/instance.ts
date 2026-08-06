import { GlobalBus } from "@/bus/global"
import { disposeInstance } from "@/effect/instance-registry"
import { makeRuntime } from "@/effect/run-service"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { iife } from "@/util/iife"
import { Log } from "@/util"
import { LocalContext } from "../util"
import * as Project from "./project"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { parse as pathParse } from "path"
import os from "os"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

const context = LocalContext.create<InstanceContext>("instance")
const cache = new Map<string, Promise<InstanceContext>>()
const project = makeRuntime(Project.Service, Project.defaultLayer)

// Directories that are not projects and never will be: the machine's own configuration, its devices,
// and the superuser's home. Opening one as a project points every read, every write and every snapshot
// at the operating system.
//
// The list is per-platform because the directories are. A POSIX list applied to Windows names nothing
// that exists there, which is how `C:\Windows` came to be an acceptable project directory — the guard
// ran, found no match among six paths none of which that machine has, and allowed it. Windows spells
// its own protected directories in the environment (`SystemRoot`, `ProgramFiles`, `ProgramData`), so
// they are READ rather than written down: a machine with Windows on `D:` or a localized Program Files
// is covered by the same rule, and no drive letter is assumed.
function protectedPrefixes(): string[] {
  if (process.platform !== "win32") {
    // The superuser's home is on this list because ANOTHER user must not be able to point the agent at
    // it. It comes OFF the list when it is the home of whoever is running, because then it is not the
    // operating system's — it is where that person's work lives, and refusing it refuses the one thing
    // the application exists to open.
    //
    // MEASURED, and only a live launch could have shown it: the shell started on Linux, the window opened,
    // and the page said "Access denied: target is a protected system directory". In a container the user
    // IS root, so this guard had just refused the user their own home. Every automated check passed —
    // none of them runs as a user whose home is on the list.
    const own = os.homedir()
    return ["/etc", "/proc", "/sys", "/dev", "/boot", "/private/etc", "/root", "/var/root"].filter(
      (p) => p !== own,
    )
  }
  return ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"]
    .map((name) => process.env[name])
    .filter((v): v is string => !!v)
    .map((v) => AppFileSystem.normalizePath(v).replace(/[\\/]+$/, ""))
}

function assertSafeDirectory(directory: string): void {
  const resolved = AppFileSystem.resolve(directory)
  if (resolved === pathParse(resolved).root) {
    throw new Error("Access denied: filesystem root is not a valid project directory")
  }
  const target = process.platform === "win32" ? resolved.toLowerCase() : resolved
  for (const prefix of protectedPrefixes()) {
    const p = process.platform === "win32" ? prefix.toLowerCase() : prefix
    // A separator is required after the prefix, or `/etcetera` matches `/etc`.
    if (target === p || target.startsWith(`${p}/`) || target.startsWith(`${p}\\`)) {
      throw new Error("Access denied: target is a protected system directory")
    }
  }
}

const disposal = {
  all: undefined as Promise<void> | undefined,
}

function boot(input: { directory: string; init?: () => Promise<any>; worktree?: string; project?: Project.Info }) {
  return iife(async () => {
    const ctx =
      input.project && input.worktree
        ? {
            directory: input.directory,
            worktree: input.worktree,
            project: input.project,
          }
        : await project
            .runPromise((svc) => svc.fromDirectory(input.directory))
            .then(({ project, sandbox }) => ({
              directory: input.directory,
              worktree: sandbox,
              project,
            }))
    await context.provide(ctx, async () => {
      await input.init?.()
    })
    return ctx
  })
}

function track(directory: string, next: Promise<InstanceContext>) {
  const task = next.catch((error) => {
    if (cache.get(directory) === task) cache.delete(directory)
    throw error
  })
  cache.set(directory, task)
  return task
}

export const Instance = {
  async provide<R>(input: { directory: string; init?: () => Promise<any>; fn: () => R }): Promise<R> {
    const directory = AppFileSystem.resolve(input.directory)
    assertSafeDirectory(directory)
    let existing = cache.get(directory)
    if (!existing) {
      Log.Default.info("creating instance", { directory })
      existing = track(
        directory,
        boot({
          directory,
          init: input.init,
        }),
      )
    }
    const ctx = await existing
    return context.provide(ctx, async () => {
      return input.fn()
    })
  },
  get current() {
    return context.use()
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  get project() {
    return context.use().project
  },

  /**
   * Check if a path is within the project boundary.
   * Returns true if path is inside Instance.directory OR Instance.worktree.
   * Paths within the worktree but outside the working directory should not trigger external_directory permission.
   */
  containsPath(filepath: string, ctx?: InstanceContext) {
    const instance = ctx ?? Instance
    if (AppFileSystem.contains(instance.directory, filepath)) return true
    // A project with no version control has its worktree set to the filesystem ROOT, which contains every
    // absolute path there is — so consulting it would answer "inside the project" for the whole machine
    // and no path could ever be external. The guard for that recognised only the POSIX spelling of a root.
    //
    // MEASURED on a Windows runner: `C:\Windows` came back as inside the project, so the permission that
    // exists to ask before touching anything outside was never requested — sixty-seven checks red for one
    // root written the other way. Asked as a QUESTION about the path now ("is this its own root?"), which
    // is true of `/`, of `C:\`, and of a network share alike.
    if (AppFileSystem.isFilesystemRoot(instance.worktree)) return false
    return AppFileSystem.contains(instance.worktree, filepath)
  },
  /**
   * Captures the current instance ALS context and returns a wrapper that
   * restores it when called. Use this for callbacks that fire outside the
   * instance async context (native addons, event emitters, timers, etc.).
   */
  bind<F extends (...args: any[]) => any>(fn: F): F {
    const ctx = context.use()
    return ((...args: any[]) => context.provide(ctx, () => fn(...args))) as F
  },
  /**
   * Run a synchronous function within the given instance context ALS.
   * Use this to bridge from Effect (where InstanceRef carries context)
   * back to sync code that reads Instance.directory from ALS.
   */
  restore<R>(ctx: InstanceContext, fn: () => R): R {
    return context.provide(ctx, fn)
  },
  async reload(input: { directory: string; init?: () => Promise<any>; project?: Project.Info; worktree?: string }) {
    const directory = AppFileSystem.resolve(input.directory)
    Log.Default.info("reloading instance", { directory })
    await disposeInstance(directory)
    cache.delete(directory)
    const next = track(directory, boot({ ...input, directory }))

    GlobalBus.emit("event", {
      directory,
      project: input.project?.id,
      workspace: WorkspaceContext.workspaceID,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory,
        },
      },
    })

    return await next
  },
  async dispose() {
    const directory = Instance.directory
    const project = Instance.project
    Log.Default.info("disposing instance", { directory })
    await disposeInstance(directory)
    cache.delete(directory)

    GlobalBus.emit("event", {
      directory,
      project: project.id,
      workspace: WorkspaceContext.workspaceID,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory,
        },
      },
    })
  },
  async disposeAll() {
    if (disposal.all) return disposal.all

    disposal.all = iife(async () => {
      Log.Default.info("disposing all instances")
      const entries = [...cache.entries()]
      for (const [key, value] of entries) {
        if (cache.get(key) !== value) continue

        const ctx = await value.catch((error) => {
          Log.Default.warn("instance dispose failed", { key, error })
          return undefined
        })

        if (!ctx) {
          if (cache.get(key) === value) cache.delete(key)
          continue
        }

        if (cache.get(key) !== value) continue

        await context.provide(ctx, async () => {
          await Instance.dispose()
        })
      }
    }).finally(() => {
      disposal.all = undefined
    })

    return disposal.all
  },
}
