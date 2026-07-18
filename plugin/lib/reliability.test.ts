// Tests for the pure controllers (bun test). Exercises the actual logic.
import { test, expect } from "bun:test"
import { LoopGuard, classifyFailure, isIdempotent, noProgressGuidance, FILE_READ_TOOLS,
  isDegeneratePattern, isEmptyPattern } from "./loopguard"
import { canonicalArgs, toolSignature } from "./signature"
import { repairArgs, sanitizeString, normalizeActorArgs } from "./argrepair"
import { stripSpecialTokens, sanitizeAssistantTokens } from "./sanitize-tokens"

// ───────────────────────── signature ─────────────────────────
test("canonicalArgs: key order is stable", () => {
  expect(canonicalArgs({ b: 2, a: 1 })).toBe(canonicalArgs({ a: 1, b: 2 }))
})
test("canonicalArgs: nested objects sorted", () => {
  expect(canonicalArgs({ x: { d: 4, c: 3 } })).toBe(canonicalArgs({ x: { c: 3, d: 4 } }))
})
test("canonicalArgs: arrays keep order", () => {
  expect(canonicalArgs({ a: [1, 2] })).not.toBe(canonicalArgs({ a: [2, 1] }))
})
test("toolSignature differs by tool and by args", () => {
  expect(toolSignature("view", { p: "/a" })).not.toBe(toolSignature("view", { p: "/b" }))
  expect(toolSignature("view", { p: "/a" })).not.toBe(toolSignature("grep", { p: "/a" }))
})

// ───────────────────────── classification ─────────────────────────
test("classifyFailure: detects error markers + exit codes", () => {
  expect(classifyFailure("bash", "Error: boom")).toBe(true)
  expect(classifyFailure("bash", '{"error":"x"}')).toBe(true)
  expect(classifyFailure("bash", "all good")).toBe(false)
  expect(classifyFailure("bash", "ok", { exit: 1 })).toBe(true)
  expect(classifyFailure("bash", "ok", { exit: 0 })).toBe(false)
})
test("idempotent vs mutating classification", () => {
  expect(isIdempotent("view")).toBe(true)
  expect(isIdempotent("read")).toBe(true)
  expect(isIdempotent("bash_tool")).toBe(false)
  expect(isIdempotent("actor")).toBe(false)
})

// ───────────────────────── 1.1 loop guard ─────────────────────────
test("no-progress: idempotent same result → warn@2, stop@5", () => {
  const g = new LoopGuard()
  const S = "s1"
  const call = () => g.observe(S, "view", { path: "/a" }, "SAME").action
  expect(call()).toBe("allow") // 1
  expect(call()).toBe("warn")  // 2
  expect(call()).toBe("warn")  // 3
  expect(call()).toBe("warn")  // 4
  expect(call()).toBe("stop")  // 5
})
test("no-progress NOT tracked for mutating tools", () => {
  const g = new LoopGuard()
  for (let i = 0; i < 6; i++) {
    expect(g.observe("s", "create_file", { path: "/a" }, "ok").action).toBe("allow")
  }
})
test("no-progress resets when result changes", () => {
  const g = new LoopGuard()
  expect(g.observe("s", "view", { p: "/a" }, "A").action).toBe("allow") // 1
  expect(g.observe("s", "view", { p: "/a" }, "A").action).toBe("warn")  // 2
  expect(g.observe("s", "view", { p: "/a" }, "B").action).toBe("allow") // changed → reset
})
test("exact failure: same tool+args → warn@2, stop@5", () => {
  const g = new LoopGuard()
  const call = () => g.observe("s", "web_fetch", { url: "x" }, "Error: dns", undefined, true).action
  expect(call()).toBe("allow") // 1
  expect(call()).toBe("warn")  // 2
  expect(call()).toBe("warn")  // 3
  expect(call()).toBe("warn")  // 4
  expect(call()).toBe("stop")  // 5 (exact stop fires before same-tool path)
})
test("same-tool failure (varying args) → warn@3, stop@8", () => {
  const g = new LoopGuard()
  const actions: string[] = []
  for (let i = 0; i < 8; i++) {
    actions.push(g.observe("s", "bash", { cmd: "c" + i }, "Error", undefined, true).action)
  }
  // distinct args each time → exact count stays 1, so this exercises the same-tool path
  expect(actions[2]).toBe("warn") // 3rd same-tool failure
  expect(actions[7]).toBe("stop") // 8th
})
test("success clears failure counters", () => {
  const g = new LoopGuard()
  g.observe("s", "web_fetch", { url: "x" }, "Error", undefined, true) // 1 fail
  g.observe("s", "web_fetch", { url: "x" }, "Error", undefined, true) // 2 fail → would warn
  g.observe("s", "web_fetch", { url: "x" }, "OK", undefined, false)   // success resets
  expect(g.observe("s", "web_fetch", { url: "x" }, "Error", undefined, true).action).toBe("allow") // back to 1
})
test("sessions are isolated + resetTurn clears", () => {
  const g = new LoopGuard()
  g.observe("A", "view", { p: "/x" }, "R")
  g.observe("A", "view", { p: "/x" }, "R")
  expect(g.observe("B", "view", { p: "/x" }, "R").action).toBe("allow") // B independent
  g.resetTurn("A")
  expect(g.observe("A", "view", { p: "/x" }, "R").action).toBe("allow") // A cleared
})

