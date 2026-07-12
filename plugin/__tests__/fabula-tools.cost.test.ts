// Live tests: cost_report against the real engine DB + batch_run via the aux model.
import { test, expect, beforeAll } from "bun:test"
import { existsSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { FabulaTools } from "../fabula-tools"

let T: any
const ctx = { sessionID: "s", directory: "/tmp", abort: new AbortController().signal } as any
const out = (r: any) => (typeof r === "string" ? r : r.output)
const hasDb = existsSync(path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "fabula", "fabula.db"))
const hasCloud = !!process.env.NVIDIA_API_KEY || !!process.env.ZHIPU_API_KEY
beforeAll(async () => { T = (await FabulaTools({} as any)).tool })

test.if(hasDb)("cost_report (all) returns a usage breakdown from real history", async () => {
  const r = await T.cost_report.execute({ scope: "all" }, ctx)
  const o = out(r)
  expect(o).toMatch(/Cost report|no usage/)
  // the real DB has many model calls → expect a populated report
  expect(o).toContain("tokens")
}, 20000)

test("batch_run requires {item} in template", async () => {
  const r = await T.batch_run.execute({ items: ["a"], template: "no placeholder" }, ctx)
  expect(out(r)).toContain("must contain {item}")
})

test.if(hasCloud)("batch_run processes a list via the aux model", async () => {
  const r = await T.batch_run.execute({ items: ["France", "Japan"], template: "Capital of {item}? One word.", max_tokens: 12 }, ctx)
  const o = out(r).toLowerCase()
  if (o.includes("no aux model reachable")) { console.warn("skip: aux saturated under parallel load"); return }
  expect(o).toContain("paris")
  expect(o).toContain("tokyo")
}, 120000)
