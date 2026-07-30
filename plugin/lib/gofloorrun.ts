// FABULA-LLM-5 — running the Go floor. The IO half of lib/gofloor.ts (which stays pure).
//
// `exec` is INJECTABLE, and that is load-bearing rather than tidy: this repo's recurring defect is a
// green pure core wired to nothing (see the corpus worker, which passed an identical suite against a
// dead implementation). With exec injected, a test drives the real orchestrator — tool probing, arg
// construction, timeout, parse, aggregate — and a mutation that stops a tool from being invoked fails
// a test instead of passing one.
//
// Every failure mode degrades: a missing tool is NAMED in `missing`, a timeout drops that tool only, a
// tool that exits non-zero still has its stdout parsed (gosec and staticcheck exit non-zero precisely
// BECAUSE they found something — treating a non-zero exit as failure would discard every real finding).

import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import {
  parseGoVet,
  parseGolangciLint,
  parseGosec,
  parseGovulncheck,
  parseNilaway,
  parseStaticcheck,
  looksGoModule,
  goToolPath,
  looksLikeUsageError,
  normalizeFindings,
  safeGoTarget,
  type FloorResult,
  type GoFinding,
} from "./gofloor"

export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
  /** true when the call was cut by the timeout rather than exiting on its own. */
  timedOut?: boolean
}

/** Run a command. The plugin supplies a real spawn; tests supply a fake or a marker script. */
export type Exec = (argv: readonly string[], opts: { cwd: string; timeoutMs: number }) => Promise<ExecResult>

export interface GoToolSpec {
  name: string
  /** argv that exits 0 iff the tool is usable here. */
  probe: readonly string[]
  /** argv for the analysis run, module-wide. */
  run: (target: string) => readonly string[]
  parse: (stdout: string, root?: string) => GoFinding[]
  /** Some tools put their findings on stderr (go vet always does; NilAway may). */
  readsStderr?: boolean
  /**
   * A SECOND argv form, tried once when the first is rejected as a usage error. Exists because
   * golangci-lint renamed its JSON flag between v1 (`--out-format json`) and v2
   * (`--output.json.path stdout`), and a floor that supports only one silently loses that tool on the
   * other. One bounded retry, never a loop.
   */
  runLegacy?: (target: string) => readonly string[]
}

/**
 * The tool table. Order is deliberate — govulncheck first because it is the only one whose output
 * carries reachability, so a caller reading a truncated block still sees the strongest evidence.
 *
 * `go vet` is listed without a probe: it ships inside the Go toolchain, so if `go` runs at all it runs.
 */
export const GO_TOOL_SPECS: readonly GoToolSpec[] = Object.freeze([
  {
    name: "govulncheck",
    probe: ["govulncheck", "-h"],
    run: (t) => ["govulncheck", "-format", "json", t],
    parse: parseGovulncheck,
  },
  {
    name: "gosec",
    probe: ["gosec", "-help"],
    // -quiet would hide the summary but also the JSON on some builds; -fmt=json is the contract.
    run: (t) => ["gosec", "-fmt=json", "-no-fail", t],
    parse: parseGosec,
  },
  {
    name: "staticcheck",
    probe: ["staticcheck", "-version"],
    run: (t) => ["staticcheck", "-f", "json", t],
    parse: parseStaticcheck,
  },
  {
    name: "nilaway",
    probe: ["nilaway", "-h"],
    run: (t) => ["nilaway", t],
    parse: parseNilaway,
    readsStderr: true,
  },
  {
    name: "go vet",
    probe: ["go", "version"],
    run: (t) => ["go", "vet", t],
    parse: parseGoVet,
    readsStderr: true,
  },
  {
    name: "golangci-lint",
    probe: ["golangci-lint", "--version"],
    // v2 syntax (verified against 2.12.2 on 2026-07-30); v1's `--out-format json` is the legacy retry.
    run: (t) => ["golangci-lint", "run", "--output.json.path", "stdout", t],
    runLegacy: (t) => ["golangci-lint", "run", "--out-format", "json", t],
    parse: parseGolangciLint,
  },
])

