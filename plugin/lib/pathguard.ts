// Sensitive-write-path guard. Blocks writes to credential/persistence files that are
// classic backdoor/exfil targets. Tight set (hardline) to avoid false-positives on normal project
// files. The broader "ask"-tier (.env, dotfiles) is policy in fabula-security, not here.

import * as os from "node:os"
import * as path from "node:path"
import { hardlineTargets } from "./platform/persistence"

export interface PathVerdict { blocked: boolean; reason: string; code: string }
const OK: PathVerdict = { blocked: false, reason: "", code: "allow" }

function expand(p: string): string {
  if (typeof p !== "string" || !p) return ""
  let s = p.trim().replace(/^['"]|['"]$/g, "")
  if (s.startsWith("~/") || s === "~") s = path.join(os.homedir(), s.slice(1))
  s = s.replace(/\$\{?HOME\}?/g, os.homedir())
  try { s = path.normalize(s) } catch {}
  return s
}

/**
 * Where a write to `p` actually LANDS, following symlinks whether or not their target exists yet.
 *
 * MEASURED 2026-08-01, with real links on disk. The previous resolver opened with `fs.existsSync(p)`,
 * and `existsSync` FOLLOWS a link — so it answers false for a link whose target is missing. A link to an
 * EXISTING `~/.ssh/id_ed25519` was blocked; a link to a NOT-YET-EXISTING `~/.ssh/authorized_keys` was
 * ALLOWED, and so were links to `/etc/sudoers.d/99-evil` and `~/Library/LaunchAgents/evil.plist`. Every
 * one of those targets is a file whose whole danger is that it does not exist yet — the guard was open
 * in exactly the case it was written for, and proven so end-to-end: a write through a dangling link
 * created `authorized_keys` containing an SSH key. `cmdguard` does not cover the setup either, so the
 * link and the write were both permitted.
 *
 * `lstat` is the correct question — "is THIS NAME a link", which does not depend on the target existing.
 * The chain is then followed by hand, bounded, and the surviving path resolved through its directory so
 * a not-yet-created final component still lands on its true parent.
 */
export function resolveWriteTarget(p: string): string {
  try {
    const fs = require("node:fs") as typeof import("node:fs")
    let cur = p
    // Bounded: a symlink loop is a real on-disk shape and must not hang the guard.
    for (let hop = 0; hop < 32; hop++) {
      let st: import("node:fs").Stats
      try {
        st = fs.lstatSync(cur)
      } catch {
        break // the name itself does not exist — nothing more to follow
      }
      if (!st.isSymbolicLink()) break
      const link = fs.readlinkSync(cur)
      const next = path.resolve(path.dirname(cur), link)
      if (next === cur) break
      cur = next
    }
    if (fs.existsSync(cur)) return fs.realpathSync(cur)
    const dir = path.dirname(cur)
    if (fs.existsSync(dir)) return path.join(fs.realpathSync(dir), path.basename(cur))
    return cur
  } catch {
    /* an unresolvable path is checked as written — never fail open on an error here */
  }
  return p
}

/** Catastrophic write targets: SSH backdoors, system auth files, cron, shell-history poisoning. */
export function checkWritePath(rawPath: string): PathVerdict {
  const p = expand(rawPath)
  if (!p) return OK
  // Resolve symlinks before matching. Every rule below compares STRINGS, so `ln -s <target> ./notes.json`
  // followed by a write to `./notes.json` walked straight past all of them — the guard was checking the
  // name the caller chose rather than the file it lands on. `realpath` on the PARENT (the file itself may
  // not exist yet) plus the basename gives the true destination without requiring the write to have
  // happened first.
  const real = resolveWriteTarget(p)
  // Every spelling this write could be reasonably described by, matched against every rule.
  //
  // The `/private` twin is not a nicety: on macOS `/etc`, `/var` and `/tmp` ARE symlinks into
  // `/private`, so the moment the resolver above started doing its job it also started rewriting
  // `/etc/sudoers.d/99-evil` into `/private/etc/sudoers.d/99-evil` — which no `/etc/...` rule matches.
  // Found by probing the fixed resolver rather than by reading it: the sudoers case went from blocked to
  // allowed as a direct result of resolving symlinks correctly. The engine hit the same twin in
  // instanceDirectoryAllowed and answered it the same way — compare both spellings.
  for (const cand of new Set([real, stripPrivate(real), p, stripPrivate(p)])) {
    const verdict = matchWriteRules(cand)
    if (verdict.blocked) return verdict
  }
  return OK
}

/** macOS serves `/etc`, `/var` and `/tmp` as symlinks into `/private`. Both spellings name one file. */
function stripPrivate(p: string): string {
  return p.replace(/^\/private(\/(?:etc|var|tmp)(?:\/|$))/, "$1")
}

/**
 * The rules themselves live in `platform/persistence.ts`, in ONE ordered list per platform, because the
 * kernel profile in `lib/sandbox.ts` has to enforce the same set and used to carry its own hand-written
 * copy of it. A mirror is something that can stop reflecting: add a target to one list and the other
 * keeps enforcing the old set, so the in-process rules and the kernel disagree exactly where nobody looks.
 *
 * This function is now only the MATCHER — first rule that matches wins, and order is contract (a write to
 * this user's own `~/.ssh/authorized_keys` reports `ssh_authorized_keys`; anyone else's reports the
 * generic `ssh_key`).
 */
function matchWriteRules(p: string): PathVerdict {
  for (const target of hardlineTargets()) {
    for (const pat of target.match) {
      const m = typeof pat === "string" ? p === pat || p.startsWith(pat) : pat.test(p)
      if (m) return { blocked: true, code: target.code, reason: target.reason }
    }
  }
  return OK
}

/**
 * Does this tool NAME describe writing?
 *
 * MEASURED 2026-08-01: the guard ran for a hand-written set of five names — write, edit, patch,
 * create_file, str_replace — and every other write path in the product walked past it. Driven through
 * the real hook at `~/.ssh/authorized_keys`, `apply_patch`, `notebook_edit`, `str_replace_editor`,
 * `view_str_replace`, `note_append` and `save_skill` were all ALLOWED. `apply_patch` is not a hypothetical
 * spare: for a gpt-class model in the socket the engine REMOVES the guarded write/edit tools and exposes
 * only that one, so the whole guard would be off for that model.
 *
 * A list of five names cannot keep up with a tool registry that grows, and an MCP server can add a write
 * tool nobody here will ever hear about. So the question is asked of the NAME's own vocabulary, the same
 * open-vocabulary move the loop guard made when tool-name classing failed it. A tool that reads —
 * read, view, glob, grep, list, search — matches none of these verbs and is not touched.
 */
// Matched as SUBSTRINGS, deliberately. `multiedit` has no separator around its verb and was missed by a
// word-boundary rule — found by running the list, not by reading it. The asymmetry of costs settles the
// question: a false NEGATIVE is an unguarded write to authorized_keys, while a false POSITIVE only means
// checkWritePath runs over a read tool's arguments and finds nothing catastrophic there. So this leans
// permissive about what counts as a write.
const WRITE_VERB = /(write|edit|patch|creat|save|append|insert|replace|delet|remove|rename|mkdir|upload)/i
// Short verbs that ARE common substrings of unrelated words (out-PUT, in-PUT, com-PUTE, re-MOVE-d,
// un-TOUCH-ed) need a separator, or every tool with "output" in its name becomes a write.
const WRITE_VERB_BOUNDED = /(?:^|[^a-z])(put|move|touch|mv|cp|rm)(?:[^a-z]|$)/i

export function isWriteToolName(name: unknown): boolean {
  if (typeof name !== "string" || !name) return false
  return WRITE_VERB.test(name) || WRITE_VERB_BOUNDED.test(name)
}

/** Every path a write call will land on, from whatever shape the tool carries them in.
 *
 *  `apply_patch` is why this exists as more than a field lookup: its ONLY argument is `patch_text`, so
 *  `args.filePath ?? args.path ?? args.file` can never extract anything and the guard silently checked
 *  nothing. The targets are right there in the patch header — they just have to be read. */
export function writeTargets(args: any): string[] {
  const out: string[] = []
  if (!args || typeof args !== "object") return out
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim())
  }
  for (const k of ["filePath", "file_path", "path", "file", "notebook_path", "target_file", "filename", "dest", "destination", "newPath", "new_path"]) {
    push((args as any)[k])
  }
  // Batch shapes: a list of edits/files each carrying its own path.
  for (const k of ["files", "edits", "operations", "changes"]) {
    const arr = (args as any)[k]
    if (Array.isArray(arr)) for (const e of arr) out.push(...writeTargets(e))
  }
  // Patch bodies: the engine's own apply_patch envelope, and ordinary unified diffs.
  for (const k of ["patch_text", "patch", "diff", "content"]) {
    const text = (args as any)[k]
    if (typeof text !== "string" || text.length > 4_000_000) continue
    for (const m of text.matchAll(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/gim)) push(m[1])
    for (const m of text.matchAll(/^\*\*\*\s+Move\s+to:\s*(.+?)\s*$/gim)) push(m[1])
    for (const m of text.matchAll(/^\+\+\+\s+(?:b\/)?(.+?)\s*$/gm)) {
      if (m[1] !== "/dev/null") push(m[1])
    }
  }
  return [...new Set(out)]
}

export function writeBlockedMessage(v: PathVerdict, p: string): string {
  return `[BLOCKED by FABULA security — write:${v.code}] Refused to write ${String(p).slice(0, 200)}: ${v.reason} ` +
    `Choose a project-local path instead.`
}
