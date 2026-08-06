import { chmod, mkdir, readFile, stat as statFile, writeFile } from "fs/promises"
import { createWriteStream, existsSync, statSync } from "fs"
import { realpathSync } from "fs"
import { dirname, join, posix, relative, resolve as pathResolve, win32 } from "path"
import { Readable } from "stream"
import { pipeline } from "stream/promises"
import { Glob } from "@mimo-ai/shared/util/glob"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"

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



// We cannot rely on path.resolve() here because git.exe may come from Git Bash, Cygwin, or MSYS2, so we need to translate these paths at the boundary.
// Also resolves symlinks so that callers using the result as a cache key
// always get the same canonical path for a given physical directory.




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

// ── Path containment has ONE definition, and it is not here ───────────────────────────────────────
//
// Two namespaces answer "is this path inside that directory": `AppFileSystem` (thirty-nine callers,
// among them the check that decides whether a project may be opened at all) and this `Filesystem`
// (six callers, among them the allowlist that guards every instance route). They were separate
// implementations of one rule, so a correction written into either left the other deciding the
// opposite — and a correction was: the cross-dialect repair landed here while `Instance.containsPath`
// went on calling the other one, which is how an external directory read as inside the project.
//
// The name stays, since six call sites use it; the rule comes from one place.
export const normalizePath = AppFileSystem.normalizePath
export const normalizePathPattern = AppFileSystem.normalizePathPattern
export const resolve = AppFileSystem.resolve
export const windowsPath = AppFileSystem.windowsPath
export const overlaps = AppFileSystem.overlaps
export const contains = AppFileSystem.contains
export const isContainedRelative = AppFileSystem.isContainedRelative
export const isFilesystemRoot = AppFileSystem.isFilesystemRoot
