// Drives the REAL fabula-reliability session.post hook in the engine's calling shape. The decision core
// is unit-tested separately; this asserts the part that unit tests cannot see — that the hook is
// registered, reads the guard's own turn state, and actually DELIVERS the answer over HTTP. Chasing it
// through a live app failed twice: the hook fires only at turn END, and the turns under test kept
// running, so nothing could be observed. A cancelled hunt is not evidence either way.

import { test, expect, beforeAll, afterAll } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

beforeAll(() => {
  const stateFile = join(tmpdir(), `reliability-state-${process.pid}.json`)
  writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["reliability"] }))
  process.env.FABULA_PLUGIN_STATE = stateFile
})

import { FabulaReliability } from "../fabula-reliability"

// Stands in for the engine: records what the plugin posts, and to where.
function catcher() {
  const seen: { path: string; body: any }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push({ path: new URL(req.url).pathname, body: await req.json().catch(() => null) })
      return new Response(JSON.stringify({ messageID: "msg_x", partID: "prt_x" }), {
        headers: { "content-type": "application/json" },
      })
    },
  })
  return { seen, server, url: `http://127.0.0.1:${server.port}` }
}

async function hooks(serverUrl: string) {
  return (await (FabulaReliability as any)({ serverUrl, directory: "/tmp/exhaustion-test" })) as any
}

/** Make the guard record real search attempts, the way a turn does: the BEFORE hook is where queries are
 *  registered and where a stop is issued — driving only the after-hook recorded nothing at all, which is
 *  how this test caught the `blocked` signal being derived from tallies that web search never touches. */
async function drive(h: any, sessionID: string, queries: string[]) {
  for (const q of queries) {
    const out: any = {}
    try {
      await h["tool.execute.before"]({ sessionID, tool: "web_search", args: { query: q } }, out)
    } catch {
      // A blocked call throws by design; the turn continues and so does this loop.
    }
    const after: any = { output: "no results" }
    await h["tool.execute.after"]({ sessionID, tool: "web_search", args: { query: q } }, after)
  }
}

test("the hook is registered on session.post", async () => {
  const c = catcher()
  try {
    expect(typeof (await hooks(c.url))["session.post"]).toBe("function")
  } finally {
    c.server.stop(true)
  }
})

test("searched many ways, said nothing → an honest answer is DELIVERED", async () => {
  const c = catcher()
  try {
    const h = await hooks(c.url)
    const sid = "ses_exhausted"
    await drive(h, sid, [
      "osho woodcutter parable exact text",
      "притча дровосек три ступени",
      "osho three stages mind power story",
      "дровосек рубить дрова притча ошо",
      "woodcutter parable full text english",
      "osho woodcutter parable exact text", // a near-duplicate: this is what the guard stops
    ])
    await h["session.post"]({ sessionID: sid, outcome: "completed", finalText: "", trajectory: [] })
    const posted = c.seen.filter((s) => s.path.includes("/assistant-message"))
    expect(posted.length).toBe(1) // the reader gets exactly one answer, not one per attempt
    expect(posted[0].body.text).toContain("could not find")
    expect(posted[0].body.text).toContain("osho woodcutter parable exact text") // names what was tried
  } finally {
    c.server.stop(true)
  }
})

test("the model DID answer → the harness stays quiet", async () => {
  const c = catcher()
  try {
    const h = await hooks(c.url)
    const sid = "ses_answered"
    await drive(h, sid, ["a", "b", "c", "d"])
    await h["session.post"]({
      sessionID: sid,
      outcome: "completed",
      finalText: "Here is the parable, quoted from the book, with the source named.",
    })
    expect(c.seen.filter((s) => s.path.includes("/assistant-message")).length).toBe(0)
  } finally {
    c.server.stop(true)
  }
})

test("a turn the user cancelled is never spoken over", async () => {
  const c = catcher()
  try {
    const h = await hooks(c.url)
    const sid = "ses_cancelled"
    await drive(h, sid, ["a", "b", "c", "d"])
    await h["session.post"]({ sessionID: sid, outcome: "cancelled", finalText: "" })
    expect(c.seen.length).toBe(0)
  } finally {
    c.server.stop(true)
  }
})

test("an unreachable engine never breaks the turn", async () => {
  // Nothing listening on this port: the delivery must fail silently.
  const h = await hooks("http://127.0.0.1:1")
  const sid = "ses_no_server"
  await drive(h, sid, ["a", "b", "c", "d"])
  await expect(
    h["session.post"]({ sessionID: sid, outcome: "completed", finalText: "" }),
  ).resolves.toBeUndefined()
})

test("malformed input never throws", async () => {
  const c = catcher()
  try {
    const h = await hooks(c.url)
    await expect(h["session.post"](null)).resolves.toBeUndefined()
    await expect(h["session.post"]({})).resolves.toBeUndefined()
  } finally {
    c.server.stop(true)
  }
})
