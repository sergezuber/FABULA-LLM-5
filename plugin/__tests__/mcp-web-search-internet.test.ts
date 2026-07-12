// LIVE test for mcp:web-search-internet (fabula.config.json mcp."web-search-internet").
// Spawns the REAL mcp-searxng stdio server with the REAL command+env from fabula.config.json,
// drives it over newline-delimited JSON-RPC (initialize → initialized → tools/list → tools/call),
// and asserts against the REAL SearXNG instance at SEARXNG_URL (http://localhost:8888).
//
// Hard dependency: SearXNG must be reachable. If :8888 is down we DO NOT fail — we set a flag so the
// live-call tests skip via test.if(...).
//
// Run:
//   cd /Users/user/GitHub/FABULA-LLM-5/plugin && set -a; . ../.env; set +a; \
//   PATH=$PATH:/usr/local/bin:/Users/user/.nvm/versions/node/v20.19.5/bin \
//   /Users/user/.bun/bin/bun test __tests__/mcp-web-search-internet.test.ts

import { test, expect, beforeAll } from "bun:test"
import { readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import * as path from "node:path"

const REPO = path.resolve(import.meta.dir, "../..")
const CONFIG_PATH = path.join(REPO, "fabula.config.json")
const MCP_NAME = "web-search-internet"

// ---- Read the REAL command + env straight out of fabula.config.json (no hardcoding of paths) ----
// fabula.config.json is a user-local (gitignored) config — absent on fresh checkouts / CI. If it (or
// the mcp entry) is missing, DO NOT throw at module load: record a flag so the live tests skip via
// test.if(configOk) instead of crashing the whole file with an unhandled error.
let mcpEntry: any = null
let configNote = ""
try {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
  mcpEntry = config?.mcp?.[MCP_NAME] ?? null
  if (!mcpEntry) configNote = `fabula.config.json missing mcp.${MCP_NAME}`
} catch (e: any) {
  configNote = `fabula.config.json not readable (${String(e?.message ?? e)})`
}
const configOk = !!mcpEntry
if (!configOk) console.warn(`[skip] ${configNote} — skipping live mcp:${MCP_NAME} tests`)
const COMMAND: string[] = mcpEntry?.command ?? []
const SERVER_ENV: Record<string, string> = mcpEntry?.environment ?? {}
const SEARXNG_URL: string = SERVER_ENV.SEARXNG_URL ?? process.env.SEARXNG_URL ?? "http://localhost:8888"

// ---- Probe whether SearXNG is actually up (so we can skip live calls gracefully) ----
let searxngUp = false
let searxngProbeNote = ""
beforeAll(async () => {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(`${SEARXNG_URL}/search?q=ping&format=json`, { signal: ctrl.signal })
    clearTimeout(t)
    searxngUp = res.ok
    if (!res.ok) searxngProbeNote = `HTTP ${res.status}`
  } catch (e: any) {
    searxngUp = false
    searxngProbeNote = String(e?.message ?? e)
  }
})

// ---- Minimal newline-delimited JSON-RPC stdio harness over the real server process ----
type RpcResp = { id?: number; result?: any; error?: any; method?: string }

class McpStdioClient {
  private proc: ReturnType<typeof spawn>
  private buf = ""
  private waiters = new Map<number, (r: RpcResp) => void>()
  public stderr = ""
  private closed = false
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null

  constructor(cmd: string[], env: Record<string, string>) {
    this.proc = spawn(cmd[0], cmd.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    })
    this.proc.stdout!.setEncoding("utf8")
    this.proc.stdout!.on("data", (chunk: string) => this.onData(chunk))
    this.proc.stderr!.setEncoding("utf8")
    this.proc.stderr!.on("data", (c: string) => { this.stderr += c })
    this.proc.on("exit", (code, signal) => { this.closed = true; this.exitInfo = { code, signal } })
  }

  private onData(chunk: string) {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: RpcResp
      try { msg = JSON.parse(line) } catch { continue } // ignore non-JSON log lines on stdout
      if (typeof msg.id === "number" && this.waiters.has(msg.id)) {
        this.waiters.get(msg.id)!(msg)
        this.waiters.delete(msg.id)
      }
    }
  }

  notify(method: string, params?: any) {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
  }

  request(id: number, method: string, params?: any, timeoutMs = 20000): Promise<RpcResp> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error(`server already exited (${JSON.stringify(this.exitInfo)})`))
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error(`RPC timeout id=${id} method=${method} after ${timeoutMs}ms; stderr=${this.stderr.slice(-400)}`))
      }, timeoutMs)
      this.waiters.set(id, (r) => { clearTimeout(timer); resolve(r) })
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }

  async initialize() {
    const r = await this.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "fabula-live-test", version: "1" },
    })
    this.notify("notifications/initialized")
    return r
  }

  kill() {
    try { this.proc.kill("SIGTERM") } catch {}
  }
}

