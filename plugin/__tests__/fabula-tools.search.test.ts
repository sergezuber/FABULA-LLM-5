// Live test: session_search against the REAL engine history DB (read-only). Skips gracefully if the DB
// isn't present (e.g. CI), so it never produces a false failure.
import { test, expect } from "bun:test"
import { existsSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { FabulaTools } from "../fabula-tools"

const dbPath = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "fabula", "fabula.db")
const hasDb = existsSync(dbPath)
const ctx = { sessionID: "live-test-session", directory: "/tmp", abort: new AbortController().signal } as any

test.if(hasDb)("session_search finds past work for a common term", async () => {
  const T = (await FabulaTools({} as any)).tool
  const r = await T.session_search.execute({ query: "plugin", limit: 5 }, ctx)
  const out = typeof r === "string" ? r : r.output
  expect(out).toMatch(/Found \d+ match/)
  expect(out).toContain("▸") // at least one session group
  expect((r as any).metadata.matches).toBeGreaterThan(0)
})

test.if(hasDb)("session_search empty-term query is handled", async () => {
  const T = (await FabulaTools({} as any)).tool
  const r = await T.session_search.execute({ query: "!!!", limit: 5 }, ctx)
  expect(typeof r === "string" ? r : r.output).toContain("no searchable terms")
})

test.if(hasDb)("session_search: nonsense term → no matches (not an error)", async () => {
  const T = (await FabulaTools({} as any)).tool
  // runtime-random token so it cannot already be in the indexed history (a literal would self-index)
  const term = "zq" + crypto.randomUUID().replace(/-/g, "")
  const r = await T.session_search.execute({ query: term, limit: 5 }, ctx)
  expect(typeof r === "string" ? r : r.output).toContain("no matches")
})