// ───────────────────── 1.1b hard loop-break (peekBlock → throw) ─────────────────────
test("peekBlock: no block before threshold, blocks the NEXT identical no-progress read", () => {
  const g = new LoopGuard()
  const S = "s", args = { path: "/a", offset: 1650 }
  expect(g.peekBlock(S, "view", args)).toBeNull()            // nothing observed yet
  for (let i = 0; i < 5; i++) g.observe(S, "view", args, "SAME") // 5 identical no-progress reads
  const b = g.peekBlock(S, "view", args)                     // the 6th call would be aborted
  expect(b?.action).toBe("stop")
  expect(b?.code).toBe("idempotent_no_progress_block")
  expect(b?.guidance).toMatch(/LOOP BLOCKED/)
})
test("peekBlock: only the looping signature is blocked, not other args/tools", () => {
  const g = new LoopGuard()
  const S = "s"
  for (let i = 0; i < 5; i++) g.observe(S, "view", { path: "/a", offset: 1650 }, "SAME")
  expect(g.peekBlock(S, "view", { path: "/a", offset: 1650 })?.action).toBe("stop")
  expect(g.peekBlock(S, "view", { path: "/a", offset: 9999 })).toBeNull() // different args
  expect(g.peekBlock(S, "grep", { path: "/a", offset: 1650 })).toBeNull() // different tool
})
test("peekBlock: identical repeated FAILURE is hard-blocked", () => {
  const g = new LoopGuard()
  const S = "s", a = { url: "x" }
  for (let i = 0; i < 5; i++) g.observe(S, "web_fetch", a, "Error: dns", undefined, true)
  const b = g.peekBlock(S, "web_fetch", a)
  expect(b?.action).toBe("stop")
  expect(b?.code).toBe("exact_failure_block")
})
// ───────────────── read-aware no-progress guidance (EOF stuck loops) ─────────────────
test("noProgressGuidance: file-read tools get EOF / read-a-different-file wording", () => {
  for (const t of ["view", "read", "cat"]) {
    const g = noProgressGuidance(t, 5)
    expect(g).toMatch(/END of this file|DIFFERENT file/)
    expect(FILE_READ_TOOLS.has(t)).toBe(true)
  }
})
test("noProgressGuidance: non-read tools get the generic wording", () => {
  const g = noProgressGuidance("web_search", 5)
  expect(g).toMatch(/same result/)
  expect(g).not.toMatch(/END of this file/)
  expect(FILE_READ_TOOLS.has("web_search")).toBe(false)
})
test("no-progress STOP on a read carries the EOF guidance", () => {
  const g = new LoopGuard()
  let d: any
  for (let i = 0; i < 5; i++) d = g.observe("s", "read", { filePath: "/b.md", offset: 1650 }, "tail line")
  expect(d.action).toBe("stop")
  expect(d.guidance).toMatch(/END of this file|DIFFERENT file/)
})
test("no-progress survives interleaving (ABAB read↔grep loop is still caught)", () => {
  // per-signature counter: an interleaved different call does NOT reset the read's no-progress count,
  // so a read→grep→read→grep… loop where the read keeps returning the same tail still escalates.
  const g = new LoopGuard(); const S = "s"; let k = 0
  const read = () => g.observe(S, "read", { filePath: "/a.md", offset: 1650 }, "SAME TAIL").action
  const grep = () => g.observe(S, "grep", { pattern: "x" }, "matches " + (k++)).action // distinct each time
  expect(read()).toBe("allow")            // read #1
  grep(); expect(read()).toBe("warn")     // read #2 (count survived the interleaved grep)
  grep(); expect(read()).toBe("warn")     // read #3
  grep(); expect(read()).toBe("warn")     // read #4
  grep(); expect(read()).toBe("stop")     // read #5 → stop, despite never being consecutive
})
test("note_append is treated as MUTATING (never no-progress flagged)", () => {
  const g = new LoopGuard()
  for (let i = 0; i < 6; i++) {
    expect(g.observe("s", "note_append", { path: "/n.md", text: "x" }, "Appended").action).toBe("allow")
  }
  expect(isIdempotent("note_append")).toBe(false)
})

