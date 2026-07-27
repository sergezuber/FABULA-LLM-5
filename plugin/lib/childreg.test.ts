import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { rmSync, readFileSync } from "node:fs"
import {
  registerChild, unregisterChild, readRegistry, orphansOf, reapOrphans, reapAll, isAlive, registryPath,
} from "./childreg"

const REG = join(tmpdir(), `childreg-${process.pid}.json`)
beforeEach(() => { process.env.FABULA_CHILDREG_FILE = REG; rmSync(REG, { force: true }) })
afterEach(() => rmSync(REG, { force: true }))

/** A real process that outlives its parent, which is the whole shape being guarded. */
function spawnSleeper(): number {
  const p = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] })
  p.unref()
  return p.pid
}

describe("the registry records what was detached", () => {
  test("a spawn is written down, with a label a human can read in a log", () => {
    registerChild(4242, "corpus-worker ses_abc")
    const r = readRegistry()
    expect(r.length).toBe(1)
    expect(r[0].label).toContain("corpus-worker")
    expect(r[0].ownerPid).toBe(process.pid)
  })

  test("a process that ended on its own is forgotten", () => {
    registerChild(4242, "x")
    unregisterChild(4242)
    expect(readRegistry()).toEqual([])
  })

  test("re-registering the same pid does not duplicate it", () => {
    registerChild(4242, "first")
    registerChild(4242, "second")
    expect(readRegistry().length).toBe(1)
    expect(readRegistry()[0].label).toBe("second")
  })

  test("junk on disk is survived, never thrown on", () => {
    Bun.write(REG, "not json")
    expect(readRegistry()).toEqual([])
    expect(() => registerChild(1, "x")).not.toThrow()
  })
})

describe("what counts as an orphan", () => {
  const rec = (pid: number, owner: number) => ({ pid, label: `w${pid}`, ownerPid: owner, startedAt: 0 })

  test("its engine is gone → orphan", () => {
    const dead = () => false
    expect(orphansOf([rec(process.pid, 999999)], dead).length).toBe(1)
  })

  test("its engine is alive → LEFT ALONE, however long it has been running", () => {
    // The whole reason a corpus worker is detached is that a book takes a long time. Reaping by age would
    // kill exactly the work detaching exists to protect, so age is never consulted.
    expect(orphansOf([rec(process.pid, process.pid)], () => true)).toEqual([])
  })

  test("a record whose process already exited is not 'killed', it is just gone", () => {
    expect(orphansOf([rec(999999, 999998)], () => false)).toEqual([])
  })
})

describe("reaping for real", () => {
  test("an orphan is actually KILLED — a real process, not a mock", async () => {
    const pid = spawnSleeper()
    expect(isAlive(pid)).toBe(true)
    registerChild(pid, "orphan", 999999) // an owner that does not exist
    const r = reapOrphans()
    expect(r.reaped.map((x) => x.pid)).toContain(pid)
    await Bun.sleep(150)
    expect(isAlive(pid)).toBe(false)
  })

  test("a worker whose engine is alive SURVIVES the same call", async () => {
    const pid = spawnSleeper()
    registerChild(pid, "mine") // owner defaults to this process, which is alive
    reapOrphans()
    await Bun.sleep(100)
    expect(isAlive(pid)).toBe(true)
    expect(readRegistry().some((x) => x.pid === pid)).toBe(true)
    try { process.kill(pid, "SIGKILL") } catch {}
  })

  test("app shutdown kills EVERYTHING, including a live owner's worker", async () => {
    // "Surviving the turn is the point; surviving the app never is."
    const pid = spawnSleeper()
    registerChild(pid, "mine")
    const killed = reapAll()
    expect(killed.map((x) => x.pid)).toContain(pid)
    await Bun.sleep(150)
    expect(isAlive(pid)).toBe(false)
    expect(readRegistry()).toEqual([])
  })

  test("the registry is left clean of dead records", () => {
    registerChild(999999, "already gone", 999998)
    reapOrphans()
    expect(readRegistry()).toEqual([])
  })

  test("the file the app reads is the file the plugin writes", () => {
    registerChild(4242, "x")
    expect(registryPath()).toBe(REG)
    expect(JSON.parse(readFileSync(REG, "utf8"))[0].pid).toBe(4242)
  })
})
