// Live MCP test for mcp:"current-time" (fabula.config.json -> mcp."current-time").
// Spawns the REAL server process (paper-venv python + time-stdio.py) and drives it over
// newline-delimited JSON-RPC on stdio, exactly as the engine does.
//
// Asserts:
//   - tools/list exposes get_current_datetime + get_utc_datetime
//   - get_current_datetime returns a plausible current date (ISO YYYY-MM-DD + weekday), and the
//     date matches the test host's own clock (real system time, not a frozen/stale value)
//   - get_utc_datetime returns an ISO-ish UTC datetime ("YYYY-MM-DD HH:MM:SS UTC")
//   - a bad tools/call (unknown tool) is handled gracefully (isError result, server stays alive),
//     and a subsequent good call STILL works (no crash / no stream corruption)
//   - an unknown JSON-RPC *method* yields a top-level JSON-RPC error object (not a crash)
//
// Run:
//   cd <repo>/plugin
//   set -a; . ../.env; set +a
//   bun test __tests__/mcp-current-time.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

// --- Resolve the server command straight from fabula.config.json (single source of truth) ----------
const CONFIG_PATH = new URL("../../fabula.config.json", import.meta.url).pathname
// fabula.config.json is a user-local (gitignored) config — absent on fresh checkouts/CI → skip gracefully.
const cfg = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : null
const mcpEntry = cfg?.mcp?.["current-time"]
const command: string[] = mcpEntry?.command ?? []
const environment: Record<string, string> = mcpEntry?.environment ?? {}

// Hard dependency: the python interpreter and the server script must exist. If not, skip gracefully
// (test.if) rather than fail — and the missing-dep is surfaced in the run output below.
const hasDeps =
  command.length >= 2 && existsSync(command[0]) && existsSync(command[1])

if (!hasDeps) {
  // Visible in the bun output so a skipped run is never silent.
  console.warn(
    `[mcp-current-time] SKIP: missing dependency. command=${JSON.stringify(command)} ` +
      `python-exists=${command[0] ? existsSync(command[0]) : false} ` +
      `script-exists=${command[1] ? existsSync(command[1]) : false}`,
  )
}

// --- Minimal newline-delimited JSON-RPC client over the child's stdio --------------------------
type Json = any
class McpStdioClient {
  proc!: ChildProcessWithoutNullStreams
  private buf = ""
  private waiters = new Map<number, (msg: Json) => void>()
  stderr = ""

  start() {
    this.proc = spawn(command[0], command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      // Inherit the (already env-sourced) process env, then overlay the config's environment.
      env: { ...process.env, ...environment },
    }) as ChildProcessWithoutNullStreams

    this.proc.stdout.setEncoding("utf8")
    this.proc.stdout.on("data", (chunk: string) => {
      this.buf += chunk
      let idx: number
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx).trim()
        this.buf = this.buf.slice(idx + 1)
        if (!line) continue
        let msg: Json
        try {
          msg = JSON.parse(line)
        } catch {
          // Non-JSON line (some servers log to stdout) — ignore, don't crash the harness.
          continue
        }
        if (msg && typeof msg.id === "number" && this.waiters.has(msg.id)) {
          const w = this.waiters.get(msg.id)!
          this.waiters.delete(msg.id)
          w(msg)
        }
      }
    })
    this.proc.stderr.setEncoding("utf8")
    this.proc.stderr.on("data", (c: string) => (this.stderr += c))
  }

  private send(obj: Json) {
    this.proc.stdin.write(JSON.stringify(obj) + "\n")
  }

  // Send a request and await its matching-id response (or time out).
  request(id: number, method: string, params?: Json, timeoutMs = 8000): Promise<Json> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(
          new Error(
            `timeout waiting for id=${id} method=${method}; stderr=${this.stderr.slice(-400)}`,
          ),
        )
      }, timeoutMs)
      this.waiters.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })
    })
  }

  notify(method: string, params?: Json) {
    this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })
  }

  async stop() {
    try {
      this.proc.stdin.end()
    } catch {}
    this.proc.kill("SIGTERM")
    // Give it a moment; force-kill if still alive.
    await new Promise((r) => setTimeout(r, 200))
    try {
      this.proc.kill("SIGKILL")
    } catch {}
  }
}

let client: McpStdioClient | null = null

beforeAll(async () => {
  if (!hasDeps) return
  client = new McpStdioClient()
  client.start()
  // MCP handshake.
  const init = await client.request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fabula-mcp-test", version: "1" },
  })
  expect(init.result?.serverInfo?.name).toBeDefined()
  client.notify("notifications/initialized")
})