test("peekBlock: unknown session / fresh turn does not block", () => {
  const g = new LoopGuard()
  expect(g.peekBlock("never-seen", "view", { p: "/a" })).toBeNull()
  expect(g.peekBlock(undefined, "view", { p: "/a" })).toBeNull()
  const S = "s"
  for (let i = 0; i < 5; i++) g.observe(S, "view", { p: "/a" }, "SAME")
  g.resetTurn(S)
  expect(g.peekBlock(S, "view", { p: "/a" })).toBeNull() // cleared on new turn
})
test("apply() appends guidance for non-allow only", () => {
  const g = new LoopGuard()
  g.observe("s", "view", { p: "/a" }, "X")
  const d = g.observe("s", "view", { p: "/a" }, "X") // warn
  const out = LoopGuard.apply("BODY", d)
  expect(out).toContain("BODY")
  expect(out).toContain("Tool loop warning")
  // allow decision → unchanged
  const allowD = { action: "allow", code: "allow", guidance: "", count: 0 } as const
  expect(LoopGuard.apply("BODY", allowD)).toBe("BODY")
})
test("LRU eviction respects maxSessions", () => {
  const g = new LoopGuard({ maxSessions: 3 })
  for (let i = 0; i < 10; i++) g.observe("s" + i, "view", { p: "/a" }, "R")
  // no throw, memory bounded — a brand-new session starts fresh (allow on first observe)
  expect(g.observe("brand-new", "view", { p: "/a" }, "R").action).toBe("allow")
})

