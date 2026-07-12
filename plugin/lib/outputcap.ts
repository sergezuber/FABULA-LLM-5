// Bounded tool output (port of pi's truncate + spill-to-file). A single tool result (a test-suite
// dump, a build log, a huge file read) is a direct multiplier on our measured prefill cost. Cap each
// result to whichever limit hits first (lines OR bytes), spill the FULL output to a temp file, and put
// a machine-actionable cursor in the result the model can follow (the steer-on-tool-result channel
// local models demonstrably act on). Nothing is lost; context per step is hard-capped. Pure `capText`
// + `cursorMessage` are unit-tested; `capToolOutput` adds the file spill (I/O).
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

export interface CapOpts { maxLines?: number; maxBytes?: number; direction?: "head" | "tail" }
export interface Capped { shown: string; truncated: boolean; totalLines: number; totalBytes: number; keptLines: number }

const DEFAULT_MAX_LINES = 2000
const DEFAULT_MAX_BYTES = 50_000

function byteLen(s: string): number {
  return typeof Buffer !== "undefined" ? Buffer.byteLength(s, "utf8") : new TextEncoder().encode(s).length
}

/** Cap text to maxLines/maxBytes (whichever first), keeping WHOLE lines from the head or tail. */
export function capText(text: string, opts: CapOpts = {}): Capped {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const direction = opts.direction ?? "tail"
  const lines = text.split("\n")
  const totalLines = lines.length
  const totalBytes = byteLen(text)
  if (totalLines <= maxLines && totalBytes <= maxBytes)
    return { shown: text, truncated: false, totalLines, totalBytes, keptLines: totalLines }
  const ordered = direction === "tail" ? [...lines].reverse() : lines
  const kept: string[] = []
  let bytes = 0
  for (const ln of ordered) {
    const b = byteLen(ln) + 1
    if (kept.length >= maxLines || (bytes + b > maxBytes && kept.length > 0)) break
    kept.push(ln)
    bytes += b
  }
  const shown = (direction === "tail" ? kept.reverse() : kept).join("\n")
  return { shown, truncated: true, totalLines, totalBytes, keptLines: kept.length }
}

/** Machine-actionable continuation cursor appended to a truncated result. */
export function cursorMessage(cap: Capped, o: { fullPath?: string; direction?: "head" | "tail" }): string {
  if (!cap.truncated) return ""
  const full = o.fullPath ? ` Full output saved to ${o.fullPath}` : ""
  if ((o.direction ?? "tail") === "head")
    return `\n[Showing lines 1-${cap.keptLines} of ${cap.totalLines}. Use offset=${cap.keptLines + 1} to continue.${full}]`
  const first = cap.totalLines - cap.keptLines + 1
  return `\n[Showing lines ${first}-${cap.totalLines} of ${cap.totalLines} (last ${cap.keptLines}).${full}${o.fullPath ? " — grep/sed it for earlier lines." : ""}]`
}

/** Cap a tool's output and, when truncated, spill the full text to a temp file referenced by the cursor. */
export function capToolOutput(text: string, o: { direction?: "head" | "tail"; maxLines?: number; maxBytes?: number } = {}): { output: string; spillPath?: string; truncated: boolean } {
  const cap = capText(text, o)
  if (!cap.truncated) return { output: text, truncated: false }
  let spillPath: string | undefined
  try {
    spillPath = path.join(tmpdir(), `fabula-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`)
    writeFileSync(spillPath, text)
  } catch { spillPath = undefined }
  return { output: cap.shown + cursorMessage(cap, { fullPath: spillPath, direction: o.direction }), spillPath, truncated: true }
}
