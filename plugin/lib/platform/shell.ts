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
import { current, hostPlatform, type Platform } from "./index"
import { homeDir, pathDialect, splitPathList } from "./paths"

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
  const j = pathDialect(p).join
  for (const cand of [
    j(env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    j(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    j(env.LOCALAPPDATA || j(homeDir(env), "AppData", "Local"), "Programs", "Git", "bin", "bash.exe"),
  ]) {
    try { if (statSync(cand).isFile()) return cand } catch { /* try the next */ }
  }
  return "bash" // let PATH answer; if it cannot, the caller reports a missing shell rather than guessing
}

/**
 * The shell as an ABSOLUTE path, for the files that cannot search for it.
 *
 * `shellBin` deliberately answers with a bare `bash` on POSIX and lets PATH resolve it — right for
 * spawning, wrong for a scheduler definition. launchd and systemd do not search PATH: a plist or unit
 * whose program is `bash` fails to start, and it fails at the one moment nobody is watching, which is the
 * whole failure mode the job ledger exists to make visible. Caught by a check that had spelled
 * `/bin/bash` literally and went red when the resolver was wired in.
 *
 * PATH is consulted first so an operator's own shell wins, then the platform's documented location. The
 * answer is always absolute; there is no branch that returns a bare name.
 */
export function shellBinAbsolute(env: NodeJS.ProcessEnv = process.env, p: Platform = current(env)): string {
  const named = env.FABULA_SHELL_BIN
  if (named) return named
  const resolved = whichBin(shellBin(env, p), env, p)
  if (resolved && resolved.includes(p === "win32" ? "\\" : "/")) return resolved
  return p === "win32"
    ? pathDialect(p).join(env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe")
    : "/bin/bash"
}

/**
 * A path from THIS machine, written so the harness's POSIX shell reads it as that same path.
 *
 * The shell is POSIX everywhere — that is the whole point of committing to one grammar — but the paths
 * handed to it come from a filesystem that may spell them with backslashes. Embedding one directly puts
 * `C:\Users\x\argv.log` inside a POSIX script, where the backslashes are escape characters: the shell
 * writes to something else entirely and the caller sees an empty file rather than an error. MEASURED
 * exactly that way — a stand-in program logged every call it received into a file nobody could find, and
 * the checks reported the tools never ran.
 *
 * The drive-lettered form with forward slashes is what the Git-shipped shell understands, and single
 * quotes stop the rest of the line from being interpreted. On POSIX this is the path unchanged.
 */
export function shellPathLiteral(p: string): string {
  const posixForm = String(p).replace(/\\/g, "/")
  return `'${posixForm.replace(/'/g, "'\\''")}'`
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
      // The CONVENTIONS come from the platform asked about — which separator splits PATH, and whether a
      // bare name needs an extension. The JOIN is the host's, because the next line asks this filesystem
      // whether the file is there: acting, not reporting. On a real machine the two are the same; they
      // differ only while one platform is being asked about from another, which is exactly when a
      // host-shaped `existsSync` on a target-shaped path answers no about a file that is present.
      const cand = path.join(dir, name + ext)
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

/**
 * Write a marker script the harness can be pointed at, and return the path to point at.
 *
 * WHY THIS EXISTS. Several suites prove a mechanism is really INVOKED by handing the harness a stand-in
 * program that records the argv it was asked to run — `FABULA_LMS_BIN`, `FABULA_GO_EXEC_SHIM`,
 * `FABULA_NVIDIA_SMI`. Without that, a mutation which decides to act and then never acts passes
 * everything, which is this repository's most-repeated trap. So the stand-in is not a convenience; it is
 * what makes those suites able to fail.
 *
 * It was written as a `#!/bin/sh` file, and Windows does not execute a file by its shebang: fifty-two
 * checks went red there on a probe that could not start, reporting the harness broken when what was
 * missing was the ability to run the probe. Rather than silence them — the mechanism they cover is real —
 * the SCRIPT stays one definition and Windows gets a `.cmd` beside it that hands the same file to the same
 * POSIX shell the harness already requires everywhere. One script, two ways in.
 */
/**
 * A stand-in program that records the arguments it was called with, one per line.
 *
 * This is the ONE shape every "prove the mechanism really invoked something" check needs, and it is
 * worth its own helper because the general marker — a POSIX script plus a wrapper that hands it to the
 * POSIX shell — is a chain of three programs on Windows, and a chain is a thing that can break quietly
 * with `stdio: "ignore"`. MEASURED: the argv file simply never appeared, and the checks read that as the
 * traversal never launching its worker, which is the very substitution they exist to catch.
 *
 * So each platform gets a recorder written in something it starts WITHOUT help: a `/bin/sh` script where
 * that exists, and elsewhere a PowerShell script plus the one-line command file that Windows uses to
 * start it. `-File` is deliberate — it binds the caller's arguments to `$args` intact, quoting and
 * spaces included, which `-Command` does not.
 *
 * Returns the path to hand the harness.
 */
export function writeArgvRecorder(
  scriptPath: string,
  logPath: string,
  env: NodeJS.ProcessEnv = process.env,
  p: Platform = hostPlatform(),
): string {
  const fs = require("node:fs") as typeof import("node:fs")
  if (p !== "win32") {
    fs.writeFileSync(scriptPath, `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellPathLiteral(logPath)}\nexit 0\n`)
    fs.chmodSync(scriptPath, 0o755)
    return scriptPath
  }
  // ONE program, started directly by the command interpreter — no second interpreter in the chain.
  //
  // The first version handed the arguments to PowerShell. That works when every link works, and when it
  // does not there is nothing to read: the child's output is ignored by design, so a chain that breaks
  // in the middle is indistinguishable from one that never started. It broke, silently, and cost several
  // rounds. Batch can do this itself: `%~1` yields one argument with its quoting removed, and `shift`
  // walks them, so an argument containing spaces survives — which the obvious `for %%A in (%*)` does not.
  const cmd = scriptPath.replace(/\.[^.\\/]*$/, "") + ".cmd"
  fs.writeFileSync(
    cmd,
    [
      "@echo off",
      `break > "${logPath}"`,
      ":fabula_loop",
      'if "%~1"=="" goto fabula_end',
      `>> "${logPath}" echo %~1`,
      "shift",
      "goto fabula_loop",
      ":fabula_end",
      "exit /b 0",
      "",
    ].join("\r\n"),
  )
  return cmd
}

export function writeMarkerScript(
  scriptPath: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env,
  // The HOST, deliberately, not `current()`. This function ACTS: it writes a file that THIS machine will
  // be asked to execute. A test simulating Windows on a Mac would otherwise get a `.cmd` wrapper that
  // macOS cannot run, and the check it protects would report the harness broken when the only thing
  // missing is the ability to start the stand-in. Reporting follows the platform asked about; acting
  // follows the machine acting — the same line drawn in `paths.ts` for `dataPath`.
  p: Platform = hostPlatform(),
): string {
  const fs = require("node:fs") as typeof import("node:fs")
  fs.writeFileSync(scriptPath, body.startsWith("#!") ? body : `#!/bin/sh\n${body}`)
  fs.chmodSync(scriptPath, 0o755)
  if (p !== "win32") return scriptPath
  // `%~f1`-free on purpose: the wrapper names the script by absolute path, so it does not matter which
  // directory the harness happens to spawn it from.
  const cmd = `${scriptPath}.cmd`
  const shell = shellBin(env, p).replace(/\//g, "\\")
  fs.writeFileSync(cmd, `@echo off\r\n"${shell}" "${scriptPath}" %*\r\n`)
  return cmd
}
