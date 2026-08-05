// Where things live, resolved the SAME way the engine resolves them.
//
// MEASURED 2026-08-03: twenty-six places under `plugin/` independently rebuilt
// `XDG_DATA_HOME || ~/.local/share` + `/fabula`, and NOT ONE of them honoured `MIMOCODE_HOME` — which the
// engine does honour (`engine/packages/shared/src/global.ts::resolveMimocodeHome`). So setting that one
// variable moves the engine's database and its whole config tree while every plugin store — checkpoints,
// handoffs, the memory store, the ask ledger, the child registry, the KV-cost readings — stays behind at
// the old location. Twenty-six definitions of one rule, and the rule they all got wrong is the same one.
// The contributor guide states the requirement outright — every consumer resolves these the SAME way the
// engine does — and it was true of the app id and false of the root.
//
// This module is the one answer. It mirrors `resolveMimocodeHome` deliberately, including its refusal of a
// relative `MIMOCODE_HOME` — two implementations that disagree about the root would be worse than the
// twenty-six that merely ignored it.
//
// Nothing here is captured at import: HOME can differ between the process that loads a module and the call
// that uses it (the test preload rewrites it, and the engine's own Global.Path reads it live for exactly
// this reason).

import * as path from "node:path"
import * as os from "node:os"
import { current, exeSuffix, hostPlatform, pathListSeparator, type Platform } from "./index"

// Rendered in the TARGET platform's dialect, not the host's: `path.join` answers in the shape of the
// machine running this code, so a Windows host produced backslash paths for the POSIX platforms and
// every rule written with `/` stopped matching. `path` itself stays only where the question really is
// about this machine.
const posix = path.posix
const win = path.win32

const APP = "fabula"

/** The user's home. Env first — Bun caches `os.homedir()` at startup, and tests move HOME. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || env.USERPROFILE || os.homedir()
}

export type BaseDirs = { data: string; cache: string; config: string; state: string }

/**
 * The path dialect of the platform being ASKED about — not of the machine doing the asking.
 *
 * Every function here takes a platform, and for a long time they all joined with the host's `path.join`
 * anyway, which made the parameter a lie: ask a macOS host about Windows and it answered with forward
 * slashes, ask a Windows host about Linux and it answered with backslashes. On a real machine the two
 * agree, so the defect was invisible in production and showed up only where one platform is asked about
 * another — which is precisely where the rules built from these paths are checked.
 */
function dialect(p: Platform) {
  return p === "win32" ? win : posix
}

/**
 * The four base directories, resolved exactly as the engine resolves them.
 *
 * `MIMOCODE_HOME` (absolute) puts all four under one root; otherwise XDG defaults apply. A relative
 * `MIMOCODE_HOME` is REFUSED by the engine with a throw — here it is ignored and the XDG path is used
 * instead, because a plugin hook that throws during path resolution takes down a turn, while the engine
 * throws at startup where the operator sees it. Same decision, different blast radius.
 */
export function baseDirs(env: NodeJS.ProcessEnv = process.env, p: Platform = current(env)): BaseDirs {
  const d = dialect(p)
  const root = env.MIMOCODE_HOME
  if (root && d.isAbsolute(root)) {
    return {
      data: d.join(root, "data"),
      cache: d.join(root, "cache"),
      config: d.join(root, "config"),
      state: d.join(root, "state"),
    }
  }
  const home = homeDir(env)
  return {
    data: d.join(env.XDG_DATA_HOME || d.join(home, ".local", "share"), APP),
    cache: d.join(env.XDG_CACHE_HOME || d.join(home, ".cache"), APP),
    config: d.join(env.XDG_CONFIG_HOME || d.join(home, ".config"), APP),
    state: d.join(env.XDG_STATE_HOME || d.join(home, ".local", "state"), APP),
  }
}

// The two below OPEN REAL FILES ON THIS MACHINE, which makes them a different kind of function from
// everything else here. The rest answer "where would this live on system X" and must therefore answer in
// X's dialect; these two act, here, now, and so they always speak the dialect of the machine acting. The
// distinction is not academic: routing them through the target dialect made a simulated platform produce
// paths this filesystem cannot use, and thirty-five checks failed on stores that had been written under
// names no one could open. `path.join` is correct here for exactly the reason it was wrong there.

/** `<data>/fabula` — where every plugin store belongs. Extra segments are joined onto it. */
export function dataPath(...segments: string[]): string {
  return path.join(baseDirs(process.env, hostPlatform()).data, ...segments)
}

/** `<config>/fabula` — where the supervision stores live (permissions, plugin enable-state). */
export function configPath(...segments: string[]): string {
  return path.join(baseDirs(process.env, hostPlatform()).config, ...segments)
}

/**
 * The engine's config file, resolved the way the engine is TOLD to resolve it.
 *
 * Five modules — escalate, relay, vision, witness, toolcards — each carried their own copy of this
 * three-line lookup, including their own copy of the legacy `mimocode/` fallback. Five copies of one rule
 * is five chances for four of them to keep working while the fifth reads a config that no longer exists,
 * and nothing about that failure announces itself: a plugin that cannot find the config simply behaves as
 * though no cloud provider were set up.
 *
 * `MIMOCODE_CONFIG` wins outright — that is the contract the app sets when it starts the engine, so it is
 * the only fully reliable answer. The legacy candidate is kept for installs that predate the rename;
 * it is deliberately computed from the raw XDG root rather than from `baseDirs`, because it names a
 * directory this project no longer owns.
 */
