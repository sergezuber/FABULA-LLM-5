#!/usr/bin/env bun
/**
 * Update this installation in place: pull, rebuild, report.
 *
 * WHY A SCRIPT AND NOT THREE HOSTS. The install is a git clone, so updating it is `git pull` plus the
 * build the project already has. Putting that in the macOS host and again in the Tauri shell would be a
 * third and fourth definition of "how is FABULA built" — the shape this repository has paid for
 * repeatedly. The hosts do the ONE thing only they can: restart the engine afterwards.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never kills the engine. Neither host revives one that dies
 * unexpectedly — there is no termination handler and no health timer in either — so a script that
 * stopped the engine would leave the reader with a dead window. Measured on this platform: macOS
 * permits replacing the running binary in place, so the build runs with the engine live and only the
 * restart needs the host. `build.sh` compiles first and copies to `bin/fabula` only after checking the
 * binary was produced, so a failed build leaves the working install exactly as it was.
 *
 * IT REFUSES RATHER THAN GUESSES. A dirty tree, a branch with no upstream, a pull that is not a
 * fast-forward — each stops the update and says so by name. Merging someone's uncommitted work, or
 * rewriting their history, to deliver a version bump is not a trade this may make on their behalf.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { baseDirs } from "../plugin/lib/platform/paths"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const STATE_DIR = join(baseDirs().data, "update")
const STATE = join(STATE_DIR, "status.json")
const LOG = join(STATE_DIR, "update.log")

export type UpdateStatus = {
  state: "running" | "done" | "failed"
  step: string
  detail?: string
  startedAt: number
  finishedAt?: number
  from?: string
  to?: string
}

function write(status: UpdateStatus) {
  mkdirSync(STATE_DIR, { recursive: true })
  // tmp+rename: a reader polling this file must never see half of it.
  const tmp = `${STATE}.tmp`
  writeFileSync(tmp, JSON.stringify(status, null, 2))
  spawnSync("mv", [tmp, STATE])
}

function log(line: string) {
  mkdirSync(STATE_DIR, { recursive: true })
  const stamp = new Date().toISOString()
  try {
    const prev = existsSync(LOG) ? readFileSync(LOG, "utf8") : ""
    // Bounded: an update log nobody rotates is a disk leak, and only the tail is ever read.
    writeFileSync(LOG, (prev + `${stamp} ${line}\n`).split("\n").slice(-400).join("\n"))
  } catch {}
}

function run(cmd: string, args: string[], cwd = ROOT) {
  log(`$ ${cmd} ${args.join(" ")}`)
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, PATH: process.env["PATH"] ?? "" } })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim()
  if (out) log(out.split("\n").slice(-40).join("\n"))
  return { ok: r.status === 0, out }
}

export function declaredVersion(): string {
  const f = join(ROOT, "engine/packages/app/src/data/fabula-changelog.ts")
  const m = /FABULA_VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(f, "utf8"))
  return m?.[1] ?? ""
}

async function main() {
  const started = Date.now()
  const from = declaredVersion()
  write({ state: "running", step: "checking", startedAt: started, from })

  if (!existsSync(join(ROOT, ".git"))) {
    write({ state: "failed", step: "checking", detail: "not-a-git-checkout", startedAt: started, finishedAt: Date.now(), from })
    return
  }

  // A dirty tree is the reader's work in progress. Pulling over it is not ours to risk.
  const dirty = run("git", ["status", "--porcelain"])
  if (dirty.out.trim() !== "") {
    // NOT `slice(3)`. Porcelain's prefix is two status columns plus a space, and `run` trims the whole
    // output — which eats the leading space of the FIRST line only, so a fixed cut ate a real character
    // off exactly one filename ("ngine/packages/…"). Match the columns instead of counting them.
    const files = dirty.out
      .split("\n")
      .slice(0, 6)
      .map((l) => l.replace(/^\s*\S{1,2}\s+/, ""))
      .join(", ")
    write({ state: "failed", step: "checking", detail: `uncommitted-changes: ${files}`, startedAt: started, finishedAt: Date.now(), from })
    return
  }

  const upstream = run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
  if (!upstream.ok) {
    write({ state: "failed", step: "checking", detail: "no-upstream-branch", startedAt: started, finishedAt: Date.now(), from })
    return
  }

  write({ state: "running", step: "pulling", startedAt: started, from })
  // --ff-only: it either advances cleanly or stops. No merge commit, no rebase, no conflict left behind.
  const pull = run("git", ["pull", "--ff-only"])
  if (!pull.ok) {
    write({ state: "failed", step: "pulling", detail: pull.out.split("\n").slice(-3).join(" ").slice(0, 300), startedAt: started, finishedAt: Date.now(), from })
    return
  }

  const to = declaredVersion()
  if (to === from && /Already up to date/i.test(pull.out)) {
    write({ state: "done", step: "already-current", startedAt: started, finishedAt: Date.now(), from, to })
    return
  }

  write({ state: "running", step: "building", startedAt: started, from, to })
  const build = run("bash", [join(ROOT, "build.sh")])
  if (!build.ok) {
    // The old binary is still in place — build.sh copies only after the compile produced one.
    write({ state: "failed", step: "building", detail: build.out.split("\n").slice(-4).join(" ").slice(0, 400), startedAt: started, finishedAt: Date.now(), from, to })
    return
  }

  write({ state: "done", step: "built", startedAt: started, finishedAt: Date.now(), from, to })
  log(`updated ${from} -> ${to}`)
}

export function readStatus(): UpdateStatus | null {
  try {
    return JSON.parse(readFileSync(STATE, "utf8")) as UpdateStatus
  } catch {
    return null
  }
}

if (import.meta.main) await main()
