import { afterEach, describe, expect, test } from "bun:test"
import nodePath from "path"
import { tmpdir } from "os"
import { mkdtempSync, writeFileSync } from "fs"
import { GlobalRoutes } from "../../src/server/routes/global"
import { isLoopbackURL, nothingListening, tcpProbe } from "../../src/server/routes/global"

// The picker offers a model only when its provider really serves it. Everything unanswered fails
// OPEN — a menu emptied by a network blip is no product. The single exception is a local address
// with NOTHING LISTENING on its port, established by CONNECTING, never by reading the failed
// request's error text.
//
// That distinction is the whole correctness of the feature and it was paid for. The first version
// classified the fetch error; with HTTP_PROXY set, Bun routes even a loopback request through the
// proxy and an unreachable proxy rejects with a message byte-identical to a closed local port — so
// a runtime answering HTTP 200 was hidden entirely, the exact outcome the route exists to prevent.
// The last case in this file is that defect, driven end to end.

const configs: string[] = []
function configFor(providers: Record<string, { options?: { baseURL?: string } }>) {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "models-served-"))
  const file = nodePath.join(dir, "config.json")
  writeFileSync(file, JSON.stringify({ provider: providers }))
  configs.push(file)
  process.env["MIMOCODE_CONFIG"] = file
  return file
}
afterEach(() => delete process.env["MIMOCODE_CONFIG"])

async function askRoute(providerID: string) {
  const res = await GlobalRoutes().request("/fabula/models-served")
  const body = (await res.json()) as { served: Record<string, string[] | null> }
  return body.served[providerID]
}

describe("which addresses may ever be called empty", () => {
  test("every spelling this machine answers itself", () => {
    for (const base of [
      "http://localhost:1236/v1",
      "http://LOCALHOST:1236/v1",
      "http://app.localhost:3000/v1",
      "http://127.0.0.1:1234/v1",
      "http://127.4.5.6:9/v1",
      "http://[::1]:1236/v1",
      "http://[0:0:0:0:0:0:0:1]:1236/v1",
      // The IPv4-mapped spelling a runtime can hand back; it is this machine either way.
      "http://[::ffff:127.0.0.1]:1236/v1",
    ]) {
      expect(isLoopbackURL(base)).toBe(true)
    }
  })

  test("anything else is somebody else's machine and can never be called empty", () => {
    for (const base of [
      "https://api.example.com/v1",
      "http://192.168.1.10:1234/v1",
      "http://10.0.0.5/v1",
      "http://[2001:db8::1]:80/v1",
      "not a url",
      "",
    ]) {
      expect(isLoopbackURL(base)).toBe(false)
    }
  })
})

describe("nobody is listening is asked of the kernel", () => {
  const probe = (answer: "open" | "refused" | "unknown") => {
    const calls: string[] = []
    return {
      calls,
      fn: async (host: string, port: number) => {
        calls.push(`${host}:${port}`)
        return answer
      },
    }
  }

  test("a refused port is the one answer that hides", async () => {
    const p = probe("refused")
    expect(await nothingListening("http://localhost:1236/v1", p.fn)).toBe(true)
    expect(p.calls).toEqual(["localhost:1236"])
  })

  test("an OPEN port hides nothing, whatever the request did", async () => {
    // This is the proxy case in miniature: the request failed, but something IS there.
    expect(await nothingListening("http://localhost:1236/v1", probe("open").fn)).toBe(false)
  })

  test("a probe that cannot tell hides nothing", async () => {
    expect(await nothingListening("http://localhost:1236/v1", probe("unknown").fn)).toBe(false)
  })

  test("a probe that throws hides nothing", async () => {
    const boom = async () => {
      throw new Error("no")
    }
    expect(await nothingListening("http://localhost:1236/v1", boom)).toBe(false)
  })

  test("a remote address is never probed and never hides", async () => {
    const p = probe("refused")
    expect(await nothingListening("https://api.example.com/v1", p.fn)).toBe(false)
    expect(p.calls).toEqual([])
  })

  test("the port is read from the URL, and the scheme supplies the default", async () => {
    const p = probe("refused")
    await nothingListening("https://localhost/v1", p.fn)
    await nothingListening("http://127.0.0.1/v1", p.fn)
    expect(p.calls).toEqual(["localhost:443", "127.0.0.1:80"])
  })
})

describe("the probe asks the kernel, against real sockets", () => {
  test("a port something is bound to answers open", async () => {
    using runtime = Bun.serve({ port: 0, fetch: () => new Response("hi") })
    expect(await tcpProbe("127.0.0.1", runtime.port!)).toBe("open")
  })

  test("a port nothing is bound to answers refused", async () => {
    // Port 1 on loopback: privileged, never bound by a user process, refused by the kernel.
    expect(await tcpProbe("127.0.0.1", 1)).toBe("refused")
  })

  test("a failure that is NOT a refusal answers unknown, never refused", async () => {
    // `.invalid` is reserved never to resolve, so the socket fails with a name error. The kernel
    // did not say "no listener" — it never got to ask — and only that sentence may hide a model.
    expect(await tcpProbe("nothing.invalid", 80, 4000)).toBe("unknown")
  }, 15_000)

  test("a connection that neither opens nor fails answers unknown at the deadline", async () => {
    // 192.0.2.0/24 is reserved for documentation and is not routed, so the attempt simply hangs.
    const started = Date.now()
    expect(await tcpProbe("192.0.2.1", 9, 700)).toBe("unknown")
    expect(Date.now() - started).toBeLessThan(6000)
  }, 15_000)
})