export function engineConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MIMOCODE_CONFIG) return env.MIMOCODE_CONFIG
  // Acting, not reporting: this path is opened. See the note above dataPath.
  const d = dialect(hostPlatform())
  const primary = d.join(baseDirs(env, hostPlatform()).config, "fabula.config.json")
  const xdgRoot = env.XDG_CONFIG_HOME || d.join(homeDir(env), ".config")
  const legacy = d.join(xdgRoot, "mimocode", "fabula.config.json")
  try {
    const fs = require("node:fs") as typeof import("node:fs")
    if (!fs.existsSync(primary) && fs.existsSync(legacy)) return legacy
  } catch { /* unreadable filesystem — answer with the current location, not the legacy one */ }
  return primary
}

// ── Where executables live ─────────────────────────────────────────────────────────────────────────
//
// A GUI-launched application does not inherit the shell PATH — on macOS it gets launchd's minimal set,
// on Windows the system PATH without the user's profile additions. Four separate lists in this repo had
// each grown their own answer to "where might this tool be", and each was missing something the others
// had. These are the NAMED directories; each caller composes the list it needs, in the order it needs,
// so no consumer silently inherits another's search path.

/** `~/.bun/bin` — where the bun installer puts the runtime. */
export function bunBinDir(env: NodeJS.ProcessEnv = process.env, p: Platform = current(env)): string {
  return dialect(p).join(homeDir(env), ".bun", "bin")
}

/** `~/.local/bin` — the user-level convention on POSIX; kept on Windows for parity with the shim. */
export function localBinDir(env: NodeJS.ProcessEnv = process.env, p: Platform = current(env)): string {
  return dialect(p).join(homeDir(env), ".local", "bin")
}

/** `~/.lmstudio/bin` — where LM Studio puts its `lms` CLI, on every platform it ships for. */
export function servingBinDir(env: NodeJS.ProcessEnv = process.env, p: Platform = current(env)): string {
  return dialect(p).join(homeDir(env), ".lmstudio", "bin")
}

/**
 * System-wide package-manager bin directories.
 *
 * macOS: homebrew on Apple Silicon (`/opt/homebrew/bin`) and on Intel / manual installs
 * (`/usr/local/bin`). Linux: `/usr/local/bin` then `/usr/bin`. Windows: none — there is no
 * distribution-wide bin directory; installers put themselves on PATH, which is the mechanism.
 */
export function systemBinDirs(p: Platform = current()): string[] {
  if (p === "darwin") return ["/opt/homebrew/bin", "/usr/local/bin"]
  if (p === "linux") return ["/usr/local/bin", "/usr/bin"]
  return []
}

/**
 * Where `go install` puts binaries, and where the official Go installer puts `go` itself.
 *
 * Deliberately NOT resolved by shelling out to `go env GOPATH`: that needs `go` on PATH first, which is
 * the very thing being resolved. The documented defaults are used instead.
 */
export function goBinDirs(env: NodeJS.ProcessEnv = process.env, p: Platform = current(env)): string[] {
  const home = homeDir(env)
  const out: string[] = []
  if (env.GOBIN) out.push(env.GOBIN)
  const j = dialect(p).join
  out.push(env.GOPATH ? j(env.GOPATH, "bin") : j(home, "go", "bin"))
  out.push(p === "win32" ? "C:\\Program Files\\Go\\bin" : "/usr/local/go/bin")
  return out
}

/**
 * Every place a named program might live on this platform, in search order.
 *
 * Three modules had each grown their own answer to "where is bun / where is the engine", and each was
 * missing something the others had. This is the one list; the caller adds the filename.
 */
export function programSearchDirs(
  env: NodeJS.ProcessEnv = process.env,
  p: Platform = current(env),
): string[] {
  return [bunBinDir(env, p), ...systemBinDirs(p), localBinDir(env, p)]
}

/**
 * The first existing file named `name` among the search dirs, else `name` itself for PATH to resolve.
 *
 * Returning the bare name rather than null is deliberate: a GUI-launched process has a thin PATH, but a
 * shell-launched one does not, and refusing to run because a program is not in one of four well-known
 * directories would break the ordinary case to protect the unusual one.
 */
export function findProgram(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  p: Platform = current(env),
): string {
  const file = name + exeSuffix(p)
  for (const dir of programSearchDirs(env, p)) {
    const cand = dialect(p).join(dir, file)
    try {
      const fs = require("node:fs") as typeof import("node:fs")
      if (fs.statSync(cand).isFile()) return cand
    } catch { /* not here; try the next */ }
  }
  return name
}

/** Join directories into a PATH string with this platform's separator. */
export function joinPathList(dirs: readonly string[], p: Platform = current()): string {
  return dirs.filter(Boolean).join(pathListSeparator(p))
}

/** Split a PATH string with this platform's separator. */
export function splitPathList(value: string | undefined, p: Platform = current()): string[] {
  if (!value) return []
  return value.split(pathListSeparator(p)).filter(Boolean)
}

/**
 * Append directories to an existing PATH without disturbing what is already there.
 *
 * The caller's own PATH stays IN FRONT, always: an operator who put a directory on PATH has decided, and
 * a helper that reorders that choice is a helper that silently overrides it. Duplicates are dropped so a
 * repeated call cannot grow the variable without bound.
 */
export function appendToPath(
  existing: string | undefined,
  extra: readonly string[],
  p: Platform = current(),
): string {
  const have = splitPathList(existing, p)
  const seen = new Set(have)
  const add = extra.filter((d) => Boolean(d) && !seen.has(d) && !seen.has(d.replace(/[/\\]$/, "")))
  return joinPathList([...have, ...add], p)
}
