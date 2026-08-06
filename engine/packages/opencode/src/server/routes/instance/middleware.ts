import type { MiddlewareHandler } from "hono"
import path from "node:path"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { AppRuntime } from "@/effect/app-runtime"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { WorkspaceID } from "@/control-plane/schema"
import { Flag } from "@/flag/flag"
import { Filesystem } from "@/util"
import os from "os"

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
// The two bases are canonicalized ONCE. They are local paths (the launch cwd and $HOME itself), so
// their realpath is safe; caching also keeps this predicate free of syscalls per call.
let allowedBases: { cwd: string; home: string; cwdRaw: string; homeRaw: string } | undefined

export function instanceDirectoryAllowed(directory: string): boolean {
  if (Flag.MIMOCODE_SERVER_PASSWORD) return true
  // LEXICAL ONLY — never touch the filesystem for the CANDIDATE. This used to call realpathSync on
  // every session's directory (via Filesystem.resolve), and realpath on an iCloud-managed folder can
  // sleep in the kernel indefinitely while fileproviderd stalls. Called per row from the chat-list
  // and usage routes, one stalled Desktop path froze the entire single-threaded server: every route
  // returned nothing, at 0% CPU, with no wait channel — measured live 2026-07-28, the engine slept
  // inside realpathSync("/Users/…/Desktop/BOOK-NII-TRED") while the same call was instant once the
  // stall passed, which is why the wedge came and went with fileproviderd's mood.
  //
  // "Is this directory under $HOME or the cwd" is a question about STRINGS. The one canonicalization
  // that matters lexically is the macOS /var → /private/var twin, handled by comparing both spellings
  // — never by asking the filesystem.
  if (!allowedBases) {
    const cwd = Filesystem.resolve(process.cwd())
    // `HOME` when it is NAMED — the tests set it, and a POSIX user may override it deliberately —
    // otherwise the platform's own answer. Reading only `HOME` meant that on a system which records the
    // user's directory elsewhere the home base silently became the launch cwd, and every project under
    // the user's own profile was refused with a 403 by a guard that was supposed to allow exactly those.
    const home = process.env["HOME"] || os.homedir()
    // BOTH spellings of each base, because only the BASE may be canonicalised. Resolving the CANDIDATE is
    // what froze the server on an iCloud-managed folder, so it stays lexical — which leaves the two sides
    // in different spellings wherever a filesystem has more than one for a directory (a short 8.3 name, a
    // differing case). MEASURED: a project under the user's own profile answered "not allowed" because
    // the base said `runneradmin` and the candidate said `RUNNER~1`.
    //
    // Keeping the PRE-canonical spelling beside the canonical one is lexical, costs one comparison, and is
    // exactly what the /var → /private/var twin below already does for the other platform.
    const homeRaw = home ? normalizeLexical(home) : ""
    allowedBases = {
      cwd,
      home: home ? Filesystem.resolve(home) : cwd,
      cwdRaw: normalizeLexical(process.cwd()),
      homeRaw: homeRaw || cwd,
    }
  }
  const raw = normalizeLexical(directory)
  const twins =
    raw === "/var" || raw.startsWith("/var/")
      ? [raw, "/private" + raw]
      : raw === "/private/var" || raw.startsWith("/private/var/")
        ? [raw, raw.slice("/private".length)]
        : [raw]
  const bases = allowedBases!
  return twins.some(
    (dir) =>
      Filesystem.contains(bases.cwd, dir) ||
      Filesystem.contains(bases.cwdRaw, dir) ||
      Filesystem.contains(bases.home, dir) ||
      Filesystem.contains(bases.homeRaw, dir) ||
      Filesystem.contains(dir, bases.home) ||
      Filesystem.contains(dir, bases.homeRaw),
  )
}

/** Absolute + lexically normalized, with NO filesystem access. */
function normalizeLexical(p: string): string {
  return path.resolve(p)
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
