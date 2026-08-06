#!/usr/bin/env bun
// The port's acceptance matrix, as a PROGRAM rather than a checklist.
//
//     bun scripts/acceptance.ts            run every criterion this machine can run
//     bun scripts/acceptance.ts --list     print the criteria and what each needs, change nothing
//
// WHY THIS EXISTS. The matrix was ten rows of prose, and prose is graded by whoever reads it. Two of the
// three platforms will be accepted by someone who has never seen this repository, on a machine nobody
// here can log into, and "the guards still hold" is not a thing a person can eyeball. So the criteria are
// executable: the acceptance becomes ONE COMMAND whose verdict nobody has to interpret.
//
// THREE OUTCOMES, NEVER TWO. A criterion PASSES, FAILS, or is SKIPPED for a named reason — and a skip is
// printed as loudly as a failure. A checklist that silently drops the rows it cannot run reads exactly
// like one that passed them, which is the single failure mode this file exists to prevent; it is the same
// rule the dependency floor follows when it NAMES the analysers it could not run.
//
// It does NOT try to be the whole of RULE #0. Criteria 1 and 2 need a human to open the application and
// watch a real task finish; they are reported as MANUAL with the exact steps, rather than quietly
// approximated by something easier to automate.

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { current, exeSuffix } from "../plugin/lib/platform/index"
import { dataDir } from "../plugin/lib/platform/paths"
import { shellArgv } from "../plugin/lib/platform/shell"
import { sandboxPlan, shellScope } from "../plugin/lib/platform/sandbox"
import { planInstall, parseKnownJobs } from "../plugin/lib/platform/scheduler"
import { memoryReading } from "../plugin/lib/platform/memory"
import { policyFitsSource, policyMismatchReason } from "../plugin/lib/windowplan"
import { checkWritePath, isWriteToolName } from "../plugin/lib/pathguard"
import { checkCommand } from "../plugin/lib/cmdguard"

const ROOT = path.resolve(import.meta.dir, "..")
const PLATFORM = current()
const PORT = Number(process.env.FABULA_PORT) || 4096

type Verdict = "PASS" | "FAIL" | "SKIP" | "MANUAL"
interface Result { n: number; title: string; verdict: Verdict; detail: string }
const results: Result[] = []
const record = (n: number, title: string, verdict: Verdict, detail: string) =>
  results.push({ n, title, verdict, detail })

function run(argv: string[], opts: { cwd?: string; timeout?: number } = {}) {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    timeout: opts.timeout ?? 600_000,
  })
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}
const sh = (cmd: string, opts?: { cwd?: string; timeout?: number }) => run(shellArgv(cmd), opts)

async function answers(url: string, ms = 2000): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(ms) })
    return true
  } catch {
    return false
  }
}

// ── 1 & 2 — the two a program must not pretend to have checked ─────────────────────────────────────

function criterion1() {
  const bin = path.join(ROOT, "bin", `fabula${exeSuffix(PLATFORM)}`)
  record(1, "the application starts on a clean machine", "MANUAL",
    existsSync(bin)
      ? `open the desktop shell on a machine with no dev environment and confirm the window appears.\n      engine present at ${path.relative(ROOT, bin)}`
      : `no engine binary at ${path.relative(ROOT, bin)} — build it first (./setup.sh or .\\setup.ps1)`)
}

function criterion2() {
  record(2, "a real task runs through the LIVE application, over its own HTTP routes", "MANUAL",
    `open the app, then:  POST http://127.0.0.1:${PORT}/session  ->  POST /session/{id}/message\n` +
    `      RULE #0: a verdict from anything other than the running application is a draft, not a result.`)
}

// ── 3 — every plugin loads, and the log says nothing about it ──────────────────────────────────────

