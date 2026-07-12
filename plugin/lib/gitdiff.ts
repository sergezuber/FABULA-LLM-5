// Full working-tree diff INCLUDING untracked files (the receipt's artifact). `git diff HEAD` alone
// silently omits brand-new files — but the model's reproducing test is normally a NEW file, and a
// published Proof-of-Done receipt whose patch is missing the test would be unreplayable evidence.
// Technique: stage everything into a THROWAWAY index (GIT_INDEX_FILE) and diff that against HEAD —
// the user's real index and working tree are never touched.

import { spawn } from "node:child_process"

const SCRIPT = `
set -e
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
export GIT_INDEX_FILE="$tmp"
git read-tree HEAD
git add -A -- . ':(exclude).fabula' ':(exclude)**/.fabula' >/dev/null 2>&1
git diff --cached HEAD -- . ':(exclude).fabula' ':(exclude)**/.fabula'
`

export interface GitDiffResult {
  diff: string
  /** true when the diff is PARTIAL — byte cap hit, timeout kill, or non-zero exit with partial stdout.
   *  A partial diff is cut mid-hunk: persisting it as a .patch mints corrupt, unapplyable evidence. */
  truncated: boolean
}

/** Diff of tracked changes AND untracked files vs HEAD; empty string outside a git repo. */
export async function gitDiffAll(dir: string, maxBytes = 200_000, timeoutMs = 8000): Promise<string> {
  return (await gitDiffAllInfo(dir, maxBytes, timeoutMs)).diff
}

/** Same diff, plus the truncation flag consumers need before treating the diff as a replayable patch. */
export async function gitDiffAllInfo(dir: string, maxBytes = 200_000, timeoutMs = 8000): Promise<GitDiffResult> {
  const first = await gitDiffAllOnce(dir, maxBytes, timeoutMs)
  if (first.diff) return first
  // Under heavy parallel load a spawn can fail transiently (EAGAIN) — one short retry before
  // concluding "no diff" (an empty diff is also legitimately possible, so the retry is cheap-only).
  await new Promise((r) => setTimeout(r, 150))
  return gitDiffAllOnce(dir, maxBytes, timeoutMs)
}

// Append a chunk under a CHARACTER cap, flagging when data is actually dropped. `truncated` must be
// measured in the same unit the diff is cut with (chars) — comparing captured BYTES to a char cap
// falsely flagged fully-captured multibyte diffs, dropping a perfectly applyable patch from the receipt.
function appendCapped(state: { out: string; dropped: boolean }, chunk: Buffer, maxBytes: number) {
  if (state.out.length >= maxBytes) { state.dropped = true; return }
  state.out += chunk.toString()
  if (state.out.length > maxBytes) { state.out = state.out.slice(0, maxBytes); state.dropped = true }
}

function gitDiffAllOnce(dir: string, maxBytes: number, timeoutMs: number): Promise<GitDiffResult> {
  return new Promise((resolve) => {
    const c = spawn("bash", ["-c", SCRIPT], { cwd: dir, env: process.env })
    const s = { out: "", dropped: false }
    let killed = false
    let fallbackNeeded = false
    const t = setTimeout(() => { killed = true; try { c.kill() } catch {} }, timeoutMs)
    c.stdout.on("data", (d) => appendCapped(s, d, maxBytes))
    c.on("close", (code) => {
      clearTimeout(t)
      if (code === 0 || s.out.trim()) {
        return resolve({ diff: s.out, truncated: killed || s.dropped || (code !== 0 && !!s.out.trim()) })
      }
      fallbackNeeded = true
      // Fallback (e.g. no HEAD yet): plain diff of tracked changes.
      const f = spawn("bash", ["-lc", "git diff HEAD -- . 2>/dev/null || git diff 2>/dev/null"], { cwd: dir, env: process.env })
      const fs2 = { out: "", dropped: false }
      let fkilled = false
      const ft = setTimeout(() => { fkilled = true; try { f.kill() } catch {} }, timeoutMs)
      f.stdout.on("data", (d) => appendCapped(fs2, d, maxBytes))
      f.on("close", (fcode) => {
        clearTimeout(ft)
        resolve({ diff: fs2.out, truncated: fkilled || fs2.dropped || (fcode !== 0 && !!fs2.out.trim()) })
      })
      f.on("error", () => { clearTimeout(ft); resolve({ diff: "", truncated: false }) })
    })
    c.on("error", () => { clearTimeout(t); if (!fallbackNeeded) resolve({ diff: "", truncated: false }) })
  })
}
