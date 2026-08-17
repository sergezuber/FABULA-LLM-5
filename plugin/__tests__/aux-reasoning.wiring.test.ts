// WIRING pin for the aux no-reasoning declaration. Hermetic: a stub fetch stands in for the model,
// a real temp git repo stands in for the diff, no network and no model are touched.
//
// WHY THE WIRING AND NOT THE HELPER. The defect this exists to prevent is not a wrong header value —
// it is a header nobody sends. `proxy/reasoning-map.json` has had an `off` level the whole time and
// MEASURED 2026-08-16 across 993 logged requests, not ONE carried a client-set reasoning level
// (`request_enable_thinking_override` false in every record): the table was right and no caller read
// from it. A test of `reasoningHeaders()` alone would have passed against exactly that. So these
// cases drive the REAL `change_quiz` tool and read what actually left the process.

import { test, expect, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { callAux } from "../lib/auxLLM"
import { REASONING_HEADER, metaReasoningLevel, reasoningHeaders } from "../lib/reasoning"
import { FabulaChangeQuiz } from "../fabula-change-quiz"

/** A git repo with one uncommitted edit — what `change_quiz` needs to have anything to ask about. */
function repoWithChange(): string {
  const dir = mkdtempSync(join(tmpdir(), "fab-auxreason-"))
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, stdio: "ignore" })
  git("init", "-q")
  writeFileSync(join(dir, "a.ts"), "export const n = 1\n")
  git("add", "-A")
  git("commit", "-qm", "base")
  writeFileSync(join(dir, "a.ts"), "export const n = 2\n")
  return dir
}

/** Records every outbound request and answers like an OpenAI-compatible server. */
function captureFetch() {
  const seen: { url: string; headers: Record<string, string>; body: any }[] = []
  const impl = async (url: any, init: any = {}) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init.headers || {})) headers[String(k).toLowerCase()] = String(v)
    const u = String(url)
    seen.push({ url: u, headers, body: init.body ? JSON.parse(init.body) : undefined })
    const payload = u.endsWith("/models")
      ? { data: [{ id: "test-model" }] }
      : { choices: [{ message: { content: "VERDICT: PASS\nreason: ok" } }] }
    return { ok: true, json: async () => payload } as any
  }
  return { seen, impl }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }) } catch {}
  delete process.env.FABULA_AUX_NO_REASONING
  delete process.env.LMSTUDIO_URL
})

test("reasoningHeaders: a declared level becomes the adapter's header; nothing declared sends nothing", () => {
  expect(reasoningHeaders("off")).toEqual({ [REASONING_HEADER]: "off" })
  expect(reasoningHeaders(undefined)).toEqual({})
  expect(reasoningHeaders("   ")).toEqual({})
})

test("metaReasoningLevel: off by default, restored by the kill-switch, read at CALL time", () => {
  expect(metaReasoningLevel({} as any)).toBe("off")
  expect(metaReasoningLevel({ FABULA_AUX_NO_REASONING: "0" } as any)).toBeUndefined()
  // any other value is not the switch — a typo must not silently disable the mechanism
  expect(metaReasoningLevel({ FABULA_AUX_NO_REASONING: "false" } as any)).toBe("off")
})

test("callAux puts the declared level ON THE WIRE, and omits the header when none is declared", async () => {
  process.env.LMSTUDIO_URL = "http://127.0.0.1:1/v1"
  const a = captureFetch()
  await callAux("hi", { fetchImpl: a.impl as any, reasoning: "off" })
  const posted = a.seen.filter((r) => !r.url.endsWith("/models"))
  expect(posted.length).toBe(1)
  expect(posted[0].headers[REASONING_HEADER.toLowerCase()]).toBe("off")

  const b = captureFetch()
  await callAux("hi", { fetchImpl: b.impl as any })
  const posted2 = b.seen.filter((r) => !r.url.endsWith("/models"))
  expect(posted2[0].headers[REASONING_HEADER.toLowerCase()]).toBeUndefined()
})

test("change_quiz declares it on BOTH aux calls — the two the measurement is about", async () => {
  const dir = repoWithChange(); dirs.push(dir)
  process.env.LMSTUDIO_URL = "http://127.0.0.1:1/v1"
  const cap = captureFetch()
  const realFetch = globalThis.fetch
  globalThis.fetch = cap.impl as any
  try {
    const p = (await FabulaChangeQuiz({} as any)) as any
    const t = p.tool.change_quiz
    await t.execute({}, { directory: dir, sessionID: "s1" })                 // author the questions
    await t.execute({ answers: "a. b. c." }, { directory: dir, sessionID: "s1" }) // grade them
  } finally { globalThis.fetch = realFetch }
  const posted = cap.seen.filter((r) => !r.url.endsWith("/models"))
  expect(posted.length).toBe(2)
  for (const r of posted) expect(r.headers[REASONING_HEADER.toLowerCase()]).toBe("off")
  // and the two calls really are the quiz author and the grader, not two of the same
  expect(posted[0].body.messages[0].content).toContain("COMPREHENSION QUIZ")
  expect(posted[1].body.messages[0].content).toContain("grading")
})

test("FABULA_AUX_NO_REASONING=0 restores the pre-change wire byte-for-byte", async () => {
  const dir = repoWithChange(); dirs.push(dir)
  process.env.LMSTUDIO_URL = "http://127.0.0.1:1/v1"
  process.env.FABULA_AUX_NO_REASONING = "0"
  const cap = captureFetch()
  const realFetch = globalThis.fetch
  globalThis.fetch = cap.impl as any
  try {
    const p = (await FabulaChangeQuiz({} as any)) as any
    await p.tool.change_quiz.execute({}, { directory: dir, sessionID: "s2" })
  } finally { globalThis.fetch = realFetch }
  const posted = cap.seen.filter((r) => !r.url.endsWith("/models"))
  expect(posted.length).toBe(1)
  expect(posted[0].headers[REASONING_HEADER.toLowerCase()]).toBeUndefined()
})
