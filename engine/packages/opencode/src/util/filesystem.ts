import { chmod, mkdir, readFile, stat as statFile, writeFile } from "fs/promises"
import { createWriteStream, existsSync, statSync } from "fs"
import { realpathSync } from "fs"
import { dirname, join, posix, relative, resolve as pathResolve, win32 } from "path"
import { Readable } from "stream"
import { pipeline } from "stream/promises"
import { Glob } from "@mimo-ai/shared/util/glob"

// Fast sync version for metadata checks
export async function exists(p: string): Promise<boolean> {
  return existsSync(p)
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function stat(p: string): ReturnType<typeof statSync> | undefined {
  return statSync(p, { throwIfNoEntry: false }) ?? undefined
}

export async function statAsync(p: string): Promise<ReturnType<typeof statSync> | undefined> {
  return statFile(p).catch((e) => {
    if (isEnoent(e)) return undefined
    throw e
  })
}

export async function size(p: string): Promise<number> {
  const s = stat(p)?.size ?? 0
  return typeof s === "bigint" ? Number(s) : s
}

export async function readText(p: string): Promise<string> {
  return readFile(p, "utf-8")
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, "utf-8"))
}

export async function readBytes(p: string): Promise<Buffer> {
  return readFile(p)
}

export async function readArrayBuffer(p: string): Promise<ArrayBuffer> {
  const buf = await readFile(p)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

function isEnoent(e: unknown): e is { code: "ENOENT" } {
  return typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "ENOENT"
}

export async function write(p: string, content: string | Buffer | Uint8Array, mode?: number): Promise<void> {
  try {
    if (mode) {
      await writeFile(p, content, { mode })
    } else {
      await writeFile(p, content)
    }
  } catch (e) {
    if (isEnoent(e)) {
      await mkdir(dirname(p), { recursive: true })
      if (mode) {
        await writeFile(p, content, { mode })
      } else {
        await writeFile(p, content)
      }
      return
    }
    throw e
  }
}

export async function writeJson(p: string, data: unknown, mode?: number): Promise<void> {
  return write(p, JSON.stringify(data, null, 2), mode)
}

export async function writeStream(
  p: string,
  stream: ReadableStream<Uint8Array> | Readable,
  mode?: number,
): Promise<void> {
  const dir = dirname(p)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }

  const nodeStream = stream instanceof ReadableStream ? Readable.fromWeb(stream as any) : stream
  const writeStream = createWriteStream(p)
  await pipeline(nodeStream, writeStream)

  if (mode) {
    await chmod(p, mode)
  }
}

export async function mimeType(p: string): Promise<string> {
  const { lookup } = await import("mime-types")
  return lookup(p) || "application/octet-stream"
}

/**
 * On Windows, normalize a path to its canonical casing using the filesystem.
 * This is needed because Windows paths are case-insensitive but LSP servers
 * may return paths with different casing than what we send them.
 */
export function normalizePath(p: string): string {
  if (process.platform !== "win32") return p
  const resolved = win32.normalize(win32.resolve(windowsPath(p)))
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

// We cannot rely on path.resolve() here because git.exe may come from Git Bash, Cygwin, or MSYS2, so we need to translate these paths at the boundary.
// Also resolves symlinks so that callers using the result as a cache key
// always get the same canonical path for a given physical directory.
export function resolve(p: string): string {
  const resolved = pathResolve(windowsPath(p))
  try {
    return normalizePath(realpathSync(resolved))
  } catch (e) {
    if (isEnoent(e)) return normalizePath(resolved)
    throw e
  }
}

export function windowsPath(p: string): string {
  if (process.platform !== "win32") return p
  return (
    p
      .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      // Git Bash for Windows paths are typically /<drive>/...
      .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      // Cygwin git paths are typically /cygdrive/<drive>/...
      .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      // WSL paths are typically /mnt/<drive>/...
      .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
  )
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

export async function findUp(
  target: string,
  start: string,
  stop?: string,
  options?: { rootFirst?: boolean },
): Promise<string[]>
export async function findUp(
  target: string[],
  start: string,
  stop?: string,
  options?: { rootFirst?: boolean },
): Promise<string[]>
export async function findUp(
  target: string | string[],
  start: string,
  stop?: string,
  options?: { rootFirst?: boolean },
) {
  const dirs = [start]
  let current = start
  while (true) {
    if (stop === current) break
    const parent = dirname(current)
    if (parent === current) break
    dirs.push(parent)
    current = parent
  }

  const targets = Array.isArray(target) ? target : [target]
  const result = []
  for (const dir of options?.rootFirst ? dirs.toReversed() : dirs) {
    for (const item of targets) {
      const search = join(dir, item)
      if (await exists(search)) result.push(search)
    }
  }
  return result
}

export async function* up(options: { targets: string[]; start: string; stop?: string }) {
  const { targets, start, stop } = options
  let current = start
  while (true) {
    for (const target of targets) {
      const search = join(current, target)
      if (await exists(search)) yield search
    }
    if (stop === current) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

export async function globUp(pattern: string, start: string, stop?: string) {
  let current = start
  const result = []
  while (true) {
    try {
      const matches = await Glob.scan(pattern, {
        cwd: current,
        absolute: true,
        include: "file",
        dot: true,
      })
      result.push(...matches)
    } catch {
      // Skip invalid glob patterns
    }
    if (stop === current) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return result
}