afterAll(async () => {
  if (client) await client.stop()
})

// Helper: pull the text out of a tools/call result (content[].text or structuredContent.result).
function callText(res: Json): string {
  const r = res?.result
  if (!r) return ""
  if (typeof r?.structuredContent?.result === "string") return r.structuredContent.result
  if (Array.isArray(r?.content)) {
    return r.content
      .filter((c: Json) => c?.type === "text" && typeof c.text === "string")
      .map((c: Json) => c.text)
      .join("\n")
  }
  return ""
}

test.if(hasDeps)("tools/list exposes get_current_datetime + get_utc_datetime", async () => {
  const res = await client!.request(2, "tools/list")
  const names: string[] = (res.result?.tools ?? []).map((t: Json) => t.name)
  expect(names).toContain("get_current_datetime")
  expect(names).toContain("get_utc_datetime")
})

test.if(hasDeps)(
  "get_current_datetime returns a plausible current date matching the host clock",
  async () => {
    const res = await client!.request(3, "tools/call", {
      name: "get_current_datetime",
      arguments: {},
    })
    expect(res.error).toBeUndefined()
    expect(res.result?.isError).not.toBe(true)
    const text = callText(res)
    // The server returns: "Today is YYYY-MM-DD (Weekday), local time HH:MM:SS TZ. ..."
    const m = text.match(/(\d{4})-(\d{2})-(\d{2})/)
    expect(m).not.toBeNull()
    // Must carry a weekday + a HH:MM:SS clock — it's a real datetime, not a bare string.
    expect(text).toMatch(/\((Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\)/)
    expect(text).toMatch(/\d{2}:\d{2}:\d{2}/)

    // REAL-TIME check: the returned local date must equal THIS host's local date (allowing the
    // adjacent day in case the call straddles midnight). Proves it reads the live system clock.
    const now = new Date()
    const localISO = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`
    const today = localISO(now)
    const yesterday = localISO(new Date(now.getTime() - 86400_000))
    const tomorrow = localISO(new Date(now.getTime() + 86400_000))
    const got = `${m![1]}-${m![2]}-${m![3]}`
    expect([yesterday, today, tomorrow]).toContain(got)
  },
)

test.if(hasDeps)("get_utc_datetime returns an ISO-ish UTC datetime", async () => {
  const res = await client!.request(4, "tools/call", {
    name: "get_utc_datetime",
    arguments: {},
  })
  expect(res.error).toBeUndefined()
  expect(res.result?.isError).not.toBe(true)
  const text = callText(res).trim()
  // Format from the server: "YYYY-MM-DD HH:MM:SS UTC"
  expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/)
  // Parse it and confirm it's within a sane window of the host's UTC now (< 2 minutes skew).
  const iso = text.replace(" ", "T").replace(" UTC", "Z").replace(/ UTC$/, "Z")
  const parsed = Date.parse(iso.endsWith("Z") ? iso : iso + "Z")
  expect(Number.isNaN(parsed)).toBe(false)
  expect(Math.abs(Date.now() - parsed)).toBeLessThan(120_000)
})

test.if(hasDeps)(
  "bad tools/call (unknown tool) is handled gracefully and server survives",
  async () => {
    const res = await client!.request(5, "tools/call", {
      name: "totally_unknown_tool_xyz",
      arguments: {},
    })
    // FastMCP convention: an unknown tool comes back as a *result* with isError:true (NOT a crash,
    // NOT a stream break). Either a top-level JSON-RPC error OR isError:true is acceptable; what
    // matters is the server didn't die. Assert on whichever form is present.
    const signaledError =
      res.error !== undefined || res.result?.isError === true
    expect(signaledError).toBe(true)
    if (res.result?.isError === true) {
      expect(callText(res).toLowerCase()).toContain("unknown tool")
    }

    // CRITICAL: the server must still be alive and answering after the bad call.
    const ok = await client!.request(6, "tools/call", {
      name: "get_utc_datetime",
      arguments: {},
    })
    expect(ok.result?.isError).not.toBe(true)
    expect(callText(ok)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/)
  },
)

test.if(hasDeps)("unknown JSON-RPC method yields a top-level JSON-RPC error (not a crash)", async () => {
  const res = await client!.request(7, "this/method/does/not/exist")
  expect(res.error).toBeDefined()
  expect(typeof res.error.code).toBe("number")
  // And the server is still responsive afterward.
  const ok = await client!.request(8, "tools/call", {
    name: "get_current_datetime",
    arguments: {},
  })
  expect(ok.result?.isError).not.toBe(true)
})