// ───────────────────────── 1.2 arg repair ─────────────────────────
test("repairArgs strips a stray top-level key from actor, keeps operation", () => {
  // The real actor schema is operation-nested; only `operation` is a valid TOP-LEVEL key.
  const r = repairArgs("actor", { operation: { action: "run", subagent_type: "general", description: "d", prompt: "p" }, timeout_ms: 5000 })
  expect(r.stripped).toEqual(["timeout_ms"])
  expect(Object.keys(r.args)).toEqual(["operation"])
  expect(r.args.operation.action).toBe("run")
  expect(r.changed).toBe(true)
})
test("repairArgs passes through non-strict tools unchanged", () => {
  const r = repairArgs("view", { path: "/a", offset: 0, anything: true })
  expect(r.stripped).toEqual([])
  expect(r.args).toEqual({ path: "/a", offset: 0, anything: true })
})
test("repairArgs valid (operation-nested) actor call → no change", () => {
  const r = repairArgs("actor", { operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p" } })
  expect(r.changed).toBe(false)
  expect(r.stripped).toEqual([])
})
test("sanitizeString removes lone surrogates", () => {
  const bad = "hi\uD800there"           // lone high surrogate
  expect(sanitizeString(bad)).toBe("hi�there")
  const ok = "pair😀ok"        // 😀 valid pair preserved
  expect(sanitizeString(ok)).toBe(ok)
})
test("repairArgs sanitizes nested string values", () => {
  const r = repairArgs("view", { path: "/a", note: "x\uDC00y" })
  expect(r.args.note).toBe("x�y")
  expect(r.changed).toBe(true)
})

// ───────────────────────── corner cases ─────────────────────────
test("corner: empty/missing args do not crash", () => {
  const g = new LoopGuard()
  expect(g.observe("s", "view", {}, "").action).toBe("allow")
  expect(g.observe("s", "view", undefined, null).action).toBe("allow")
  expect(repairArgs("actor", undefined).args).toBe(undefined)
  expect(repairArgs("actor", null).changed).toBe(false)
})
test("corner: huge args are bounded in signature", () => {
  const big = { blob: "z".repeat(50_000) }
  expect(toolSignature("view", big).length).toBeLessThanOrEqual(2100)
})

// ───────────────── normalizeActorArgs (rescue a wrong-shape actor/task call) ─────────────────
test("normalizeActorArgs: correct nested call passes through untouched", () => {
  const ok = { operation: { action: "run", subagent_type: "general", description: "d", prompt: "p" } }
  expect(normalizeActorArgs(ok)).toEqual(ok)
})
test("normalizeActorArgs: flat fields → wrapped in { operation }", () => {
  const r = normalizeActorArgs({ action: "spawn", subagent_type: "explore", description: "d", prompt: "p" })
  expect(r.operation).toEqual({ action: "spawn", subagent_type: "explore", description: "d", prompt: "p" })
})
test("normalizeActorArgs: minimal flat (just prompt) → sane defaults", () => {
  const r = normalizeActorArgs({ prompt: "find bugs" })
  expect(r.operation).toMatchObject({ action: "run", subagent_type: "general", prompt: "find bugs" })
})
test("normalizeActorArgs: operation sent as a JSON string → parsed + defaults filled", () => {
  const r = normalizeActorArgs({ operation: '{"action":"run","prompt":"p"}' })
  expect(r.operation).toMatchObject({ action: "run", prompt: "p", subagent_type: "general" })
})
test("normalizeActorArgs: nested-but-incomplete operation gets inner defaults", () => {
  const r = normalizeActorArgs({ operation: { prompt: "audit the repo" } })
  expect(r.operation).toMatchObject({ action: "run", subagent_type: "general", description: "subtask", prompt: "audit the repo" })
})
test("normalizeActorArgs: missing subagent_type → general; non-empty type TRUSTED (dynamic enum); empty/null → VALID run op", () => {
  // subagent_type is a dynamic registry enum (explore/general/plan/build/compose). A non-empty value the model
  // chose is TRUSTED (not clobbered to general — that would break a valid `plan`/`build` delegation). Only a
  // missing/blank value defaults to general.
  expect(normalizeActorArgs({ prompt: "x" }).operation.subagent_type).toBe("general")             // missing → default
  expect(normalizeActorArgs({ prompt: "x", subagent_type: "plan" }).operation.subagent_type).toBe("plan") // trusted
  // empty/null are no longer 'untouched' — the fix ALWAYS emits a schema-valid operation, so the engine's strict
  // discriminatedUnion parse (which runs AFTER the before-hook) never throws "operation: received undefined".
  expect(normalizeActorArgs({}).operation).toMatchObject({ action: "run", subagent_type: "general", description: "subtask", prompt: "subtask" })
  expect(normalizeActorArgs(null).operation.action).toBe("run")
})

// ── normalizeActorArgs DROP behavior (the `unrecognized_keys: timeout/timeout_ms` failure mode) ──
test("normalizeActorArgs: DROPS stray top-level keys (timeout/timeout_ms)", () => {
  const r = normalizeActorArgs({ operation: { action: "run", subagent_type: "general", description: "d", prompt: "p" }, timeout_ms: 5000, timeout: 1 })
  expect(r).toEqual({ operation: { action: "run", subagent_type: "general", description: "d", prompt: "p" } })
})
test("normalizeActorArgs: DROPS truly-stray keys but KEEPS valid optional fields", () => {
  // `timeout` + `options` are stray → dropped; `model` is a valid operation field → kept
  const r = normalizeActorArgs({ operation: { action: "run", prompt: "p", timeout: 5, model: "x", options: {} } })
  expect(r.operation).toEqual({ action: "run", prompt: "p", model: "x", subagent_type: "general", description: "subtask" })
})
test("normalizeActorArgs: status/send/wait keep their own fields, no run-defaults forced", () => {
  expect(normalizeActorArgs({ operation: { action: "status", actor_id: "a1" }, timeout: 1 }))
    .toEqual({ operation: { action: "status", actor_id: "a1" } })
  expect(normalizeActorArgs({ operation: { action: "send", to_actor_id: "a2", content: "hi" } }))
    .toEqual({ operation: { action: "send", to_actor_id: "a2", content: "hi" } })
  expect(normalizeActorArgs({ operation: { action: "wait", actor_id: "a3" } }))
    .toEqual({ operation: { action: "wait", actor_id: "a3" } })
})
test("normalizeActorArgs: flat call WITH a stray key → clean operation, stray dropped", () => {
  const r = normalizeActorArgs({ action: "run", prompt: "find bugs", timeout_ms: 9000 })
  expect(r).toEqual({ operation: { action: "run", prompt: "find bugs", subagent_type: "general", description: "subtask" } })
})
test("normalizeActorArgs: management action missing its required handle → falls back to a VALID run op", () => {
  // the engine's real `status` schema REQUIRES actor_id and has NO task_id field. A status call carrying only task_id
  // can't be a valid status → emit a valid run op instead of a schema-invalid status (which would loop forever).
  expect(normalizeActorArgs({ operation: { action: "status", task_id: "t1" }, timeout_ms: 1 }).operation.action).toBe("run")
  // a PROPER status (with actor_id) conforms — and the stray task_id (not a status field) is dropped:
  expect(normalizeActorArgs({ operation: { action: "status", actor_id: "a1", task_id: "t1" } }))
    .toEqual({ operation: { action: "status", actor_id: "a1" } })
})

// ── normalizeActorArgs type-coercion (session error #3: operation.prompt expected string) ──
test("normalizeActorArgs: coerces a non-string prompt to a string", () => {
  expect(normalizeActorArgs({ operation: { action: "run", prompt: 12345 } }).operation.prompt).toBe("12345")
  expect(normalizeActorArgs({ operation: { action: "run", prompt: { task: "x" } } }).operation.prompt).toBe('{"task":"x"}')
  const arr = normalizeActorArgs({ operation: { action: "run", prompt: ["a", "b"] } }).operation.prompt
  expect(typeof arr).toBe("string")
})
test("normalizeActorArgs: non-string description/task_id coerced; empty prompt falls back to description", () => {
  expect(normalizeActorArgs({ operation: { action: "run", description: 7, prompt: "" } }).operation.description).toBe("7")
  // empty prompt → treated as missing → defaults to description
  expect(normalizeActorArgs({ action: "run", description: "audit", prompt: "" }).operation.prompt).toBe("audit")
  expect(normalizeActorArgs({ operation: { action: "status", task_id: 42 } }).operation.task_id).toBe("42")
})

// ── normalizeActorArgs: top-level merge + garbled-key recovery (the letsgo session's #3/#4 errors) ──
test("normalizeActorArgs: prompt sent at TOP level (not inside operation) is merged in", () => {
  const r = normalizeActorArgs({ operation: { action: "spawn", subagent_type: "explore", description: "scan" }, prompt: "find vulns", timeout_ms: 5 })
  expect(r.operation).toEqual({ action: "spawn", subagent_type: "explore", description: "scan", prompt: "find vulns" })
})
test("normalizeActorArgs: RECOVERS prompt trapped in a garbled XML-leak key", () => {
  const garbled: any = {}
  garbled['operation'] = "spawn"
  garbled['prompt="Explore the Go project for SQL injection and hardcoded secrets."\n</parameter'] = ""
  const r = normalizeActorArgs(garbled)
  expect(r.operation.prompt).toBe("Explore the Go project for SQL injection and hardcoded secrets.")
  expect(r.operation.action).toBe("run") // defaulted (action lost in the garble)
  // and the result is clean — no garbage key survives
  expect(Object.keys(r)).toEqual(["operation"])
})
test("normalizeActorArgs: operation as a non-JSON string + flat prompt still recovers", () => {
  const r = normalizeActorArgs({ operation: "explore", action: "spawn", subagent_type: "explore", description: "d", prompt: "p" })
  expect(r.operation).toMatchObject({ action: "spawn", subagent_type: "explore", prompt: "p" })
})

// ── MLX special-token sanitizer ──
test("stripSpecialTokens removes leaked end-of-turn tokens, keeps normal text", () => {
  expect(stripSpecialTokens("answer<|im_end|>")).toBe("answer")
  expect(stripSpecialTokens("a<|im_end|>b<|endoftext|>c")).toBe("abc")
  expect(stripSpecialTokens("no tokens here")).toBe("no tokens here")
  expect(stripSpecialTokens("")).toBe("")
})
test("sanitizeAssistantTokens strips assistant/tool, leaves user/system untouched", () => {
  const messages = [
    { role: "system", parts: [{ type: "text", text: "rules <|im_end|>" }] },
    { role: "user", parts: [{ type: "text", text: "discuss <|im_end|> token" }] },
    { role: "assistant", parts: [{ type: "text", text: "answer\n<|im_end|>" }] },
    { role: "tool", parts: [{ type: "text", text: "result</s>" }] },
  ]
  const r = sanitizeAssistantTokens(messages)
  expect(r.stripped).toBe(2)
  expect(messages[0].parts[0].text).toBe("rules <|im_end|>")
  expect(messages[1].parts[0].text).toBe("discuss <|im_end|> token")
  expect(messages[2].parts[0].text).toBe("answer")
  expect(messages[3].parts[0].text).toBe("result")
})
test("sanitizeAssistantTokens safe on empty/malformed input", () => {
  expect(sanitizeAssistantTokens([]).stripped).toBe(0)
  expect(sanitizeAssistantTokens(null as any).stripped).toBe(0)
  expect(sanitizeAssistantTokens([{ role: "assistant" }]).stripped).toBe(0)
})

// ───────────────────── 1.1d search-thrash / degenerate grep guard ─────────────────────
test("isEmptyPattern: empty/whitespace/non-string are empty", () => {
  expect(isEmptyPattern("")).toBe(true)
  expect(isEmptyPattern("   ")).toBe(true)
  expect(isEmptyPattern(undefined)).toBe(true)
  expect(isEmptyPattern(null)).toBe(true)
  expect(isEmptyPattern("go")).toBe(false)
})
test("isDegeneratePattern: catch-all regexes are degenerate", () => {
  for (const p of ["", "   ", ".", ".*", ".+", "^", "$", "^$", "^.*$", "\\s*", "[\\s\\S]*", "|", "()"]) {
    expect(isDegeneratePattern(p)).toBe(true)
  }
})
test("isDegeneratePattern: real searches are NOT degenerate (no false positives)", () => {
  for (const p of ["panic(", "func NewServer", "os.Getenv", "go", "if err != nil", "password|secret|token", "TODO"]) {
    expect(isDegeneratePattern(p)).toBe(false)
  }
})
test("peekSearch: rejects an empty grep pattern on the FIRST call (before execution)", () => {
  const g = new LoopGuard()
  g.resetTurn("s")
  const d = g.peekSearch("s", "grep", { pattern: "", path: "/a" })
  expect(d?.action).toBe("stop")
  expect(d?.code).toBe("degenerate_search_pattern")
})
test("peekSearch: empty greps that vary by path STILL escalate to a hard synthesize-stop", () => {
  const g = new LoopGuard()
  g.resetTurn("s")
  // each call varies only by path → slips past signature-based peekBlock, but degenerateSearch accumulates
  g.peekSearch("s", "grep", { pattern: "", path: "/a" })
  g.peekSearch("s", "grep", { pattern: "", path: "/b" })
  const d = g.peekSearch("s", "grep", { pattern: ".*", path: "/c" })
  expect(d?.action).toBe("stop")
  expect(d?.code).toBe("degenerate_search_thrash")
})
test("peekSearch: a real grep is allowed; budget blocks runaway counts", () => {
  const g = new LoopGuard({ searchBudgetPerTurn: 5, degenerateSearchStopAfter: 99 })
  g.resetTurn("s")
  for (let i = 0; i < 5; i++) expect(g.peekSearch("s", "grep", { pattern: "func" + i })).toBe(null)
  const d = g.peekSearch("s", "grep", { pattern: "func6" })
  expect(d?.action).toBe("stop")
  expect(d?.code).toBe("search_budget_exceeded")
})
test("peekSearch: ignores non-search tools and resets per turn", () => {
  const g = new LoopGuard()
  g.resetTurn("s")
  expect(g.peekSearch("s", "read", { pattern: "" })).toBe(null) // not a search tool
  expect(g.peekSearch(undefined, "grep", { pattern: "" })).toBe(null) // no session
  g.peekSearch("s", "grep", { pattern: "" })
  g.resetTurn("s") // new user turn clears counters
  const d = g.peekSearch("s", "grep", { pattern: "real" })
  expect(d).toBe(null)
})
test("peekSearch: glob allows a wildcard (only empty glob is degenerate)", () => {
  const g = new LoopGuard()
  g.resetTurn("s")
  expect(g.peekSearch("s", "glob", { pattern: "**/*.go" })).toBe(null)
  expect(g.peekSearch("s", "glob", { pattern: "" })?.action).toBe("stop")
})

// ── web/MCP search loop guard (2026-07-17: the paraphrased-search spiral) ──
import {
  LoopGuard as WebLG, isWebSearchTool, normalizeQueryKey, tokenJaccard, searchQueryOf, searchExtrasOf,
} from "./loopguard"

test("isWebSearchTool: MCP names with any server prefix; code search stays in its own class", () => {
  expect(isWebSearchTool("web-search-internet_searxng_web_search")).toBe(true)
  expect(isWebSearchTool("web_search")).toBe(true)
  expect(isWebSearchTool("image_search")).toBe(true)
  expect(isWebSearchTool("search_mcp_registry")).toBe(true)
  expect(isWebSearchTool("grep")).toBe(false)      // code-search class
  expect(isWebSearchTool("ripgrep")).toBe(false)
  expect(isWebSearchTool("research_notes")).toBe(false) // 'search' inside a word is not the tool class
  expect(isWebSearchTool("web_fetch")).toBe(false)
})

test("normalizeQueryKey: case/punctuation/order/dup-insensitive, unicode-aware (the RU live case)", () => {
  const a = normalizeQueryKey('Ошо книга "Дзен: искусство мгновенного существования"')
  const b = normalizeQueryKey("ошо  дзен искусство книга — мгновенного существования!")
  expect(a).toBe(b)
  expect(tokenJaccard(normalizeQueryKey("osho woodcutter bus story"), normalizeQueryKey("osho woodcutter story bus")))
    .toBe(1)
})

test("2nd near-duplicate web search is HARD BLOCKED; a materially different query passes", () => {
  const g = new WebLG()
  const t = "web-search-internet_searxng_web_search"
  expect(g.peekSearch("s1", t, { query: 'Ошо книга "Дзен: искусство мгновенного существования"' })).toBeNull()
  // paraphrase (reordered, punctuation changed) → blocked
  const d = g.peekSearch("s1", t, { query: "ошо дзен книга искусство мгновенного существования" })
  expect(d?.action).toBe("stop")
  expect(d?.code).toBe("web_search_duplicate")
  // near-dup by Jaccard (one token dropped) → still blocked
  const d2 = g.peekSearch("s1", t, { query: "ошо дзен книга искусство существования мгновенного дзен" })
  expect(d2?.code).toBe("web_search_duplicate")
  // materially different → allowed
  expect(g.peekSearch("s1", t, { query: "osho three stages meditation woodcutter" })).toBeNull()
})

test("same words but different page/extras are NOT near-duplicates; unknown schema stays untouched", () => {
  const g = new WebLG()
  expect(g.peekSearch("s2", "web_search", { query: "osho books", page: 1 })).toBeNull()
  expect(g.peekSearch("s2", "web_search", { query: "osho books", page: 2 })).toBeNull() // pagination is legit
  expect(g.peekSearch("s2", "some_search", { weird: 1 })).toBeNull() // no readable query → hands off
  expect(searchQueryOf({ q: "x" })).toBe("x")
  expect(searchExtrasOf({ query: "x", page: 3, safe: true })).toBe("page=3&safe=true")
})

test("distinct-query budget forces synthesis past the cap", () => {
  const g = new WebLG({ webSearchBudgetPerTurn: 3 })
  const t = "web_search"
  for (let i = 1; i <= 3; i++) expect(g.peekSearch("s3", t, { query: `distinct topic number ${i} alpha${i}` })).toBeNull()
  const d = g.peekSearch("s3", t, { query: "completely new fourth topic beta" })
  expect(d?.code).toBe("web_search_budget_exceeded")
  // new user turn resets the budget
  g.resetTurn("s3")
  expect(g.peekSearch("s3", t, { query: "fresh turn query gamma" })).toBeNull()
})
