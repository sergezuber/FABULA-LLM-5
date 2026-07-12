// Model identity for the Proof-of-Done receipt — HONEST naming by construction.
//
// Two distinct fields, never conflated:
//   modelDescriptorHash — sha256 of the serving descriptor (id + arch + quantization + publisher +
//     compatibility type) as reported by the model server's registry API. Cheap, always available
//     (local or cloud). It pins WHICH build/quant served the run — it is NOT a hash of the weights.
//   weightsDigest — sha256 over the actual weight FILES on disk (sorted relative paths, per-file
//     sha256, cached by size+mtime so a 20GB model hashes once). Only present when the files were
//     really hashed; the field is never synthesized from metadata.
//
// Pure logic here (descriptor pick/canonicalization/hashing + file walking against an injected
// root); the plugin (fabula-receipt.ts) does the HTTP fetch and env wiring.

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

export type ModelDescriptor = {
  id: string
  arch?: string
  quantization?: string
  publisher?: string
  compatibilityType?: string
}

/** Pick the serving model's descriptor out of a models-registry payload (LM Studio
 *  `/api/v0/models` shape: `{data:[...]}` or a bare array; OpenAI `/v1/models` also fits — the
 *  extra fields are simply absent). Unknown/malformed payloads → undefined, never a throw. */
export function pickDescriptor(payload: unknown, modelId: string): ModelDescriptor | undefined {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data as unknown[])
      : []
  const want = modelId.toLowerCase()
  const hit = list.find(
    (m) => m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" && (m as { id: string }).id.toLowerCase() === want,
  ) as Record<string, unknown> | undefined
  if (!hit) return undefined
  const str = (k: string) => (typeof hit[k] === "string" && (hit[k] as string).length ? (hit[k] as string) : undefined)
  return {
    id: hit.id as string,
    ...(str("arch") ? { arch: str("arch") } : {}),
    ...(str("quantization") ? { quantization: str("quantization") } : {}),
    ...(str("publisher") ? { publisher: str("publisher") } : {}),
    ...(str("compatibility_type") ? { compatibilityType: str("compatibility_type") } : {}),
  }
}

/** sha256 of the descriptor's canonical JSON (sorted keys) — insertion order can never change it. */
export function descriptorHash(d: ModelDescriptor): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(d).sort(([a], [b]) => (a < b ? -1 : 1))),
  )
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

export type WeightsDigest = { digest: string; files: number; bytes: number }
type CacheEntry = { size: number; mtimeMs: number; sha256: string }
export type WeightsCache = Record<string, CacheEntry>

/** sha256 over the model's weight files: per-file hashes (cache hit = same size+mtime) rolled up
 *  over SORTED relative paths, so the digest is a content identity independent of walk order.
 *  Returns undefined when the dir doesn't exist or holds no files — never a fabricated value. */
export function weightsDigestForDir(dir: string, cache: WeightsCache = {}): WeightsDigest | undefined {
  const files: { rel: string; abs: string; size: number; mtimeMs: number }[] = []
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d, { withFileTypes: true })) {
      if (name.name.startsWith(".")) continue
      const abs = path.join(d, name.name)
      if (name.isDirectory()) walk(abs)
      else if (name.isFile()) {
        const st = fs.statSync(abs)
        files.push({ rel: path.relative(dir, abs), abs, size: st.size, mtimeMs: st.mtimeMs })
      }
    }
  }
  try {
    walk(dir)
  } catch {
    return undefined
  }
  if (files.length === 0) return undefined
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1))
  const roll = createHash("sha256")
  let bytes = 0
  for (const f of files) {
    const cached = cache[f.rel]
    const sha =
      cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs ? cached.sha256 : sha256File(f.abs)
    cache[f.rel] = { size: f.size, mtimeMs: f.mtimeMs, sha256: sha }
    roll.update(`${f.rel}:${sha}\n`, "utf8")
    bytes += f.size
  }
  return { digest: roll.digest("hex"), files: files.length, bytes }
}

function sha256File(abs: string): string {
  // Streaming would be async; a receipt mint is a one-shot CLI-grade moment and the cache makes
  // repeat mints free. Read in one buffer per file (weight shards are large but fit sequential IO).
  const h = createHash("sha256")
  const fd = fs.openSync(abs, "r")
  try {
    const buf = Buffer.alloc(64 * 1024 * 1024)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, -1)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  return h.digest("hex")
}

/** Best-effort local model dir: an explicit override, else a directory under `modelsRoot`
 *  (LM Studio lays models out as `<root>/<publisher>/<name>`) matching the model id's final
 *  segment. Real registries drop/append quant suffixes between the id and the dir name
 *  (id `…-heretic-mlx` ↔ dir `…-Heretic-MLX-4bit`), so a prefix match in EITHER direction
 *  counts; an exact match wins over the first prefix hit. Undefined when nothing matches —
 *  the digest is then omitted, never guessed. */
export function resolveModelDir(modelId: string, modelsRoot: string, override?: string): string | undefined {
  if (override && override.trim()) return fs.existsSync(override) ? override : undefined
  const tail = modelId.split("/").pop()!.toLowerCase()
  let prefixHit: string | undefined
  try {
    for (const pub of fs.readdirSync(modelsRoot, { withFileTypes: true })) {
      if (!pub.isDirectory()) continue
      for (const name of fs.readdirSync(path.join(modelsRoot, pub.name), { withFileTypes: true })) {
        if (!name.isDirectory()) continue
        const dir = name.name.toLowerCase()
        if (dir === tail) return path.join(modelsRoot, pub.name, name.name)
        if (!prefixHit && (dir.startsWith(tail) || tail.startsWith(dir))) prefixHit = path.join(modelsRoot, pub.name, name.name)
      }
    }
  } catch {
    return undefined
  }
  return prefixHit
}

export function loadWeightsCache(file: string): WeightsCache {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    return parsed && typeof parsed === "object" ? (parsed as WeightsCache) : {}
  } catch {
    return {}
  }
}

export function saveWeightsCache(file: string, cache: WeightsCache): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(cache), "utf8")
  } catch {
    /* cache is an optimization — losing it only costs a re-hash */
  }
}
