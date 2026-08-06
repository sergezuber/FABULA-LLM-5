import { NodeFileSystem } from "@effect/platform-node"
import { dirname, join, posix, relative, resolve as pathResolve, win32 } from "path"
import { realpathSync } from "fs"
import * as NFS from "fs/promises"
import { lookup } from "mime-types"
import { Effect, FileSystem, Layer, Schema, Context } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Glob } from "./util/glob"

export namespace AppFileSystem {
  export class FileSystemError extends Schema.TaggedErrorClass<FileSystemError>()("FileSystemError", {
    method: Schema.String,
    cause: Schema.optional(Schema.Defect),
  }) {}

  export type Error = PlatformError | FileSystemError

  export interface DirEntry {
    readonly name: string
    readonly type: "file" | "directory" | "symlink" | "other"
  }

  export interface Interface extends FileSystem.FileSystem {
    readonly isDir: (path: string) => Effect.Effect<boolean>
    readonly isFile: (path: string) => Effect.Effect<boolean>
    readonly existsSafe: (path: string) => Effect.Effect<boolean>
    readonly readJson: (path: string) => Effect.Effect<unknown, Error>
    readonly writeJson: (path: string, data: unknown, mode?: number) => Effect.Effect<void, Error>
    readonly ensureDir: (path: string) => Effect.Effect<void, Error>
    readonly writeWithDirs: (path: string, content: string | Uint8Array, mode?: number) => Effect.Effect<void, Error>
    readonly readDirectoryEntries: (path: string) => Effect.Effect<DirEntry[], Error>
    readonly findUp: (target: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly up: (options: { targets: string[]; start: string; stop?: string }) => Effect.Effect<string[], Error>
    readonly globUp: (pattern: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly glob: (pattern: string, options?: Glob.Options) => Effect.Effect<string[], Error>
    readonly globMatch: (pattern: string, filepath: string) => boolean
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/FileSystem") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const existsSafe = Effect.fn("FileSystem.existsSafe")(function* (path: string) {
        return yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
      })

