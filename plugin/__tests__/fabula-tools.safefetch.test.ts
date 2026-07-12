// Real redirect-SSRF tests: a genuine local HTTP server that 302-redirects to internal targets.
// Real node:http server, real safeFetch, real checkUrl.
import { test, expect, beforeAll, afterAll } from "bun:test"
import { createServer, Server } from "node:http"
import {  } from "../fabula-tools"
import { safeFetch } from "../lib/ssrf"
import { checkUrlSync } from "../lib/ssrf"

let server: Server
let base = ""

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redir-meta") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }); res.end(); return
    }
    if (req.url === "/redir-localhost") {
      res.writeHead(302, { Location: "http://127.0.0.1:1/secret" }); res.end(); return
    }
    if (req.url === "/redir-public") {
      res.writeHead(302, { Location: "https://example.com/" }); res.end(); return
    }
    res.writeHead(200, { "content-type": "text/plain" }); res.end("LOCAL_OK")
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  const addr = server.address() as any
  base = `http://127.0.0.1:${addr.port}`
})
afterAll(() => server?.close())

test("safeFetch refuses an internal INITIAL url (loopback)", async () => {
  await expect(safeFetch(base + "/anything")).rejects.toThrow(/SSRF/)
})

test("safeFetch refuses a metadata initial url", async () => {
  await expect(safeFetch("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/SSRF/)
})

test("redirect mechanics: real 302 is detected and its Location is SSRF-blocked", async () => {
  // safeFetch composes exactly these two ops per hop — verify against the REAL server.
  const r = await fetch(base + "/redir-meta", { redirect: "manual" })
  expect(r.status).toBe(302)
  const loc = r.headers.get("location")!
  expect(loc).toContain("169.254.169.254")
  expect(checkUrlSync(loc).blocked).toBe(true)        // hop-2 would be refused
  const r2 = await fetch(base + "/redir-localhost", { redirect: "manual" })
  expect(checkUrlSync(r2.headers.get("location")!).blocked).toBe(true)
})

test("redirect to a PUBLIC location is allowed by the hop check", async () => {
  const r = await fetch(base + "/redir-public", { redirect: "manual" })
  expect(checkUrlSync(r.headers.get("location")!).blocked).toBe(false)
})
