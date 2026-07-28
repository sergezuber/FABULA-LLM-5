// The worker's delivery contract, END TO END (owner's rule, 2026-07-28): the chat receives the finished
// report or nothing. Runs the REAL worker script against a fake engine and a fake model — the wiring
// suite stands the worker in with a marker script, so nothing else executes this path, and a scope bug
// in it (post captured inside streamAnswer) survived every other suite green.
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const SUMMARY_MARKER = "SUMMARY_MARKER_7f3"

let engine: any, model: any
let enginePort = 0, modelPort = 0
let assistantPosts: any[] = []
let userPosts: any[] = []
let synthMode: "fail" | "ok" = "fail"

beforeAll(() => {
  engine = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url)
      if (req.method === "POST" && u.pathname.includes("/assistant-message")) {
        const b = await req.json()
        assistantPosts.push(b)
        return Response.json({ messageID: "m1", partID: "p1" })
      }
      if (req.method === "POST" && u.pathname.endsWith("/message")) {
        userPosts.push(await req.json())
        return Response.json({ ok: true })
      }
      return Response.json({ ok: true })
    },
  })
  enginePort = engine.port
  model = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url)
      if (u.pathname.endsWith("/models")) return Response.json({ data: [{ id: "fake-model" }] })
      const b: any = await req.json()
      const prompt = String(b?.messages?.[0]?.content ?? "")
      const isSynthesis = prompt.includes(SUMMARY_MARKER) // synthesis reads the map output; map reads chapters
      if (b?.stream) {
        // the streaming reduce path: emit nothing useful, finish clean — an empty stream
        const sse = 'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        return new Response(sse, { headers: { "content-type": "text/event-stream" } })
      }
      const content = isSynthesis ? (synthMode === "ok" ? "ГОТОВЫЙ РАЗВЁРНУТЫЙ РАЗБОР КНИГИ" : "") : `${SUMMARY_MARKER} резюме батча`
      return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    },
  })
  modelPort = model.port
})
afterAll(() => { engine?.stop(true); model?.stop(true) })

async function runWorker(tag: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "corpus-live-"))
  const xdg = mkdtempSync(join(tmpdir(), "corpus-xdg-"))
  for (let i = 1; i <= 6; i++) writeFileSync(join(dir, `глава_${i}.md`), `Глава ${i}. ` + "текст ".repeat(400))
  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "..", "lib", "corpus-worker.ts"), dir, `ses_${tag}`, Buffer.from("о чем книга? прочти полностью").toString("base64"), `http://127.0.0.1:${enginePort}`],
    {
      env: {
        ...process.env,
        XDG_DATA_HOME: xdg,
        FABULA_CORPUS_URL: `http://127.0.0.1:${modelPort}/v1`,
        FABULA_CORPUS_TIMEOUT_MS: "30000",
        FABULA_CONTEXT_WINDOW: "131072",
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  await proc.exited
  rmSync(dir, { recursive: true, force: true }); rmSync(xdg, { recursive: true, force: true })
}

describe("corpus worker delivers the finished answer or nothing", () => {
  test("synthesis fails at every layer → NOTHING raw reaches the chat, the task is handed back", async () => {
    assistantPosts = []; userPosts = []; synthMode = "fail"
    await runWorker("fail1")
    for (const p of assistantPosts) {
      const t = String(p.text ?? "")
      expect(t.includes(SUMMARY_MARKER)).toBe(false) // no raw batch summaries
      expect(t.includes("\n\n---\n\n")).toBe(false)  // no joined dump
      expect(t.includes("could not be completed")).toBe(false) // no service strings
    }
    // the task went back to the ordinary agent — the reader still gets an answer, just not from us
    expect(userPosts.length).toBe(1)
    expect(String(userPosts[0]?.parts?.[0]?.text ?? "")).toContain("о чем книга")
  }, 60000)

  test("synthesis succeeds → exactly the finished report, once", async () => {
    assistantPosts = []; userPosts = []; synthMode = "ok"
    await runWorker("ok1")
    const finals = assistantPosts.filter((p) => String(p.text ?? "").includes("ГОТОВЫЙ РАЗВЁРНУТЫЙ РАЗБОР"))
    expect(finals.length).toBe(1)
    for (const p of assistantPosts) expect(String(p.text ?? "").includes(SUMMARY_MARKER)).toBe(false)
    expect(userPosts.length).toBe(0) // nothing handed back; the answer was delivered
  }, 60000)
})
