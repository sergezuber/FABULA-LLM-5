// EXHAUSTIVE corner-case tests for hooks:fabula-purge (fabula-purge-hook.ts).
// Invokes the REAL FabulaPurgeHook() event hook with the engine's exact event contract
// and asserts real fs effects (rm -rf of a per-session memory dir).
//
// SAFETY: the hook derives the real DATA path
//   ~/.local/share/fabula/memory/sessions/<id>   (XDG_DATA_HOME/fabula; engine app id "fabula")
// We never touch a real `ses_*` dir. Every dir we create/assert-on uses a unique throwaway id
//   `fabula-purge-test-<pid>-<n>`  (never starts with `ses_`),
// and afterAll re-asserts that NO real ses_* dir was removed (snapshot before/after).
import { test, expect, beforeAll, afterAll, describe } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import * as pathmod from "node:path"
import { FabulaPurgeHook } from "../fabula-purge-hook"
import { promises as fs } from "node:fs"
import { existsSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// ── the exact real path the hook derives (mirror of the impl constant) ──────────
const DATA = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "fabula")
const SESSIONS = path.join(DATA, "memory", "sessions")

// All throwaway ids share this prefix so cleanup + the "no real dir touched" guard are precise.
const PREFIX = `fabula-purge-test-${process.pid}`
let n = 0
const uid = () => `${PREFIX}-${n++}`

// snapshot of real session dirs taken before any test runs, used to prove we deleted none of them
let realDirsBefore: string[] = []

const createdIds: string[] = []
async function makeSessionDir(id: string, withFiles = true): Promise<string> {
  const dir = path.join(SESSIONS, id)
  createdIds.push(id)
  await fs.mkdir(dir, { recursive: true })
  if (withFiles) {
    // realistic per-session checkpoint contents: nested files + subdir
    await fs.writeFile(path.join(dir, "checkpoint.json"), JSON.stringify({ id, ts: Date.now() }), "utf8")
    await fs.mkdir(path.join(dir, "snapshots"), { recursive: true })
    await fs.writeFile(path.join(dir, "snapshots", "1.bin"), Buffer.from([1, 2, 3, 4]))
  }
  return dir
}

// Obtain the real hook instance the way the engine does: call the Plugin factory, get { event }.
async function hook() {
  const h: any = await FabulaPurgeHook({} as any)
  return h
}
// Fire the event hook exactly as the engine passes it: h.event({ event })
const fire = (h: any, event: any) => h.event({ event })

beforeAll(async () => {
  await fs.mkdir(SESSIONS, { recursive: true })
  const entries = await fs.readdir(SESSIONS).catch(() => [] as string[])
  realDirsBefore = entries.filter((e) => e.startsWith("ses_"))
})

afterAll(async () => {
  // remove any throwaway dirs we created (defensive — most tests already delete via the hook)
  for (const id of createdIds) {
    try { await fs.rm(path.join(SESSIONS, id), { recursive: true, force: true }) } catch {}
  }
  // GUARD: prove not a single real ses_* dir was removed by these tests.
  const after = await fs.readdir(SESSIONS).catch(() => [] as string[])
  const afterReal = new Set(after.filter((e) => e.startsWith("ses_")))
  for (const d of realDirsBefore) {
    if (!afterReal.has(d)) throw new Error(`SAFETY VIOLATION: real session dir vanished during tests: ${d}`)
  }
})

// ════════════════════════════════ shape / wiring ════════════════════════════════

test("FabulaPurgeHook(): factory returns an object exposing an async event() hook", async () => {
  const h = await hook()
  expect(typeof h.event).toBe("function")
  // calling with a benign non-delete event resolves (and returns a promise)
  const r = fire(h, { type: "something.else", properties: {} })
  expect(r).toBeInstanceOf(Promise)
  await r
})

// ════════════════════════ happy path: session.deleted ════════════════════════

test("session.deleted via properties.sessionID → rm -rf's exactly that dir (recursive)", async () => {
  const h = await hook()
  const id = uid()
  const dir = await makeSessionDir(id)
  expect(existsSync(dir)).toBe(true)
  expect(existsSync(path.join(dir, "snapshots", "1.bin"))).toBe(true)

  await fire(h, { type: "session.deleted", properties: { sessionID: id } })

  // whole subtree gone
  expect(existsSync(dir)).toBe(false)
  // parent sessions/ dir itself MUST survive
  expect(existsSync(SESSIONS)).toBe(true)
})