function criterion3() {
  const log = path.join(dataDir(), "log", "plugins.log")
  if (!existsSync(log)) {
    record(3, "every plugin loads, zero ERROR lines", "SKIP",
      `no diagnostic log at ${log} — start the application once, then re-run`)
    return
  }
  const text = readFileSync(log, "utf8")
  const bad = text.split("\n").filter((l) => /ERROR|failed to load/.test(l))
  // Counted in JS rather than by a shell pipeline: `ls | wc -l` exists on Windows only inside Git Bash,
  // and a criterion that silently depends on which shell is installed is a criterion that reports the
  // environment instead of the product.
  const declared = readdirSync(path.join(ROOT, "plugin"))
    .filter((f) => /^fabula-.*\.ts$/.test(f)).length
  record(3, "every plugin loads, zero ERROR lines", bad.length === 0 ? "PASS" : "FAIL",
    bad.length === 0 ? `${declared} plugins declared, no load errors in the log`
                     : `${bad.length} error line(s):\n      ${bad.slice(0, 3).join("\n      ")}`)
}

// ── 4 — the guards, asked directly ────────────────────────────────────────────────────────────────

function criterion4() {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  // One target per platform that is unambiguously persistence there.
  const target = PLATFORM === "darwin" ? path.join(home, "Library", "LaunchAgents", "zz.plist")
              : PLATFORM === "linux"  ? path.join(home, ".config", "systemd", "user", "zz.service")
              :                         path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "zz.lnk")
  const fails: string[] = []
  if (!checkWritePath(target).blocked) fails.push(`the file guard ALLOWS ${target}`)
  if (!isWriteToolName("apply_patch")) fails.push("apply_patch is not classed as a write tool")
  if (!checkCommand("rm -rf /").blocked) fails.push("the command guard allows `rm -rf /`")
  const plan = sandboxPlan(shellScope())
  const kernel = plan.available ? `kernel floor: ${plan.mechanism}` : `NO kernel floor here — ${plan.note}`
  record(4, "the guards refuse through every door", fails.length === 0 ? "PASS" : "FAIL",
    fails.length === 0 ? `file, tool-name and command doors all refuse. ${kernel}` : fails.join("\n      "))
}

// ── 5 — a file is not a schedule ──────────────────────────────────────────────────────────────────

function criterion5() {
  const plan = planInstall({ id: "probe", command: "true", hour: 3, minute: 0, logPath: "/tmp/x" },
                           { shell: shellArgv("true")[0]! })
  const listed = run(plan.listArgv, { timeout: 15_000 })
  if (listed.code !== 0 && !listed.out.trim()) {
    record(5, "the scheduler is asked, not the filesystem", "SKIP",
      `${plan.listArgv[0]} could not be asked here (${listed.code}) — a session without a user scheduler`)
    return
  }
  const known = parseKnownJobs(listed.out)
  record(5, "the scheduler is asked, not the filesystem", "PASS",
    `${plan.listArgv[0]} answered; it knows ${known.length} FABULA job(s). ` +
    `Full check: schedule_task -> reboot -> list_scheduled must NAME an orphan as an orphan.`)
}

// ── 6 — the adapter ───────────────────────────────────────────────────────────────────────────────

async function criterion6() {
  const alive = await answers(`http://localhost:1235/v1/models`)
  // `python3` is the POSIX spelling and does not exist on Windows, where the interpreter is `python`.
  // Asking for the wrong one would report "0 tests collected" — a suite that never ran, presented as a
  // suite that is empty.
  let n = 0
  for (const exe of PLATFORM === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const py = run([exe, "-m", "pytest", "-q", "--collect-only"], { cwd: path.join(ROOT, "proxy"), timeout: 300_000 })
    n = Number(/([0-9]+) tests? collected/.exec(py.out)?.[1] ?? 0)
    if (n > 0) break
  }
  const parts = [`:1235 ${alive ? "answers" : "does NOT answer"}`, `${n} adapter tests collected`]
  record(6, "the adapter answers and its suite is real", alive && n >= 40 ? "PASS" : alive ? "FAIL" : "SKIP",
    alive && n >= 40 ? parts.join(", ")
    : !alive ? `${parts.join(", ")} — start the adapter service first (bun scripts/install-adapter-service.ts --status)`
    : `${parts.join(", ")} — a suite that collected almost nothing must not read as green`)
}

