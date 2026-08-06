import path from "path"
import { createHash } from "crypto"

export type Scope = "global" | "projects" | "sessions" | "cc"
export type MemoryType =
  | "free"
  | "memory"
  | "checkpoint"
  | "progress"
  | "notes"
  | "feedback"
  | "project"
  | "reference"
  | "user"

export const CC_TYPES = ["feedback", "project", "reference", "user"] as const
export type CcType = (typeof CC_TYPES)[number]

export interface MemoryLocator {
  scope: Scope
  scope_id: string
  type: MemoryType
  key: string
}

const TYPE_PATTERNS: Array<{ match: RegExp; type: MemoryType }> = [
  // Only `memory` is case-insensitive: it's the one file renamed lowercase
  // memory.md → MEMORY.md, so the index must bridge both casings during/after
  // migration. checkpoint/tasks/notes have no legacy-casing bridge and stay
  // exact — if a writer ever drifts to CHECKPOINT.md it should NOT silently
  // classify as checkpoint.
  { match: /^memory$/i, type: "memory" },
  { match: /^memory-/i, type: "memory" },
  { match: /^checkpoint$/, type: "checkpoint" },
  { match: /^checkpoint-/, type: "checkpoint" },
  { match: /^tasks\/[^/]+\/progress$/, type: "progress" },
  { match: /^tasks\/[^/]+\/notes$/, type: "notes" },
]

function detectType(key: string): MemoryType {
  for (const p of TYPE_PATTERNS) if (p.match.test(key)) return p.type
  return "free"
}

/**
 * These two READ a path the filesystem handed us and answer what it denotes — so they must accept the
 * separator the filesystem uses, whichever it is. They accepted only `/`, and the walker feeds them
 * host-dialect paths: on Windows nothing ever matched, so NOTHING was indexed and every memory search
 * came back empty. Not a slow index — no index at all, silently, because a path that does not parse is
 * indistinguishable from a file that is not a memory file.
 *
 * The KEY they return is a stored identifier, not a path to open, so it is written in one dialect. A key
 * recorded on one machine has to mean the same thing on another, and `TYPE_PATTERNS` matches against it.
 */
const SEP = "[\\\\/]"
const MEMORY_RE = new RegExp(`${SEP}memory${SEP}(global|projects|sessions)(?:${SEP}([^\\\\/]+))?${SEP}(.+)\\.md$`)

function asKey(raw: string): string {
  return raw.replaceAll("\\", "/")
}

export function parsePath(absPath: string): MemoryLocator | null {
  const m = absPath.match(MEMORY_RE)
  if (!m) return null
  const [, scope, idMaybe, keyRaw] = m
  const scope_id = scope === "global" ? "" : (idMaybe ?? "")
  const key = asKey(keyRaw!)
  return { scope: scope as Scope, scope_id, type: detectType(key), key }
}

// Match: <anything>/.claude/projects/<slug>/memory/<key>.md — in either separator, for the reason above.
// <slug> is a single path segment (CC's path-derived project identifier).
// <key> may contain a separator, for nested dirs.
const CC_PATH_RE = new RegExp(`${SEP}\\.claude${SEP}projects${SEP}([^\\\\/]+)${SEP}memory${SEP}(.+)\\.md$`)

export function parseCcPath(absPath: string): MemoryLocator | null {
  const m = absPath.match(CC_PATH_RE)
  if (!m) return null
  const [, slug, keyRaw] = m
  return {
    scope: "cc",
    scope_id: slug,
    type: "free", // type is finalized from frontmatter at index time
    key: asKey(keyRaw!),
  }
}

// Match the YAML frontmatter region of a CC memory file.
// Captures the YAML block between the leading "---\n" and the closing "\n---\n".
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/

// Match `<indent>type: <word>` inside the YAML block. The indent requirement
// pins the line to the `metadata:` sub-tree — a top-level `type:` (no indent)
// must NOT match.
//
// Limitation: this matches ANY indented `type:` line, not specifically one
// nested under `metadata:`. CC's frontmatter today only nests `type` under
// `metadata`, so the structural assumption holds by convention. If CC ever
// adds a sibling block like `feedback:\n  type: highpri\n`, that would
// shadow `metadata.type` and need a real parser.
const METADATA_TYPE_RE = /^[ \t]+type:[ \t]*(\w+)[ \t]*$/m

export function parseCcFrontmatterType(body: string): CcType | null {
  const fm = body.match(FRONTMATTER_RE)
  if (!fm) return null
  const inner = fm[1]
  const t = inner.match(METADATA_TYPE_RE)
  if (!t) return null
  const value = t[1]
  return (CC_TYPES as readonly string[]).includes(value) ? (value as CcType) : null
}

function assertSafeComponent(value: string) {
  // Reject any segment containing ".." or starting with "/" — guards against
  // path traversal and absolute-path injection from caller-supplied scope_id/key.
  for (const segment of value.split("/")) {
    if (segment === "..") throw new Error(`buildPath: invalid path component: ${value}`)
  }
  if (value.startsWith("/")) throw new Error(`buildPath: invalid path component: ${value}`)
}

export function buildPath(input: { root: string; scope: Scope; scope_id?: string; key: string }): string {
  if (input.scope_id !== undefined) assertSafeComponent(input.scope_id)
  assertSafeComponent(input.key)
  const parts = [input.root, input.scope]
  if (input.scope !== "global") parts.push(input.scope_id ?? "")
  parts.push(`${input.key}.md`)
  return path.join(...parts)
}

export function resolveProjectId(absRepoPath: string): string {
  return createHash("sha256").update(absRepoPath).digest("hex").slice(0, 12)
}