test("session.deleted with an empty (file-less) session dir is still removed", async () => {
  const h = await hook()
  const id = uid()
  const dir = await makeSessionDir(id, false)
  expect(existsSync(dir)).toBe(true)
  await fire(h, { type: "session.deleted", properties: { sessionID: id } })
  expect(existsSync(dir)).toBe(false)
})

// ════════════════════════ id fallback chain ════════════════════════
// impl: id = p.sessionID || p.info?.id || p.id || p.session?.id

test("id fallback: properties.info.id (when sessionID absent)", async () => {
  const h = await hook()
  const id = uid()
  const dir = await makeSessionDir(id)
  await fire(h, { type: "session.deleted", properties: { info: { id } } })
  expect(existsSync(dir)).toBe(false)
})

test("id fallback: properties.id (when sessionID + info.id absent)", async () => {
  const h = await hook()
  const id = uid()
  const dir = await makeSessionDir(id)
  await fire(h, { type: "session.deleted", properties: { id } })
  expect(existsSync(dir)).toBe(false)
})

test("id fallback: properties.session.id (last fallback)", async () => {
  const h = await hook()
  const id = uid()
  const dir = await makeSessionDir(id)
  await fire(h, { type: "session.deleted", properties: { session: { id } } })
  expect(existsSync(dir)).toBe(false)
})

test("id precedence: sessionID wins over the other fallbacks", async () => {
  const h = await hook()
  const winId = uid()
  const loseId = uid()
  const winDir = await makeSessionDir(winId)
  const loseDir = await makeSessionDir(loseId)
  // all fields present; sessionID must be the one that gets purged
  await fire(h, {
    type: "session.deleted",
    properties: { sessionID: winId, info: { id: loseId }, id: loseId, session: { id: loseId } },
  })
  expect(existsSync(winDir)).toBe(false)
  expect(existsSync(loseDir)).toBe(true) // untouched — only sessionID was used
})

// ════════════════════════ no-op cases (must not throw, must not delete) ════════════════════════

test("event.type !== session.deleted → no-op (dir survives) for several event types", async () => {
  const h = await hook()
  for (const type of ["session.updated", "session.created", "message.updated", "tool.completed", ""]) {
    const id = uid()
    const dir = await makeSessionDir(id)
    await fire(h, { type, properties: { sessionID: id } })
    expect(existsSync(dir)).toBe(true) // not a delete event → left alone
  }
})

test("missing id (no sessionID/info/id/session) → no-op, no throw", async () => {
  const h = await hook()
  // a sibling real-shaped dir exists to ensure nothing collateral is removed
  const sibling = uid()
  const siblingDir = await makeSessionDir(sibling)
  await fire(h, { type: "session.deleted", properties: {} })
  expect(existsSync(siblingDir)).toBe(true)
})

test("no properties at all → no-op, no throw", async () => {
  const h = await hook()
  await fire(h, { type: "session.deleted" }) // properties undefined → p = {} → id undefined
  // (nothing to assert beyond: it resolved without throwing)
})

test("non-string id (number / object / null) → no-op, no throw", async () => {
  const h = await hook()
  for (const bad of [12345, { nested: "x" }, null, true, ["a"]]) {
    // also drop a sibling so we'd notice an accidental rm of something
    const sibling = uid()
    const siblingDir = await makeSessionDir(sibling)
    await fire(h, { type: "session.deleted", properties: { sessionID: bad } })
    expect(existsSync(siblingDir)).toBe(true)
  }
})

test("empty-string id → no-op (falsy, skips rm), no throw", async () => {
  const h = await hook()
  await fire(h, { type: "session.deleted", properties: { sessionID: "" } })
  // empty id is falsy → guard returns before any rm. Nothing should be removed.
  // (we cannot assert a specific dir here; the guard is that it didn't throw and
  //  the afterAll real-dir snapshot remains intact.)
})

test("nonexistent session dir → no throw (force:true swallows ENOENT)", async () => {
  const h = await hook()
  const id = uid() // never created on disk
  expect(existsSync(path.join(SESSIONS, id))).toBe(false)
  // must resolve cleanly
  await fire(h, { type: "session.deleted", properties: { sessionID: id } })
  expect(existsSync(path.join(SESSIONS, id))).toBe(false)
})

