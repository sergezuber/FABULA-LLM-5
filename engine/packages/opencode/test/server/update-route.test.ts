import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { fabulaLatestRelease, fabulaResetUpdateCache } from "../../src/server/routes/global"

// Driven against a REAL local HTTP server rather than a stubbed fetch: the thing worth checking is
// that a request is made, what it carries, and what happens when the answer is missing or wrong — none
// of which a stub can establish. `FABULA_UPDATE_API` exists for exactly this, and for a fork behind
// GitHub Enterprise.
//
// Every case counts the REQUESTS the server received. A cache that is claimed but not kept, and a
// switch that is honoured after the request rather than before it, both pass a check that only reads
// the return value.

let served: { status: number; body: unknown } = { status: 200, body: {} }
let requests: { path: string; ua: string | null }[] = []
let server: ReturnType<typeof Bun.serve> | undefined

beforeEach(() => {
  requests = []
  served = { status: 200, body: {} }
  server = Bun.serve({
    port: 0,
    fetch(req) {
      requests.push({ path: new URL(req.url).pathname, ua: req.headers.get("user-agent") })
      if (served.status !== 200) return new Response("no", { status: served.status })
      return Response.json(served.body)
    },
  })
  process.env["FABULA_UPDATE_API"] = `http://127.0.0.1:${server.port}`
  delete process.env["FABULA_UPDATE_CHECK"]
  delete process.env["FABULA_UPDATE_REPO"]
  fabulaResetUpdateCache()
})

afterEach(() => {
  server?.stop(true)
  delete process.env["FABULA_UPDATE_API"]
  delete process.env["FABULA_UPDATE_CHECK"]
  delete process.env["FABULA_UPDATE_REPO"]
  fabulaResetUpdateCache()
})

describe("what the check asks, and of whom", () => {
  test("it names the release and its page", async () => {
    served.body = { tag_name: "v0.221.0", html_url: "https://example.com/releases/tag/v0.221.0" }
    expect(await fabulaLatestRelease()).toEqual({
      release: { version: "v0.221.0", url: "https://example.com/releases/tag/v0.221.0" },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.path).toBe("/repos/sergezuber/FABULA-LLM-5/releases/latest")
  })

  test("a fork points the check at its own repository", async () => {
    process.env["FABULA_UPDATE_REPO"] = "someone/their-fork"
    served.body = { tag_name: "v1.0.0", html_url: "https://example.com/x" }
    await fabulaLatestRelease()
    expect(requests[0]!.path).toBe("/repos/someone/their-fork/releases/latest")
  })

  test("it sends a User-Agent and nothing else about this machine", async () => {
    served.body = { tag_name: "v0.221.0", html_url: "https://example.com/x" }
    await fabulaLatestRelease()
    // api.github.com answers 403 without one, so it cannot be omitted. It carries the product name
    // alone — no version, no platform, no identifier: the running version is precisely what the
    // reader has not agreed to publish.
    expect(requests[0]!.ua).toBe("FABULA")
    expect(requests[0]!.path).not.toContain("0.2")
  })
})

describe("the switch is honoured BEFORE anything is sent", () => {
  test("FABULA_UPDATE_CHECK=0 makes no request at all", async () => {
    process.env["FABULA_UPDATE_CHECK"] = "0"
    const r = await fabulaLatestRelease()
    expect(r.release).toBeNull()
    expect(r.reason).toContain("FABULA_UPDATE_CHECK=0")
    // The point of the case: not that it answered null, but that nothing left the machine.
    expect(requests).toHaveLength(0)
  })
})

describe("asking again does not ask again", () => {
  test("a success is cached", async () => {
    served.body = { tag_name: "v0.221.0", html_url: "https://example.com/x" }
    await fabulaLatestRelease(1_000)
    await fabulaLatestRelease(2_000)
    await fabulaLatestRelease(60_000)
    expect(requests).toHaveLength(1)
  })

  test("past the window it asks once more", async () => {
    served.body = { tag_name: "v0.221.0", html_url: "https://example.com/x" }
    await fabulaLatestRelease(1_000)
    await fabulaLatestRelease(1_000 + 6 * 60 * 60 * 1000 + 1)
    expect(requests).toHaveLength(2)
  })

  test("a failure is cached only briefly, so an offline machine does not retry on every render", async () => {
    served.status = 500
    expect((await fabulaLatestRelease(1_000)).release).toBeNull()
    await fabulaLatestRelease(2_000)
    expect(requests).toHaveLength(1)
    await fabulaLatestRelease(1_000 + 5 * 60 * 1000 + 1)
    expect(requests).toHaveLength(2)
  })
})

describe("anything it cannot answer is a null with a reason, never a guess", () => {
  test("a refusing server", async () => {
    served.status = 503
    const r = await fabulaLatestRelease()
    expect(r.release).toBeNull()
    expect(r.reason).toContain("503")
  })

  test("an answer that names no release", async () => {
    served.body = { message: "Not Found" }
    const r = await fabulaLatestRelease()
    expect(r.release).toBeNull()
    expect(r.reason).toContain("named no release")
  })

  test("an answer with a tag but no page", async () => {
    served.body = { tag_name: "v0.221.0" }
    expect((await fabulaLatestRelease()).release).toBeNull()
  })

  test("nothing listening at all — it must not throw", async () => {
    server?.stop(true)
    server = undefined
    const r = await fabulaLatestRelease()
    expect(r.release).toBeNull()
    expect(r.reason).toBeDefined()
  })
})
