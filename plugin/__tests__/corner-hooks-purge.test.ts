// EXHAUSTIVE corner-case tests for hooks:fabula-purge (fabula-purge-hook.ts).
// Invokes the REAL FabulaPurgeHook() event hook with the engine's exact event contract
// and asserts real fs effects (rm -rf of a per-session memory dir).
//
// SAFETY: the hook derives the real DATA path
//   ~/.local/share/fabula/memory/sessions/<id>   (XDG_DATA_HOME/fabula; engine app id "fabula")
// We never touch a real `ses_*` dir. Every dir we create/assert-on uses a unique throwaway id
//   `fabula-purge-test-<pid>-<n>`  (never starts with `ses_`),
// and afterAll re-asserts that NO real ses_* dir was removed (snapshot before/after).
import { test, expect, beforeAll, afterAll } from "bun:test"
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
