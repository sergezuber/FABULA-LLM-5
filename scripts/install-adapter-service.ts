#!/usr/bin/env bun
// Install (or report on) the :1235 adapter as a session service, on whatever platform this is.
//
// This replaces the LaunchAgent heredoc that lived inside setup.sh. The heredoc was macOS-shaped by
// construction — a plist path, a plist body and `launchctl load` — so on any other platform the single
// component every local model is reached THROUGH simply would not come up with the session.
//
//   bun scripts/install-adapter-service.ts            # install if nothing answers on :1235
//   bun scripts/install-adapter-service.ts --status   # report only, change nothing
//   bun scripts/install-adapter-service.ts --force    # (re)install even if one is already answering
//
// NEVER touches a live adapter without --force: if ANYTHING answers on :1235 — even a 502 while the
// serving runtime is off — an instance owns that port, and replacing it out from under a running session
// is exactly the kind of "helpful" action that loses somebody's turn.

import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import * as path from "node:path"
import { current } from "../plugin/lib/platform/index"
import { planServiceInstall, pythonCandidates, ADAPTER_LABEL } from "../plugin/lib/platform/service"
import { whichFirst } from "../plugin/lib/platform/shell"
import { dataPath } from "../plugin/lib/platform/paths"

const REPO = path.resolve(import.meta.dir, "..")
const PORT = Number(process.env.FABULA_ADAPTER_PORT) || 1235
const args = new Set(process.argv.slice(2))

async function adapterAnswers(): Promise<boolean> {
  try {
    await fetch(`http://localhost:${PORT}/v1/models`, { signal: AbortSignal.timeout(2000) })
    return true // ANY answer means the port is owned — a 502 counts
  } catch {
    return false
  }
}

function run(argv: string[]): { code: number; out: string } {
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" })
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }
}

const platform = current()
const script = path.join(REPO, "proxy", "lmstudio-adapter.py")
const python = whichFirst(pythonCandidates(platform)) || pythonCandidates(platform)[0]!
const logPath = path.join(dataPath("log"), "adapter.log")
const plan = planServiceInstall({ python, script, logPath }, platform)

if (args.has("--status")) {
  const alive = await adapterAnswers()
  const st = run(plan.statusArgv)
  console.log(`platform     : ${platform}`)
  console.log(`answering    : ${alive ? `yes (:${PORT})` : "no"}`)
  console.log(`service file : ${plan.filePath ?? "(none — the scheduler keeps its own store)"}`)
  console.log(`registered   : ${st.code === 0 ? "yes" : "no"}`)
  if (!alive) console.log(`hint         : ${plan.hint}`)
  process.exit(0)
}

if (!existsSync(script)) {
  console.error(`✗ adapter script not found at ${script} — is this the repository root?`)
  process.exit(1)
}

if (!args.has("--force") && await adapterAnswers()) {
  console.log(`  adapter already answering on :${PORT} — left untouched.`)
  process.exit(0)
}

try {
  if (plan.filePath && plan.fileBody) {
    mkdirSync(path.dirname(plan.filePath), { recursive: true })
    writeFileSync(plan.filePath, plan.fileBody, "utf8")
  }
  mkdirSync(path.dirname(logPath), { recursive: true })
  run(plan.unregisterArgv) // idempotent: drop a prior version, ignore its result
  const r = run(plan.registerArgv)
  if (r.code !== 0) {
    // A failure to register is reported with the command that failed and what to do — never swallowed,
    // because a silently missing adapter looks like a broken model rather than a missing service.
    console.error(`✗ could not register the adapter service (${plan.registerArgv[0]}): ${r.out.slice(-300)}`)
    console.error(`  ${plan.hint}`)
    process.exit(1)
  }
  console.log(`  adapter installed as a session service (${ADAPTER_LABEL}) — starts with your session.`)
} catch (e: any) {
  console.error(`✗ ${e?.message ?? e}`)
  process.exit(1)
}
