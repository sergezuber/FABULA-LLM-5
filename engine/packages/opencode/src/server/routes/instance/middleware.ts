import type { MiddlewareHandler } from "hono"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { AppRuntime } from "@/effect/app-runtime"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { WorkspaceID } from "@/control-plane/schema"
import { Flag } from "@/flag/flag"
import { Filesystem } from "@/util"

// FABLE: a local desktop app legitimately opens projects across the whole $HOME tree
// (~/ChessAI, ~/GitHub, ~/Downloads/Projects), not just the launch cwd (~/FABLE). Allow any
// directory within $HOME OR the cwd. Outside $HOME stays blocked; the password and
// non-loopback bind guards are unchanged.
// Allow: within cwd, within $HOME, OR an ancestor of $HOME (/, /Users) — the project picker
// resolves a typed absolute path by listing its way DOWN from "/", so those ancestors must be
// listable. Unrelated roots (/etc, /tmp, /Applications) still 403.
// Single source of truth: the global fabula routes use the same predicate to hide sessions whose
// directory this middleware would deny — otherwise the app lists chats it can never open and
// error-toasts on every Home load (observed live with CLI test runs under /private/tmp).
export function instanceDirectoryAllowed(directory: string): boolean {
  if (Flag.MIMOCODE_SERVER_PASSWORD) return true
  // Resolve the input too: cwd/home are canonicalized (symlinks — /var → /private/var on macOS),
  // so an unresolved candidate would spuriously mismatch.
  const dir = Filesystem.resolve(directory)
  const cwd = Filesystem.resolve(process.cwd())
  const home = process.env.HOME ? Filesystem.resolve(process.env.HOME) : cwd
  return Filesystem.contains(cwd, dir) || Filesystem.contains(home, dir) || Filesystem.contains(dir, home)
}

export function InstanceMiddleware(workspaceID?: WorkspaceID): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.query("directory") || c.req.header("x-mimocode-directory") || process.cwd()
    const directory = AppFileSystem.resolve(
      (() => {
        try {
          return decodeURIComponent(raw)
        } catch {
          return raw
        }
      })(),
    )

    if (!instanceDirectoryAllowed(directory)) {
      return c.json({ error: "Access denied: directory must be within $HOME or the server's working directory" }, 403)
    }

    return WorkspaceContext.provide({
      workspaceID,
      async fn() {
        return Instance.provide({
          directory,
          init: () => AppRuntime.runPromise(InstanceBootstrap),
          async fn() {
            return next()
          },
        })
      },
    })
  }
}
