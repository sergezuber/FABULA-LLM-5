// No-progress detection must not depend on a tool's NAME.
//
// Measured failure this pins (live session, 2026-07-21): one checkpoint-writer issued the byte-identical
// call `task {"action":"list"}` 456 times in a single session — 476 turns — and was never stopped. It
// consumed 62.6M input tokens against the main agent's 2.1M, i.e. ~97% of the machine, so a task that
// should read chapters got ~3% of the model and produced 7 chapters in two hours.
//
// It was never stopped because the guard classified by TOOL NAME: `task` sits in MUTATING_TOOLS, and a
// mutating tool is exempt from no-progress detection entirely. But `task` is a MULTIPLEXER — `list` reads,
// `done` mutates — so its read operations inherited the write exemption. The same hole applies to every
// multiplexer (`actor`, `todo`, any MCP tool of that shape) and, worse, the allow-list meant any tool NOT
// named in it — every future or MCP tool — had no protection at all.
//
// The literature is explicit that counting repeats is the wrong signal ("frequent edge traversals alone
// are not reliable indicators of cycles", arXiv:2511.10650) and that the criterion is PROGRESS: a bad
// cycle is one that yields "no additional insights or progress". The guard already had the right oracle —
// a byte-identical result for byte-identical arguments proves zero new information. What it lacked was
// letting that proof apply to every tool. This file pins that: detection by evidence, not by name.
import { test, expect, describe } from "bun:test"
import { LoopGuard, isIdempotent } from "./loopguard"

const SID = "ses_loop_mux"
// the exact call from the wedged session
const TASK_LIST = { action: "list" }
const SAME_RESULT = "T1  open  Литературный анализ всех глав\nT2  open  Прочитать главы"

describe("no-progress detection is by evidence, not by tool name", () => {
  test("the multiplexer read that ran 456 times is now detected", () => {
    const g = new LoopGuard()
    g.resetTurn(SID)
    let blocked = false
    // Far fewer repeats than the 456 observed live; the point is that it stops at all.
    for (let i = 0; i < 12; i++) {
      if (g.peekBlock(SID, "task", TASK_LIST)) {
        blocked = true
        break
      }
      g.observe(SID, "task", TASK_LIST, SAME_RESULT)
    }
    expect(blocked).toBe(true)
  })

  test("a multiplexer NOT known to this codebase is covered — the ARGUMENT decides, not a list of names", () => {
    // The property that makes this general: no entry for this tool exists anywhere, yet its read
    // operation is detected, so an MCP tool added tomorrow is covered without touching this file.
    const g = new LoopGuard()
    g.resetTurn(SID)
    let blocked = false
    for (let i = 0; i < 12; i++) {
      if (g.peekBlock(SID, "some_future_mcp_tool", { operation: "list" })) {
        blocked = true
        break
      }
      g.observe(SID, "some_future_mcp_tool", { operation: "list" }, "identical output")
    }
    expect(blocked).toBe(true)
  })

  test("an MCP tool's operation is read off its NAME — the real unclassified population", () => {
    // Measuring this project's own store shows MCP tools are essentially the entire set that neither
    // list knows about, i.e. the tools that had no cover at all. Their name spells the operation out.
    const g = new LoopGuard()
    g.resetTurn(SID)
    let blocked = false
    for (let i = 0; i < 12; i++) {
      if (g.peekBlock(SID, "mcp__github__list_issues", { repo: "x" })) { blocked = true; break }
      g.observe(SID, "mcp__github__list_issues", { repo: "x" }, "no issues")
    }
    expect(blocked).toBe(true)
  })

  test("CONTROL: an MCP tool whose name is NOT a read verb keeps the old behaviour", () => {
    // No classification is invented for opaque tools: an unfamiliar verb must never be blocked, or a
    // legitimate integration that answers identically (\"ok\") on repeated writes would be broken.
    const g = new LoopGuard()
    g.resetTurn(SID)
    for (let i = 0; i < 12; i++) {
      expect(g.peekBlock(SID, "mcp__tickets__create_ticket", { t: "x" })).toBeNull()
      g.observe(SID, "mcp__tickets__create_ticket", { t: "x" }, "ok")
    }
  })

  test("KNOWN LIMIT, asserted rather than implied: a NON-MCP opaque tool is still unprotected", () => {
    // Still not guessed at: a bare unknown name carries no operation to read, and blocking it would
    // need evidence about what that costs. Pinned so the gap stays visible.
    const g = new LoopGuard()
    g.resetTurn(SID)
    for (let i = 0; i < 12; i++) {
      expect(g.peekBlock(SID, "opaque_unknown_tool", { q: "x" })).toBeNull()
      g.observe(SID, "opaque_unknown_tool", { q: "x" }, "identical output")
    }
  })

  test("CONTROL: a tool that makes PROGRESS is never blocked, however many times it runs", () => {
    // The whole safety argument: a differing result is evidence of progress, so the guard stays silent.
    const g = new LoopGuard()
    g.resetTurn(SID)
    for (let i = 0; i < 100; i++) {
      expect(g.peekBlock(SID, "task", TASK_LIST)).toBeNull()
      g.observe(SID, "task", TASK_LIST, `result number ${i}`) // different every time
    }
  })

  test("CONTROL: differing ARGUMENTS are a different call and never accumulate", () => {
    const g = new LoopGuard()
    g.resetTurn(SID)
    for (let i = 0; i < 100; i++) {
      expect(g.peekBlock(SID, "read", { file_path: `/ch/${i}.md` })).toBeNull()
      g.observe(SID, "read", { file_path: `/ch/${i}.md` }, "same boilerplate header")
    }
  })

  test("CONTROL: a waiting tool may repeat identically — that IS its function", () => {
    // The one principled exemption. A poll/sleep whose result is unchanged is doing exactly what it is
    // for; blocking it would break every legitimate wait loop.
    const g = new LoopGuard()
    g.resetTurn(SID)
    for (let i = 0; i < 30; i++) {
      expect(g.peekBlock(SID, "sleep", { seconds: 5 })).toBeNull()
      g.observe(SID, "sleep", { seconds: 5 }, "slept 5s")
    }
  })

  test("the ARGUMENT overrides the name for a multiplexer, and only for its read operations", () => {
    expect(isIdempotent("task", { action: "list" })).toBe(true) // read → detected
    expect(isIdempotent("task", { action: "done", id: "T1" })).toBe(false) // write → exempt, as before
    expect(isIdempotent("task")).toBe(false) // no argument → previous name-based answer, unchanged
    // a mutating tool whose constant reply hides real progress must STAY exempt
    expect(isIdempotent("note_append", { path: "/n.md", text: "x" })).toBe(false)
    expect(isIdempotent("sleep", { seconds: 5 })).toBe(false) // waiting is never no-progress
  })

  test("an unrecognised operation verb fails SAFE — no wrong block, just no extra cover", () => {
    // The vocabulary is open on purpose. A verb it does not know must degrade to the old behaviour
    // rather than mislabel a write as a read, which is the failure mode that would actually hurt.
    expect(isIdempotent("task", { action: "frobnicate" })).toBe(false)
  })

  test("a fresh turn starts clean — the guard never leaks across turns", () => {
    const g = new LoopGuard()
    g.resetTurn(SID)
    for (let i = 0; i < 12; i++) g.observe(SID, "task", TASK_LIST, SAME_RESULT)
    expect(g.peekBlock(SID, "task", TASK_LIST)).not.toBeNull()
    g.resetTurn(SID)
    expect(g.peekBlock(SID, "task", TASK_LIST)).toBeNull()
  })
})