export const DEFAULT_FLOOR_TIMEOUT_MS = 90_000
/** A probe that hangs is a broken install; it must not spend the whole floor budget. */
export const PROBE_TIMEOUT_MS = 4_000

export interface FloorOptions {
  dir: string
  exec: Exec
  env?: Record<string, string | undefined>
  /** Analysis target passed to each tool. `./...` = the whole module (govulncheck needs it for the
   *  call graph; a single-file target cannot produce reachability). */
  target?: string
  timeoutMs?: number
  specs?: readonly GoToolSpec[]
}

/** POLICY: which tools are asked for. `FABULA_GO_TOOLS` narrows it (comma-separated names); absent =
 *  all of them. Narrowing is a real need — a repo where `golangci-lint` takes minutes should be able
 *  to drop it without losing the rest of the floor. */
export function selectedTools(env: Record<string, string | undefined> | undefined, specs: readonly GoToolSpec[]): GoToolSpec[] {
  const raw = (env?.FABULA_GO_TOOLS ?? "").trim()
  if (!raw) return [...specs]
  const want = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
  const chosen = specs.filter((s) => want.has(s.name.toLowerCase()))
  // An unreadable selection must not silently disable the floor entirely.
  return chosen.length ? chosen : [...specs]
}

/**
 * Probe, run, parse, aggregate. Never throws.
 *
 * The budget is per-tool, not shared: one slow tool cannot starve the rest, and the caller's wall
 * clock is bounded by (tools × timeout) which is why the default per-tool budget is modest.
 */
export async function runFloor(opts: FloorOptions): Promise<FloorResult> {
  const specs = selectedTools(opts.env, opts.specs ?? GO_TOOL_SPECS)
  // The target lands in the analyser's argv, and Go tools take flags in any position — so a value the
  // model chose is validated HERE, at the choke point, not at each call site. A refused target falls
  // back to the whole module rather than failing: the floor still runs, it just runs on what it should.
  const target = safeGoTarget(opts.target ?? "./...") ?? "./..."
  const timeoutMs = opts.timeoutMs ?? Number(opts.env?.FABULA_GO_FLOOR_TIMEOUT_MS || DEFAULT_FLOOR_TIMEOUT_MS)
  const ran: string[] = []
  const missing: string[] = []
  const all: GoFinding[] = []

  for (const spec of specs) {
    let usable = false
    try {
      const p = await opts.exec(spec.probe, { cwd: opts.dir, timeoutMs: PROBE_TIMEOUT_MS })
      // A tool that prints help and exits non-zero (gosec -help does) is still installed. What proves
      // absence is the shell reporting it cannot be found.
      usable = !p.timedOut && !/command not found|not found|no such file|ENOENT/i.test(`${p.stderr}\n${p.stdout}`)
    } catch {
      usable = false
    }
    if (!usable) {
      missing.push(spec.name)
      continue
    }
    try {
      let r = await opts.exec(spec.run(target), { cwd: opts.dir, timeoutMs })
      if (r.timedOut) {
        missing.push(`${spec.name} (timed out after ${Math.round(timeoutMs / 1000)}s)`)
        continue
      }
      // A tool that rejected its OWN arguments analysed nothing. One bounded retry on the legacy argv
      // (tools rename flags between majors), then it goes to `missing` — never to `ran`, because a tool
      // that never looked at the code must not read as a tool that found nothing.
      if (looksLikeUsageError(`${r.stderr}\n${r.stdout}`)) {
        if (spec.runLegacy) r = await opts.exec(spec.runLegacy(target), { cwd: opts.dir, timeoutMs })
        if (r.timedOut || looksLikeUsageError(`${r.stderr}\n${r.stdout}`)) {
          missing.push(`${spec.name} (rejected its arguments — flag syntax changed?)`)
          continue
        }
      }
      // Non-zero is the NORMAL exit for a linter that found something — parse stdout regardless.
      const text = spec.readsStderr ? `${r.stdout}\n${r.stderr}` : r.stdout
      const found = spec.parse(text, opts.dir)
      all.push(...found)
      ran.push(spec.name)
    } catch {
      missing.push(`${spec.name} (failed to run)`)
    }
  }

  const { findings, dropped } = normalizeFindings(all)
  return { findings, ran, missing, dropped }
}

