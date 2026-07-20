// Durable guards for the append-only memory store.
//
// These exist because an independent verifier proved every one of them could be REMOVED with the frozen
// acceptance suite still fully green: `appendRaw` could be turned from an append into an overwrite
// (2 records in, 1 retained) and the origin refusal could be deleted, and nothing went red. A property
// that only one private suite defends is a property one refactor away from gone.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { appendRaw, readStore, consolidate, resolveConflict, currentRecords, storeDir } from "./memstore"

let dir: string
const ORIGIN = { kind: "user", ref: "test", at: 1 }
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "memstore-")) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

test("appending twice retains BOTH records — the store appends, it does not overwrite", () => {
  appendRaw({ text: "first", origin: ORIGIN }, { dir })
  appendRaw({ text: "second", origin: ORIGIN }, { dir })
  const v = readStore({ dir })
  expect(v.entries.length).toBe(2)
  expect(v.entries.map((e) => e.text)).toEqual(["first", "second"])
})

test("a record with no origin is REFUSED, not stored with a blank field", () => {
  // Provenance attached later can be laundered — by the agent's own summary, by a tool echoing content
  // back, or by manufactured corroboration — so it is bound at write time or the record does not exist.
  expect(() => appendRaw({ text: "unsourced" } as any, { dir })).toThrow()
  expect(readStore({ dir }).entries.length).toBe(0)
})

test("the serial is allocated by the STORE, so a caller cannot manufacture a tie", () => {
  const a = appendRaw({ text: "a", serial: 999, origin: ORIGIN } as any, { dir })
  const b = appendRaw({ text: "b", serial: 999, origin: ORIGIN } as any, { dir })
  expect(a.serial).not.toBe(b.serial)
  expect(b.serial).toBeGreaterThan(a.serial)
})

test("a non-string text is normalised rather than stored as an object", () => {
  // The field order once put the caller's spread AFTER the normalisation, which made the normalisation
  // dead code: an object handed in as `text` was stored verbatim and the store held records whose text
  // was not text.
  const r = appendRaw({ text: { a: 1 } as any, origin: ORIGIN }, { dir })
  expect(typeof r.text).toBe("string")
})

test("shedding DECLARES what it dropped and keeps it readable", () => {
  for (let i = 0; i < 12; i++) appendRaw({ text: `r${i}`, origin: ORIGIN }, { dir, cap: 5 })
  const v = readStore({ dir })
  expect(v.retained).toBeLessThanOrEqual(5)
  expect(v.dropped).toBeGreaterThan(0)
  expect(v.totalSeen).toBe(12)
  expect(v.note).toContain("window")
  // dropped ≠ destroyed: the shed records stay readable in the archive
  const archived = readFileSync(path.join(dir, "archive.jsonl"), "utf8")
  expect(archived).toContain("r0")
})

test("consolidation ARCHIVES its inputs verbatim before writing the summary", () => {
  // A pass that summarises evidence and relies on the caller having kept it is not preserving evidence.
  const a = appendRaw({ text: "SOURCE_ALPHA", origin: ORIGIN }, { dir })
  const b = appendRaw({ text: "SOURCE_BETA", origin: ORIGIN }, { dir })
  consolidate([a, b], "one summary", { dir })
  const archived = readFileSync(path.join(dir, "archive.jsonl"), "utf8")
  expect(archived).toContain("SOURCE_ALPHA")
  expect(archived).toContain("SOURCE_BETA")
})

test("consolidation accepts (sources, opts) as well as (sources, summary, opts)", () => {
  // Reading the two-argument form as the three-argument one stored the OPTIONS OBJECT as the memory's
  // text and, having lost the directory, wrote the record somewhere else entirely.
  const a = appendRaw({ text: "src", origin: ORIGIN }, { dir })
  const r = consolidate([a], { dir } as any)
  expect(typeof r.text).toBe("string")
  expect(readStore({ dir }).entries.some((e) => e.id === r.id)).toBe(true)
})

test("the consolidated record supersedes its sources, and the sources remain readable", () => {
  const a = appendRaw({ text: "old fact", origin: ORIGIN }, { dir })
  consolidate([a], "new summary", { dir })
  expect(readStore({ dir }).entries.some((e) => e.text === "old fact")).toBe(true)
  expect(currentRecords({ dir }).some((e) => e.id === a.id)).toBe(false)
})

test("conflict resolution is deterministic and order-independent — highest serial wins", () => {
  const a = appendRaw({ text: "port 5432", origin: ORIGIN }, { dir })
  const b = appendRaw({ text: "port 5433", origin: ORIGIN }, { dir })
  expect(resolveConflict([a, b])?.id).toBe(b.id)
  expect(resolveConflict([b, a])?.id).toBe(b.id)
  // …and no clock is consulted: a record with a newer timestamp but a lower serial still loses.
  const stale = { ...a, ts: Date.now() + 1e6 }
  expect(resolveConflict([stale as any, b])?.id).toBe(b.id)
})

test("under a test runner with no data home, the store NEVER resolves to the user's home", () => {
  // Measured failure this guards: 71 junk records accumulated in the developer's real
  // ~/.local/share/fabula/memstore while the tests read a temp dir and reported records missing.
  const resolved = storeDir({ BUN_TEST: "1" })
  expect(resolved.startsWith(os.tmpdir())).toBe(true)
  expect(resolved.includes(os.homedir() + "/.local")).toBe(false)
  // an explicitly chosen data home is still honoured — the guard must not take the override away
  expect(storeDir({ XDG_DATA_HOME: "/tmp/xyz", BUN_TEST: "1" })).toBe("/tmp/xyz/fabula/memstore")
})

test("a torn or unparseable line never takes the store down", () => {
  appendRaw({ text: "good", origin: ORIGIN }, { dir })
  require("node:fs").appendFileSync(path.join(dir, "raw.jsonl"), "{not json\n", "utf8")
  expect(readStore({ dir }).entries.some((e) => e.text === "good")).toBe(true)
})

test("the store directory is created on demand rather than requiring a caller to prepare it", () => {
  const fresh = path.join(dir, "nested", "deeper")
  expect(existsSync(fresh)).toBe(false)
  appendRaw({ text: "x", origin: ORIGIN }, { dir: fresh })
  expect(readStore({ dir: fresh }).entries.length).toBe(1)
})
