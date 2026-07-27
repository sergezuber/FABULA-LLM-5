// Nothing FABULA starts may outlive FABULA.
//
// MEASURED, and it cost a live run. A corpus worker is spawned DETACHED on purpose — a map-reduce over a
// book must survive the turn that asked for it, because a plugin hook is killed after five seconds and a
// headless run exits the moment the hook cancels. Detaching solved that and created a worse problem: the
// worker is re-parented to the system, so the app's shutdown — `pkill -9 -P <engine pid>`, which reaches
// only DIRECT children — never sees it.
//
// One such worker, left over from a session closed hours earlier, kept sending requests at the engine
// port. The serving runtime loaded a model to answer it; the window autoloader then loaded another; two
// copies of 21.95 GB of weights on a 48 GB machine drove it into fifteen gigabytes of swap, the instance
// serving the user's own turn was killed for memory, and eight and a half minutes of work were lost to
// "the model has crashed (Exit code: null)".
//
// The rule this file enforces has no exceptions: a detached process is registered the moment it is born,
// and it is reaped when the app stops or when a new engine starts. Surviving the TURN is the point;
// surviving the APP never is.
//
// The registry is a file rather than memory because the two ends are different processes: the thing that
// spawns is the engine, the thing that reaps may be the app, or the next engine after a crash that ran no
// shutdown at all. Memory cannot be read across that boundary; a file can.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

export interface ChildRecord {
  pid: number
  /** What it is, so a reap can be reported in words rather than as a number. */
  label: string
  /** Who started it. A record from a PREVIOUS engine is an orphan by definition. */
  ownerPid: number
  startedAt: number
}

export function registryPath(): string {
  const override = process.env.FABULA_CHILDREG_FILE
  if (override) return override
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share")
  return join(data, "fabula", "children.json")
}

export function readRegistry(): ChildRecord[] {
  try {
    const v = JSON.parse(readFileSync(registryPath(), "utf8"))
    return Array.isArray(v) ? v.filter((r) => Number(r?.pid) > 0) : []
  } catch {
    return []
  }
}

function write(records: readonly ChildRecord[]): void {
  try {
    const p = registryPath()
    mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(records, null, 2))
    renameSync(tmp, p) // atomic: a half-written registry would be read as truth by the next reap
  } catch {
    /* the registry is a safety net; failing to write it must never break the work it is protecting */
  }
}

/** Record a detached process. Called the moment it is spawned, never later. */
export function registerChild(pid: number, label: string, ownerPid = process.pid): void {
  if (!(Number(pid) > 0)) return
  write([...readRegistry().filter((r) => r.pid !== pid), { pid, label, ownerPid, startedAt: Date.now() }])
}

/** Forget a process that ended on its own. */
export function unregisterChild(pid: number): void {
  write(readRegistry().filter((r) => r.pid !== pid))
}

/** Is this process still running? Signal 0 asks without sending anything. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Which records are ORPHANS — still alive, but started by an engine that is gone?
 *
 * Keyed on the owner rather than on age: a corpus run over a long book is legitimately slow, and a rule
 * that reaped by elapsed time would kill exactly the work detaching exists to protect. What makes a
 * process an orphan is that nobody is waiting for it any more.
 */
export function orphansOf(records: readonly ChildRecord[], livingOwners: (pid: number) => boolean): ChildRecord[] {
  return records.filter((r) => isAlive(r.pid) && !livingOwners(r.ownerPid))
}

/**
 * Kill every registered process whose owner is gone, and forget every record that is no longer running.
 * Safe to call at any time: a worker whose engine is still alive is left strictly alone.
 */
export function reapOrphans(kill: (pid: number) => void = (p) => { try { process.kill(p, "SIGKILL") } catch {} }):
  { reaped: ChildRecord[]; kept: ChildRecord[] } {
  const all = readRegistry()
  const reaped = orphansOf(all, (owner) => owner === process.pid || isAlive(owner))
  for (const r of reaped) kill(r.pid)
  const kept = all.filter((r) => !reaped.some((x) => x.pid === r.pid) && isAlive(r.pid))
  write(kept)
  return { reaped, kept }
}

/**
 * Kill EVERY registered process, whoever owns it. This is the app-shutdown path: when FABULA stops,
 * nothing it started keeps running, and "my owner is still alive" stops being a reason to survive.
 */
export function reapAll(kill: (pid: number) => void = (p) => { try { process.kill(p, "SIGKILL") } catch {} }):
  ChildRecord[] {
  const all = readRegistry().filter((r) => isAlive(r.pid))
  for (const r of all) kill(r.pid)
  write([])
  return all
}