/** Kill-switch, read at CALL time so it can be flipped without a restart. */
export function floorEnabled(env: Record<string, string | undefined> | undefined): boolean {
  return (env?.FABULA_GO_FLOOR ?? "1") !== "0"
}

// ---------------------------------------------------------------------------------------------
// The real IO. ONE definition, imported by every caller.
//
// Two plugins need this (fabula-goaudit runs the floor as a gate and a tool; fabula-witness grounds
// its reviewer in it). Two copies of one rule is this repo's most-repeated defect — whichever ran
// first would win, and which one that is changes — so the exec and the module-root walk live here.
// ---------------------------------------------------------------------------------------------

/** How much of a runaway tool's output is kept. The parsers only ever need the head. */
const OUTPUT_CAP_BYTES = 4 * 1024 * 1024

/**
 * The real exec: spawn, bounded output, hard timeout, never rejects.
 *
 * `FABULA_GO_EXEC_SHIM`, when set, is prefixed to every argv. That is how a test drives this exact
 * code path — probe, argv construction, timeout, parse — with a marker script instead of installing
 * six Go tools, so a mutation that stops a tool from being invoked fails a test rather than passing
 * one. Read at CALL time, so a test can set it after import.
 */
export function spawnExec(): Exec {
  return (argv, opts) =>
    new Promise<ExecResult>((resolve) => {
      const shim = (process.env.FABULA_GO_EXEC_SHIM || "").trim()
      const full = shim ? [shim, ...argv] : [...argv]
      if (!full.length) return resolve({ stdout: "", stderr: "empty argv", code: null })
      let done = false
      let stdout = ""
      let stderr = ""
      let child: ReturnType<typeof spawn>
      try {
        // PATH is widened to the places `go install` and the official Go installer actually use — an app
        // launched from Finder inherits neither (see goToolPath). The caller's own PATH stays in front.
        child = spawn(full[0]!, full.slice(1), { cwd: opts.cwd, env: { ...process.env, PATH: goToolPath(process.env) } })
      } catch {
        return resolve({ stdout: "", stderr: "spawn failed: command not found", code: null })
      }
      const finish = (r: ExecResult) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {}
        finish({ stdout, stderr, code: null, timedOut: true })
      }, Math.max(1, opts.timeoutMs))
      child.stdout?.on("data", (d) => {
        if (stdout.length < OUTPUT_CAP_BYTES) stdout += d.toString()
      })
      child.stderr?.on("data", (d) => {
        if (stderr.length < OUTPUT_CAP_BYTES) stderr += d.toString()
      })
      child.on("error", (e: any) => {
        const why = e?.code === "ENOENT" ? "command not found" : String(e?.message ?? e)
        finish({ stdout, stderr: `${stderr}\n${why}`, code: null })
      })
      child.on("close", (code) => finish({ stdout, stderr, code }))
    })
}

/**
 * Nearest enclosing directory holding a go.mod, walking up from `start`; null when there is none.
 *
 * Purely `readdir` — no `realpath`. That is deliberate: `realpathSync` on an iCloud-managed folder can
 * sleep in the kernel indefinitely, and this repo has already lost a whole engine to exactly that.
 */
export async function findGoModuleRoot(start: string, maxDepth = 40): Promise<string | null> {
  let dir = path.resolve(start)
  for (let i = 0; i < maxDepth; i++) {
    try {
      if (looksGoModule(await fs.readdir(dir))) return dir
    } catch {}
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}