test("event === null / undefined → no-op, no throw (optional-chaining on event?.type)", async () => {
  const h = await hook()
  await h.event({}) // no event key → event undefined → event?.type undefined → return
  await h.event({ event: null })
  await h.event({ event: undefined })
})

// ════════════════════════ path-derivation safety (no traversal escape) ════════════════════════
// The hook does path.join(DATA, "memory", "sessions", id). We verify a benign id maps under
// SESSIONS, and that the impl never writes outside the sessions root for normal ids.

test("derived target path is exactly SESSIONS/<id> (mirrors impl) for a benign id", async () => {
  const id = uid()
  const dir = await makeSessionDir(id)
  // The path the hook will target:
  const expected = path.join(SESSIONS, id)
  expect(dir).toBe(expected)
  const h = await hook()
  await fire(h, { type: "session.deleted", properties: { sessionID: id } })
  expect(existsSync(expected)).toBe(false)
})

test("idempotent: deleting the same session twice is a no-op the second time", async () => {
  const h = await hook()
  const id = uid()
  const dir = await makeSessionDir(id)
  await fire(h, { type: "session.deleted", properties: { sessionID: id } })
  expect(existsSync(dir)).toBe(false)
  // second delete on now-missing dir must not throw
  await fire(h, { type: "session.deleted", properties: { sessionID: id } })
  expect(existsSync(dir)).toBe(false)
})

// MEASURED 2026-08-01 by an independent review: the corpus store had grown to four artifacts per run —
// the accumulator (every per-batch summary verbatim), the heartbeat, the handback marker and, newly, the
// finished REPORT written to disk before delivery — while this hook removed only memory/sessions/<id>
// and the handoffs. Deleting a chat therefore left the full text of its analysis on disk, in the store
// whose stated guarantee is that nothing is retained. The same wave had just closed this exact class for
// the handoff archive and walked past its sibling.
describe("a deleted chat leaves nothing in the corpus store either", () => {
  test("every artifact of that session goes, and another session's are untouched", async () => {
    const data = mkdtempSync(pathmod.join(os.tmpdir(), "purge-corpus-"))
    const prev = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = data
    try {
      const dir = pathmod.join(data, "fabula", "corpus")
      mkdirSync(dir, { recursive: true })
      const mine = "ses_deadbeef"
      const other = "ses_cafebabe"
      // Filenames DERIVED from the real key function, never hand-written: accumulatorKey strips
      // characters (the underscore among them), so a hand-made fixture tests a name the product never
      // writes — which is how this test first passed against a purge that matched nothing.
      const { accumulatorKey } = await import("../lib/corpus")
      const k = accumulatorKey(mine, "/Users/me/book")
      const ko = accumulatorKey(other, "/Users/me/book")
      const files = {
        acc: pathmod.join(dir, `${k}.json`),
        hb: pathmod.join(dir, `${k}.heartbeat.json`),
        hand: pathmod.join(dir, `${k}.handback.json`),
        report: pathmod.join(dir, `${k}.report.md`),
        theirs: pathmod.join(dir, `${ko}.report.md`),
      }
      writeFileSync(files.acc, JSON.stringify({ v: 1, task: "read it all" }))
      writeFileSync(files.hb, JSON.stringify({ state: "done" }))
      writeFileSync(files.hand, "{}")
      writeFileSync(files.report, "SECRET-ANALYSIS-MARKER the whole report text")
      writeFileSync(files.theirs, "someone else's report")

      const hooks: any = await (FabulaPurgeHook as any)({})
      await hooks.event({ event: { type: "session.deleted", properties: { sessionID: mine } } })

      for (const [name, f] of Object.entries(files)) {
        const shouldSurvive = name === "theirs"
        expect(`${name}:${existsSync(f)}`).toBe(`${name}:${shouldSurvive}`)
      }
      // And the marker itself is nowhere under the data dir — the guarantee is "no trace", not "no index".
      const leftover = execFileSync("grep", ["-rl", "SECRET-ANALYSIS-MARKER", data], { encoding: "utf8" }).trim()
      expect(leftover).toBe("")
    } catch (e: any) {
      // grep exits 1 with no match — that IS the passing case.
      if (e?.status !== 1) throw e
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prev
      rmSync(data, { recursive: true, force: true })
    }
  })
})