// ── 7 — the window is sized against the right pool, or not at all ─────────────────────────────────

function criterion7() {
  const m = memoryReading()
  const fits = policyFitsSource(m.kind)
  record(7, "the window policy matches this machine's memory", fits ? "PASS" : "FAIL",
    fits ? `${m.kind}: ${m.detail} — the measured policy applies here`
         : `${m.kind}: ${policyMismatchReason(m.kind)}`)
}

// ── 8 — the deploy guard, in BOTH directions ──────────────────────────────────────────────────────

function criterion8() {
  const guard = PLATFORM === "win32"
    ? ["pwsh", "-NoProfile", "-File", path.join(ROOT, "scripts", "verify-deploy.ps1")]
    : shellArgv(`bash "${ROOT}/scripts/verify-deploy.sh"`)
  // Is there a DEPLOYMENT here to ask about? A checkout that built only the engine has no frontend bundle
  // and no app artifact, and the guard is right to call that stale — but "stale" then describes a
  // deployment that was never made, which is a different statement from a deployment that fell behind. The
  // positive half is reported as not-applicable there, and the negative half below is still checked, so
  // the criterion keeps the assertion it is really about: a guard that cannot say STALE proves nothing.
  const deployed = existsSync(path.join(ROOT, "engine", "packages", "app", "dist", "assets"))
  const fresh = deployed ? run(guard, { timeout: 120_000 }) : { code: 0, out: "" }
  if (fresh.code !== 0) {
    // The guard's OWN words, however it marks them. Filtering for one marker was a second definition of
    // what a failure line looks like, and the other platform's guard does not use it — so the report said
    // "the tree reports STALE:" and then nothing at all.
    // The lines that carry the VERDICT, plus the tail. The first version printed the last four non-empty
    // lines and they were all "ok" — the guard says why somewhere in its output, and where that is differs
    // per platform, so both are reported rather than guessing which.
    const lines = fresh.out
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
    const marked = lines.filter((l) => /STALE|\[!!\]|❌|FAIL|missing|does not|not found/i.test(l))
    const said = [...new Set([...marked.slice(0, 6), ...lines.slice(-3)])].join("\n      ")
    record(8, "the deploy guard is green AND can say STALE", "FAIL", `the tree reports STALE:\n      ${said}`)
    return
  }
  // The negative half: a guard that cannot say STALE is not a guard. Checked on a THROWAWAY tree so the
  // real one is never touched.
  const tmp = mkdtempSync(path.join(tmpdir(), "fabula-accept-"))
  try {
    const stale = run(PLATFORM === "win32" ? [...guard, tmp] : shellArgv(`bash "${ROOT}/scripts/verify-deploy.sh" "${tmp}"`),
                      { timeout: 120_000 })
    record(8, "the deploy guard is green AND can say STALE", stale.code !== 0 ? "PASS" : "FAIL",
      stale.code !== 0
        ? deployed
          ? "FRESH on this tree, STALE on an empty one — both verdicts reachable"
          : "nothing is deployed here to call fresh; STALE on an empty tree — the guard can still fail"
                       : "the guard called an EMPTY tree fresh; it cannot fail, so it proves nothing")
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ── 9 — nothing is left running ───────────────────────────────────────────────────────────────────

function criterion9() {
  const reg = path.join(dataDir(), "children.json")
  let leftovers = 0
  try {
    const recs = JSON.parse(readFileSync(reg, "utf8")) as Array<{ pid: number }>
    leftovers = recs.filter((r) => { try { process.kill(r.pid, 0); return true } catch { return false } }).length
  } catch { /* no registry is the same as no children */ }
  record(9, "closing the application leaves nothing running", leftovers === 0 ? "PASS" : "FAIL",
    leftovers === 0 ? "the child registry lists no living process"
                    : `${leftovers} registered child(ren) still alive — run scripts/safe-restart.ts`)
}

// ── 10 — the suites, compared against a declared baseline ─────────────────────────────────────────

const BASELINE = { plugin: 2644, proxy: 40 }

function criterion10() {
  const t = run(["bun", "test"], { cwd: path.join(ROOT, "plugin"), timeout: 900_000 })
  const pass = Number(/([0-9]+) pass/.exec(t.out)?.[1] ?? 0)
  const fail = Number(/([0-9]+) fail/.exec(t.out)?.[1] ?? -1)
  const ok = fail === 0 && pass >= BASELINE.plugin
  // The named failures, so a reader can tell a port defect from a machine under load. Several tests here
  // spawn REAL subprocesses against their own timeouts — an MCP handshake, a git probe, a Go analyser —
  // and on a saturated machine those exceed their budgets. That is a property of running 164 test files
  // at once, not of the platform, and a verdict that hid the names would make the two indistinguishable.
  const named = t.out.split("\n").filter((l) => l.startsWith("(fail)")).map((l) => l.replace(/ \[[0-9.]*ms\]$/, ""))
  record(10, "the suites are green and no smaller than the baseline", ok ? "PASS" : "FAIL",
    `plugin: ${pass} pass / ${fail} fail (baseline ${BASELINE.plugin}).` +
    (pass < BASELINE.plugin ? " A SMALLER suite is a finding: tests that vanish read exactly like tests that passed." : "") +
    (named.length ? `\n      ${named.slice(0, 4).join("\n      ")}` : ""))
}

// ── report ────────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--list")) {
  console.log(`FABULA acceptance — ${PLATFORM}\n`)
  for (const [n, t] of [
    [1, "the application starts on a clean machine (MANUAL)"],
    [2, "a real task through the live application (MANUAL — RULE #0)"],
    [3, "every plugin loads, zero ERROR lines"],
    [4, "the guards refuse through every door"],
    [5, "the scheduler is asked, not the filesystem"],
    [6, "the adapter answers and its suite is real"],
    [7, "the window policy matches this machine's memory"],
    [8, "the deploy guard is green AND can say STALE"],
    [9, "closing leaves nothing running"],
    [10, "the suites are green and no smaller than the baseline"],
  ] as [number, string][]) console.log(`  ${String(n).padStart(2)}. ${t}`)
  process.exit(0)
}

console.log(`FABULA acceptance — ${PLATFORM}\n`)
criterion1(); criterion2(); criterion3(); criterion4(); criterion5()
await criterion6()
criterion7(); criterion8(); criterion9(); criterion10()

const mark = { PASS: "  ok  ", FAIL: " FAIL ", SKIP: " skip ", MANUAL: "manual" }
for (const r of results.sort((a, b) => a.n - b.n)) {
  console.log(`[${mark[r.verdict]}] ${String(r.n).padStart(2)}. ${r.title}`)
  console.log(`      ${r.detail}`)
}

const failed = results.filter((r) => r.verdict === "FAIL")
const skipped = results.filter((r) => r.verdict === "SKIP")
const manual = results.filter((r) => r.verdict === "MANUAL")
console.log(`\n${results.length} criteria: ${results.filter((r) => r.verdict === "PASS").length} pass, ` +
  `${failed.length} fail, ${skipped.length} skipped, ${manual.length} manual`)
// A SKIP is printed as loudly as a failure and is NOT counted as acceptance: a checklist that silently
// drops what it could not run reads exactly like one that passed it.
if (skipped.length) console.log(`  skipped, and therefore NOT accepted: ${skipped.map((r) => r.n).join(", ")}`)
if (manual.length) console.log(`  still needs a human: ${manual.map((r) => r.n).join(", ")}`)
process.exit(failed.length ? 1 : 0)