// The cure, not just the safety net. The loop had fuel: the model's flat `{action:"list"}` had `action`
// stripped as an unknown key before the tool ever saw it, so the call arrived as `{}` and answered
// "Invalid input: expected object, received string → at operation". No retry could ever succeed, which is
// why one writer repeated it 456 times. Wrapping restores a valid call; canonical signatures make the two
// shapes one call so the guard can even see the repeat.
import { repairArgs } from "./argrepair"
import { toolSignature } from "./signature"

describe("the flat operation payload is repaired, not destroyed", () => {
  test("a flat payload carrying the discriminator is WRAPPED into the schema's shape", () => {
    expect(repairArgs("task", { action: "list" }).args).toEqual({ operation: { action: "list" } })
    expect(repairArgs("task", { action: "done", id: "T1" }).args).toEqual({ operation: { action: "done", id: "T1" } })
    expect(repairArgs("actor", { action: "run", prompt: "x" }).args).toEqual({ operation: { action: "run", prompt: "x" } })
  })

  test("an already-correct payload is left alone (the repair is idempotent)", () => {
    expect(repairArgs("task", { operation: { action: "list" } }).args).toEqual({ operation: { action: "list" } })
  })

  test("CONTROL: junk without the discriminator is still stripped exactly as before", () => {
    // Wrapping anything at all would turn a strip into a guess; only a payload naming `action` is
    // provably an un-nested operation, because the tool's argument type discriminates on it.
    const r = repairArgs("actor", { foo: 1, bar: 2 })
    expect(r.args).toEqual({})
    expect(r.stripped).toEqual(["foo", "bar"])
  })

  test("both shapes of one call share one signature", () => {
    // Without this the pre-execution check files the call under one key and the post-execution recorder
    // under another, so every repeat looks new and nothing ever accumulates.
    expect(toolSignature("task", { action: "list" })).toBe(toolSignature("task", { operation: { action: "list" } }))
  })

  test("CONTROL: genuinely different calls keep different signatures", () => {
    expect(toolSignature("task", { action: "list" })).not.toBe(toolSignature("task", { action: "done", id: "T1" }))
    expect(toolSignature("task", { operation: { action: "list" } })).not.toBe(
      toolSignature("task", { operation: { action: "done", id: "T1" } }),
    )
  })
})
