// File-state staleness guard. Pure: callers pass
// in mtime numbers (fs lives in the tools). Tracks per-session "did we read this file, and has it
// changed since?" so edits aren't applied blind or onto externally-modified files. LRU-bounded.

interface ReadRec { mtimeMs: number; readTs: number; partial: boolean }

export interface StaleVerdict {
  neverRead: boolean
  stale: boolean        // file changed on disk since we last read it
  partialOnly: boolean  // we only read part of it (view_range / truncated)
  note: string          // advisory text ("" if all clear)
}

const MAX_SESSIONS = 256

class FileStateTracker {
  private sessions = new Map<string, Map<string, ReadRec>>()
  private clock = 0
  private order: string[] = [] // LRU of sessionIDs

  private bump(sid: string): Map<string, ReadRec> {
    let m = this.sessions.get(sid)
    if (!m) {
      m = new Map()
      this.sessions.set(sid, m)
      this.order.push(sid)
      if (this.sessions.size > MAX_SESSIONS) {
        const old = this.order.shift()
        if (old !== undefined) this.sessions.delete(old)
      }
    }
    return m
  }

  recordRead(sid: string, path: string, mtimeMs: number, partial = false): void {
    if (!sid || !path) return
    this.bump(sid).set(path, { mtimeMs, readTs: ++this.clock, partial })
  }

  /** Evaluate just before a write. currentMtimeMs = mtime on disk now (NaN/undefined if new file). */
  checkStale(sid: string, path: string, currentMtimeMs?: number): StaleVerdict {
    const rec = this.sessions.get(sid)?.get(path)
    if (!rec) return { neverRead: true, stale: false, partialOnly: false, note: "" }
    const stale = typeof currentMtimeMs === "number" && Number.isFinite(currentMtimeMs) && currentMtimeMs > rec.mtimeMs
    let note = ""
    if (stale) note = "the file changed on disk since you last read it — your edit may be based on stale content; re-read before editing."
    else if (rec.partial) note = "you only read PART of this file; make sure your edit target is unambiguous."
    return { neverRead: false, stale, partialOnly: rec.partial, note }
  }

  noteWrite(sid: string, path: string, mtimeMs: number): void {
    if (!sid || !path) return
    // after our own write the on-disk state IS what we just produced → treat as freshly read (full)
    this.bump(sid).set(path, { mtimeMs, readTs: ++this.clock, partial: false })
  }

  dropSession(sid: string): void {
    this.sessions.delete(sid)
    this.order = this.order.filter((s) => s !== sid)
  }
}

export const fileState = new FileStateTracker()

/** Advisory note for an edit on a file that was never read (encourage read-before-edit). */
export function neverReadNote(path: string): string {
  return `you are editing ${path} without having read it this session — verify the target exists and is unique.`
}
