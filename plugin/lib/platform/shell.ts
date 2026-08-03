// How the harness runs a command line, defined ONCE.
//
// Twenty-five files under `plugin/` spawn a shell, and every one of them spelled it out itself:
// `spawn("bash", ["-lc", cmd])`, `spawnSync("bash", ["-c", cmd])`, `execFile("/bin/bash", ["-lc", cmd])`.
// Four of them ran the SAME command — `git diff HEAD -- . 2>/dev/null || git diff 2>/dev/null` — in four
// places. That is not twenty-five decisions, it is one decision written twenty-five times, and a port is
// the moment it becomes twenty-five decisions per platform unless it is collapsed first.
//
// The shell matters far beyond convenience: `lib/cmdguard.ts` and `lib/shelltargets.ts` READ command
// text to decide what it writes to and dials out to. Those readers understand POSIX shell grammar. Route
// some commands through a different shell and the guards go blind on exactly those — a supervision layer
// with a hole shaped like whichever platform was added last. So the harness commits to ONE shell family
// everywhere, and where the platform does not ship it, it is a declared dependency rather than a silent
// substitution.

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import * as path from "node:path"
import { current, exeSuffix, type Platform } from "./index"
import { homeDir, splitPathList } from "./paths"

/**
 * Where a POSIX shell lives on this platform.
 *
 * On Windows this is Git for Windows' `bash.exe`, which arrives with `winget install Git.Git` — the same
 * dependency the harness already requires for `git` itself, so it costs the user nothing extra. The
 * alternative (running commands through PowerShell) would mean a SECOND grammar for `cmdguard` and
 * `shelltargets` to parse, i.e. a second definition of every command-safety rule. This project has paid
 * for two-definitions-of-one-rule more than for any other defect, and a security rule is the worst place
 * to accept it. One shell, one grammar, one set of guards.
 *
 * `FABULA_SHELL_BIN` names it explicitly when it lives somewhere unusual.
 */
export function shellBin(env: NodeJS.ProcessEnv = process.env, p: Platform = current(env)): string {
  const named = env.FABULA_SHELL_BIN
  if (named) return named
  if (p !== "win32") return "bash"
  for (const cand of [
    path.join(env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    path.join(env.LOCALAPPDATA || path.join(homeDir(env), "AppData", "Local"), "Programs", "Git", "bin", "bash.exe"),
  ]) {
    try { if (statSync(cand).isFile()) return cand } catch { /* try the next */ }
  }
  return "bash" // let PATH answer; if it cannot, the caller reports a missing shell rather than guessing
}

export interface ShellOptions {
  /** A LOGIN shell (`-lc`) sources the user's profile — the default, and what every caller used. */
  login?: boolean
  env?: NodeJS.ProcessEnv
  platform?: Platform
}

/**
 * argv for running a command line under the harness's shell.
 *
 * This is the single definition every other layer composes onto: `execbackend.bashArgv` wraps it for the
 * docker and sandbox backends, and the sandbox builders put their own runner in front of it. Changing the
 * shell contract is therefore one edit, not twenty-five.
 */
export function shellArgv(command: string, opts: ShellOptions = {}): string[] {
  const env = opts.env ?? process.env
  const p = opts.platform ?? current(env)
  const flag = opts.login === false ? "-c" : "-lc"
  return [shellBin(env, p), flag, command]
}

/** Spawn a shell command, leaving the caller its own timeout / cap / abort handling. */
export function spawnShell(command: string, opts: ShellOptions & SpawnOptions = {}): ChildProcess {
  const argv = shellArgv(command, opts)
  const { login: _l, platform: _p, ...spawnOpts } = opts as any
  return spawn(argv[0]!, argv.slice(1), { env: process.env, ...spawnOpts })
}

export interface CaptureResult { code: number | null; out: string }

/**
 * Run a shell command and collect its merged output.
 *
 * Merged deliberately: every caller being replaced here already merged the two streams, because a tool
 * that reports a failure on stderr and nothing on stdout must not read as having produced nothing. The
 * default 30s ceiling is a backstop, not a policy — callers with a real budget pass their own.
 */
export function captureShell(
  command: string,
  opts: ShellOptions & { cwd?: string; timeoutMs?: number; maxChars?: number } = {},
): Promise<CaptureResult> {
  const cap = opts.maxChars ?? 2_000_000
  return new Promise<CaptureResult>((resolve) => {
    let child: ChildProcess
    try {
      child = spawnShell(command, { ...opts, cwd: opts.cwd, env: opts.env ?? process.env })
    } catch (e: any) {
      resolve({ code: null, out: String(e?.message ?? e) })
      return
    }
    let out = ""
    let done = false
    const finish = (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, out })
    }
    const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch {} ; finish(null) }, opts.timeoutMs ?? 30_000)
    const take = (d: unknown) => { if (out.length < cap) out += String(d) }
    child.stdout?.on("data", take)
    child.stderr?.on("data", take)
    child.on("error", (e) => { out += String((e as any)?.message ?? e); finish(null) })
    child.on("close", (code) => finish(code))
  })
}

/**
 * The working tree's diff against HEAD, with the fallback every caller already carried.
 *
 * Four modules ran this exact command line — fabula-change-quiz, fabula-shipnotes, fabula-witness and
 * lib/gitdiff — each with its own copy of the `|| git diff` fallback and its own timeout. The fallback is
 * load-bearing (a repository with no commits yet has no HEAD to diff against), which is precisely why
 * having it in four places was a liability: three of them could keep it while the fourth quietly lost it.
 */
export function gitDiffHead(dir: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  return captureShell("git diff HEAD -- . 2>/dev/null || git diff 2>/dev/null", {
    cwd: dir,
    timeoutMs: opts.timeoutMs ?? 30_000,
  }).then((r) => r.out)
}

/**
 * Resolve a binary on PATH without spawning anything.
 *
 * The call this replaces was `execFile("which", [name])` — one process per candidate, and `which` is not
 * a program on Windows. Reading PATH directly is both portable and strictly cheaper; it also removes a
 * failure mode the old form had, where a loaded machine or a network-mounted PATH entry could wedge the
 * lookup for its whole timeout.
 *
 * On Windows a bare name is tried against PATHEXT, so `where`-style resolution of `git` → `git.exe` works
 * without the caller knowing which platform it is on.
 */
export function whichBin(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  p: Platform = current(env),
): string | null {
  if (!name) return null
  // An explicit path is honoured as given — a caller who named a file has decided.
  if (name.includes("/") || name.includes("\\")) {
    try { return statSync(name).isFile() ? name : null } catch { return null }
  }
  const exts = p === "win32"
    ? splitPathList(env.PATHEXT || ".COM;.EXE;.BAT;.CMD", p).map((e) => e.toLowerCase())
    : [""]
  for (const dir of splitPathList(env.PATH, p)) {
    for (const ext of exts) {
      const cand = path.join(dir, name + (ext === exeSuffix(p) ? ext : ext))
      try {
        if (existsSync(cand) && statSync(cand).isFile()) return cand
      } catch { /* unreadable entry on PATH — keep looking */ }
    }
  }
  return null
}

/** First of `names` that resolves on PATH, or null. Replaces the per-candidate `which` spawn loop. */
export function whichFirst(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  p: Platform = current(env),
): string | null {
  for (const n of names) {
    const hit = whichBin(n, env, p)
    if (hit) return hit
  }
  return null
}