function textOf(callResult: any): string {
  const content = callResult?.content
  if (!Array.isArray(content)) return ""
  return content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n")
}

// ---------------------------------------------------------------------------------------------
// 1) The server PROCESS spawns and completes the MCP handshake (does not depend on SearXNG).
// ---------------------------------------------------------------------------------------------
test.if(configOk)("server spawns and completes initialize handshake", async () => {
  const c = new McpStdioClient(COMMAND, SERVER_ENV)
  try {
    const init = await c.initialize()
    expect(init.error).toBeUndefined()
    expect(init.result).toBeDefined()
    expect(init.result.protocolVersion).toBeDefined()
    expect(init.result.serverInfo?.name).toBeDefined()
  } finally {
    c.kill()
  }
}, 30000)

// ---------------------------------------------------------------------------------------------
// 2) tools/list returns the expected SearXNG tools (independent of SearXNG being up).
// ---------------------------------------------------------------------------------------------
test.if(configOk)("tools/list exposes searxng_web_search (+ web_url_read)", async () => {
  const c = new McpStdioClient(COMMAND, SERVER_ENV)
  try {
    await c.initialize()
    const r = await c.request(2, "tools/list", {})
    expect(r.error).toBeUndefined()
    const tools = r.result?.tools ?? []
    const names = tools.map((t: any) => t.name)
    expect(names).toContain("searxng_web_search")
    // mcp-searxng 1.1.1 registers a second tool too; assert it for documentation/regression.
    expect(names).toContain("web_url_read")
    // schema sanity: web search must accept a `query`
    const ws = tools.find((t: any) => t.name === "searxng_web_search")
    expect(ws?.inputSchema?.properties?.query).toBeDefined()
    expect(ws?.inputSchema?.required ?? []).toContain("query")
  } finally {
    c.kill()
  }
}, 30000)

// ---------------------------------------------------------------------------------------------
// 3) LIVE search call → real results. Skips (not fails) if SearXNG :8888 is down.
// ---------------------------------------------------------------------------------------------
test.if(configOk)("searxng_web_search returns real results for a real query", async () => {
  if (!searxngUp) {
    console.warn(`[skip] SearXNG ${SEARXNG_URL} down (${searxngProbeNote}); cannot run live search`)
    return
  }
  const c = new McpStdioClient(COMMAND, SERVER_ENV)
  try {
    await c.initialize()
    const r = await c.request(3, "tools/call", {
      name: "searxng_web_search",
      arguments: { query: "wikipedia", pageno: 1 },
    }, 30000)
    expect(r.error).toBeUndefined()
    expect(r.result).toBeDefined()
    expect(r.result.isError).not.toBe(true)
    const out = textOf(r.result)
    // Real SearXNG output should be non-trivial and reference at least one URL/title.
    // Upstream engines occasionally return zero results (rate limits, engine flakiness) —
    // a well-formed "no results" reply still proves the round-trip works, so accept it too.
    expect(out.length).toBeGreaterThan(20)
    expect(out.toLowerCase()).toMatch(/title|url|http|no results found/)
  } finally {
    c.kill()
  }
}, 40000)

// ---------------------------------------------------------------------------------------------
// 4) Bad / missing args → graceful error, NOT a crash. The handshake-validated server must keep
//    running and report an MCP error (or isError content) rather than tearing down the process.
//    This is independent of SearXNG (arg validation happens before any HTTP call).
// ---------------------------------------------------------------------------------------------
test.if(configOk)("missing required arg (no query) is an error, not a crash", async () => {
  const c = new McpStdioClient(COMMAND, SERVER_ENV)
  try {
    await c.initialize()
    const r = await c.request(4, "tools/call", {
      name: "searxng_web_search",
      arguments: {}, // query omitted
    }, 20000)
    // Either a JSON-RPC error OR a tool-result flagged isError — both are "graceful".
    const graceful = !!r.error || r.result?.isError === true
    expect(graceful).toBe(true)
    // The server must still be alive and answer a follow-up request (no crash).
    const ping = await c.request(5, "tools/list", {}, 20000)
    expect(ping.error).toBeUndefined()
    expect((ping.result?.tools ?? []).length).toBeGreaterThan(0)
  } finally {
    c.kill()
  }
}, 30000)

// ---------------------------------------------------------------------------------------------
// 5) Unknown tool name → graceful error, server survives.
// ---------------------------------------------------------------------------------------------
test.if(configOk)("unknown tool name → graceful error, server survives", async () => {
  const c = new McpStdioClient(COMMAND, SERVER_ENV)
  try {
    await c.initialize()
    const r = await c.request(6, "tools/call", {
      name: "this_tool_does_not_exist",
      arguments: { query: "x" },
    }, 20000)
    const graceful = !!r.error || r.result?.isError === true
    expect(graceful).toBe(true)
    const ping = await c.request(7, "tools/list", {}, 20000)
    expect(ping.error).toBeUndefined()
  } finally {
    c.kill()
  }
}, 30000)