describe("the route itself", () => {
  test("a provider that answers is reported by what it named", async () => {
    using runtime = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/v1/models"
          ? Response.json({ data: [{ id: "kat" }, { id: "qwen" }] })
          : new Response("no", { status: 404 }),
    })
    configFor({ lmstudio: { options: { baseURL: `http://localhost:${runtime.port}/v1` } } })
    expect(await askRoute("lmstudio")).toEqual(["kat", "qwen"])
  })

  test("a local port with nothing listening is reported EMPTY", async () => {
    // Port 1 on loopback: privileged, never bound by a user process, refused by the kernel.
    configFor({ "fuse-local": { options: { baseURL: "http://127.0.0.1:1/v1" } } })
    expect(await askRoute("fuse-local")).toEqual([])
  })

  test("a REMOTE address that cannot be reached stays null — fail open", async () => {
    configFor({ cloud: { options: { baseURL: "http://192.0.2.1:1/v1" } } })
    expect(await askRoute("cloud")).toBeNull()
  }, 20_000)

  test("a provider with no baseURL stays null", async () => {
    configFor({ nameless: {} })
    expect(await askRoute("nameless")).toBeNull()
  })

  test("an answer we cannot read stays null — an unreadable reply is not an empty catalogue", async () => {
    using runtime = Bun.serve({ port: 0, fetch: () => new Response("<html>not json</html>") })
    configFor({ weird: { options: { baseURL: `http://localhost:${runtime.port}/v1` } } })
    expect(await askRoute("weird")).toBeNull()
  })

  test("a request that FAILS while the port is OPEN hides nothing", async () => {
    // The shape of every reported false-hide: the request did not succeed, yet a runtime is there.
    // A server that accepts the connection and never answers makes the fetch time out.
    using runtime = Bun.serve({ port: 0, idleTimeout: 0, fetch: () => new Promise<Response>(() => {}) })
    configFor({ busy: { options: { baseURL: `http://localhost:${runtime.port}/v1` } } })
    expect(await askRoute("busy")).toBeNull()
  }, 20_000)
})

describe("a proxy in the environment must not hide a live local runtime", () => {
  // THE regression this file exists for, and it cannot be driven in-process: the proxy decision is
  // read by the fetch runtime from the environment it STARTED with, so the env must come from
  // outside. A child process is the honest instrument.
  test("a runtime answering 200 stays visible with an unreachable HTTP_PROXY set", async () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "models-served-proxy-"))
    const driver = nodePath.join(dir, "driver.ts")
    const routeModule = nodePath.join(import.meta.dir, "../../src/server/routes/global.ts")
    writeFileSync(
      driver,
      `import { GlobalRoutes } from ${JSON.stringify(routeModule)}
const runtime = Bun.serve({ port: 0, fetch: (req) =>
  new URL(req.url).pathname === "/v1/models" ? Response.json({ data: [{ id: "kat" }] }) : new Response("no", { status: 404 }) })
const cfg = ${JSON.stringify(nodePath.join(dir, "config.json"))}
await Bun.write(cfg, JSON.stringify({ provider: { lmstudio: { options: { baseURL: \`http://localhost:\${runtime.port}/v1\` } } } }))
process.env["MIMOCODE_CONFIG"] = cfg
const res = await GlobalRoutes().request("/fabula/models-served")
const body = await res.json()
console.log(JSON.stringify(body.served["lmstudio"]))
runtime.stop(true)
process.exit(0)
`,
    )
    // 127.0.0.1:1 is refused, so the proxy is definitively unreachable; NO_PROXY is cleared so
    // nothing in the developer's environment can accidentally make this pass, and the parent's
    // MIMOCODE_CONFIG is dropped so the child reads only the config it writes for itself.
    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    delete env["MIMOCODE_CONFIG"]
    Object.assign(env, {
      HTTP_PROXY: "http://127.0.0.1:1",
      http_proxy: "http://127.0.0.1:1",
      NO_PROXY: "",
      no_proxy: "",
    })
    const proc = Bun.spawn({ cmd: ["bun", "run", driver], env, stdout: "pipe", stderr: "pipe" })
    const out = (await new Response(proc.stdout).text()).trim()
    const answer = JSON.parse(out.split("\n").filter(Boolean).pop() ?? "null")
    // It may be the ids (the proxy was bypassed) or null (the request failed but the port is open).
    // What it must NEVER be is the empty array: that would hide a runtime that is serving.
    expect(answer).not.toEqual([])
  }, 30_000)
})