      const isDir = Effect.fn("FileSystem.isDir")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "Directory"
      })

      const isFile = Effect.fn("FileSystem.isFile")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "File"
      })

      const readDirectoryEntries = Effect.fn("FileSystem.readDirectoryEntries")(function* (dirPath: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            const entries = await NFS.readdir(dirPath, { withFileTypes: true })
            return entries.map(
              (e): DirEntry => ({
                name: e.name,
                type: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : e.isFile() ? "file" : "other",
              }),
            )
          },
          catch: (cause) => new FileSystemError({ method: "readDirectoryEntries", cause }),
        })
      })

      const readJson = Effect.fn("FileSystem.readJson")(function* (path: string) {
        const text = yield* fs.readFileString(path)
        return JSON.parse(text)
      })

      const writeJson = Effect.fn("FileSystem.writeJson")(function* (path: string, data: unknown, mode?: number) {
        const content = JSON.stringify(data, null, 2)
        yield* fs.writeFileString(path, content)
        if (mode) yield* fs.chmod(path, mode)
      })

      const ensureDir = Effect.fn("FileSystem.ensureDir")(function* (path: string) {
        yield* fs.makeDirectory(path, { recursive: true })
      })

      const writeWithDirs = Effect.fn("FileSystem.writeWithDirs")(function* (
        path: string,
        content: string | Uint8Array,
        mode?: number,
      ) {
        const write = typeof content === "string" ? fs.writeFileString(path, content) : fs.writeFile(path, content)

        yield* write.pipe(
          Effect.catchIf(
            (e) => e.reason._tag === "NotFound",
            () =>
              Effect.gen(function* () {
                yield* fs.makeDirectory(dirname(path), { recursive: true })
                yield* write
              }),
          ),
        )
        if (mode) yield* fs.chmod(path, mode)
      })

      const glob = Effect.fn("FileSystem.glob")(function* (pattern: string, options?: Glob.Options) {
        return yield* Effect.tryPromise({
          try: () => Glob.scan(pattern, options),
          catch: (cause) => new FileSystemError({ method: "glob", cause }),
        })
      })

      const findUp = Effect.fn("FileSystem.findUp")(function* (target: string, start: string, stop?: string) {
        const result: string[] = []
        let current = start
        while (true) {
          const search = join(current, target)
          if (yield* fs.exists(search)) result.push(search)
          if (stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const up = Effect.fn("FileSystem.up")(function* (options: { targets: string[]; start: string; stop?: string }) {
        const result: string[] = []
        let current = options.start
        while (true) {
          for (const target of options.targets) {
            const search = join(current, target)
            if (yield* fs.exists(search)) result.push(search)
          }
          if (options.stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const globUp = Effect.fn("FileSystem.globUp")(function* (pattern: string, start: string, stop?: string) {
        const result: string[] = []
        let current = start
        while (true) {
          const matches = yield* glob(pattern, { cwd: current, absolute: true, include: "file", dot: true }).pipe(
            Effect.catch(() => Effect.succeed([] as string[])),
          )
          result.push(...matches)
          if (stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      return Service.of({
        ...fs,
        existsSafe,
        isDir,
        isFile,
        readDirectoryEntries,
        readJson,
        writeJson,
        ensureDir,
        writeWithDirs,
        findUp,
        up,
        globUp,
        glob,
        globMatch: Glob.match,
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(NodeFileSystem.layer))

  // Pure helpers that don't need Effect (path manipulation, sync operations)
  export function mimeType(p: string): string {
    return lookup(p) || "application/octet-stream"
  }

  export function normalizePath(p: string): string {
    if (process.platform !== "win32") return p
    const resolved = pathResolve(windowsPath(p))
    try {
      return realpathSync.native(resolved)
    } catch {
      return resolved
    }
  }

  export function normalizePathPattern(p: string): string {
    if (process.platform !== "win32") return p
    if (p === "*") return p
    const match = p.match(/^(.*)[\\/]\*$/)
    if (!match) return normalizePath(p)
    const dir = /^[A-Za-z]:$/.test(match[1]) ? match[1] + "\\" : match[1]
    return join(normalizePath(dir), "*")
  }

  export function resolve(p: string): string {
    const resolved = pathResolve(windowsPath(p))
    try {
      return normalizePath(realpathSync(resolved))
    } catch (e: any) {
      if (e?.code === "ENOENT") return normalizePath(resolved)
      throw e
    }
  }

  export function windowsPath(p: string): string {
    if (process.platform !== "win32") return p
    return p
      .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
  }

  export function overlaps(a: string, b: string) {
    const relA = relative(a, b)
    const relB = relative(b, a)
    return !relA || !relA.startsWith("..") || !relB || !relB.startsWith("..")
  }

  /**
   * Is `child` inside `parent` — decided from the relative path BETWEEN them.
   *
   * A relative path that climbs (`..`) means outside, and that was the whole test. It is not enough where
   * a filesystem has more than one root: between two of them there is no relative path at all, so the
   * platform hands back an ABSOLUTE one — no leading `..`, and the old rule read that as "inside".
   *
   * MEASURED, and the consequence was not cosmetic: with a project on one drive, every path on another
   * read as inside the project, so nothing was ever external, so the permission that exists to ask before
   * touching anything outside was never requested — the guard present, and silent. Found by asking a
   * failing check what it HAD been asked for and getting an empty list back.
   *
   * `isAbsolute` on the relative answer is the missing half. Same path is inside itself.
   */
  export function contains(parent: string, child: string) {
    const rel = relative(parent, child)
    return isContainedRelative(rel)
  }

  /**
   * The decision, separated from the platform so it can be checked on any of them.
   *
   * A filesystem with a single root cannot produce the cross-root case at all, which is precisely why the
   * defect survived: the machines it was tested on could not express it.
   */
  export function isContainedRelative(rel: string): boolean {
    if (rel === "") return true // the same path is inside itself
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) return false
    // Absoluteness is asked in BOTH dialects, not in the one this machine happens to speak. The answer
    // being judged was produced by a filesystem that may have several roots, and a drive-lettered answer
    // is absolute there whatever the machine reading it thinks — which also lets the case be checked on a
    // machine that cannot produce it.
    return !posix.isAbsolute(rel) && !win32.isAbsolute(rel)
  }

  /**
   * Is this path its own root — the top of a filesystem, containing everything on it?
   *
   * Asked as a question rather than compared against `"/"`. A filesystem may have many roots and spells
   * them differently: `/`, `C:\`, `\\server\share\`. Code that recognises only one spelling treats the
   * others as ordinary directories, and a "does the project contain this path" check anchored at a root it
   * did not recognise answers yes for the entire machine.
   */
  /**
   * Whether a relative answer names something strictly BELOW the directory it was measured from —
   * containment, minus the directory itself.
   *
   * Five call sites spelled this inline as `rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)`,
   * and every one of them carried the defect that reading drags along: it asks whether the answer
   * begins with two dots rather than whether it climbs, so a directory genuinely named `..cache` was
   * excluded. `isAbsolute` also answers in the host's dialect only, which is the wrong question for a
   * path that may have been recorded elsewhere.
   */
  export function isBelowRelative(rel: string): boolean {
    return rel !== "" && isContainedRelative(rel)
  }

  export function isFilesystemRoot(p: string): boolean {
    if (!p) return false
    const norm = p.replace(/[\\/]+$/, "") || p
    for (const dialect of [posix, win32]) {
      const parsed = dialect.parse(p)
      if (parsed.root && (parsed.root === p || parsed.root.replace(/[\\/]+$/, "") === norm) && !parsed.base) return true
    }
    return false
  }
}
