// corner-hooks-reliability.test.ts
// TARGET: hooks:fabula-reliability  (plugin/fabula-reliability.ts)
//
// Exercises the real hooks returned by `await FabulaReliability({})` against the engine's
// real input/output object contract, and asserts on the mutations the hooks make in place
// (output.args / output.output / output.description / output.context / output.temperature …).
// The hooks call the real pure controllers in lib/ (LoopGuard, repairArgs, capOutput).
//
// Env-gated hooks (OUTPUT_CAP, TOOL_SAMPLING) read process.env at MODULE LOAD time, so to test
// different env configs we re-import the module with a UNIQUE query string
// (`?cap=1000`, `?probe=…`). Each fresh import builds its OWN LoopGuard + re-reads env. The base
// `FabulaReliability` import shares one guard across tests, so every base-import test uses a UNIQUE
// sessionID to stay independent.

import { test, expect, describe } from "bun:test"
import { FabulaReliability } from "../fabula-reliability"

type Hooks = Record<string, (...a: any[]) => any>

async function baseHooks(): Promise<Hooks> {
  return (await FabulaReliability({} as any)) as any
}

// Fresh module instance with its own guard + env snapshot. `tag` MUST be unique per call so bun's
// module cache doesn't hand back a stale instance.
async function freshHooks(tag: string, env?: Record<string, string | undefined>): Promise<Hooks> {
  const saved: Record<string, string | undefined> = {}
  if (env) {
    for (const k of Object.keys(env)) {
      saved[k] = process.env[k]
      if (env[k] === undefined) delete process.env[k]
      else process.env[k] = env[k]!
    }
  }
  try {
    const mod = await import(`../fabula-reliability?${tag}`)
    return (await mod.FabulaReliability({} as any)) as any
  } finally {
    if (env) {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]!
      }
    }
  }
}

let uid = 0
const sid = (label = "s") => `${label}-${Date.now()}-${uid++}`

// the engine's after-hook output shape
const out = (output: string, metadata: any = {}) => ({ title: "t", output, metadata })

// ───────────────────────────────────────────────────────────────────────────
describe("hook surface: FabulaReliability returns exactly the documented hooks", () => {
  test("all 7 hooks present and callable", async () => {
    const h = await baseHooks()
    for (const name of [
      "chat.message",
      "event",
      "tool.execute.before",
      "tool.execute.after",
      "tool.definition",
      "experimental.session.compacting",
      "chat.params",
    ]) {
      expect(typeof h[name]).toBe("function")
    }
  })

  test("repeated FabulaReliability() calls each return a working hook set (factory is re-callable)", async () => {
    const h1 = await baseHooks()
    const h2 = await baseHooks()
    expect(typeof h1["chat.message"]).toBe("function")
    expect(typeof h2["tool.execute.after"]).toBe("function")
    // they share the module-level `guard`, but both must function
    const s = sid("refactory")
    const o = out("X")
    await h2["tool.execute.after"]({ tool: "view", sessionID: s, args: { p: "/a" } }, o)
    expect(o.output).toBe("X")
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('"chat.message" — resets per-session loop counters', () => {
  test("reset clears no-progress count so a previously-warned read goes back to allow", async () => {
    const h = await baseHooks()
    const s = sid("chatmsg")
    const inp = { tool: "view", sessionID: s, args: { path: "/a" } }
    const a = out("SAME"); await h["tool.execute.after"](inp, a) // 1 → allow
    expect(a.output).toBe("SAME")
    const b = out("SAME"); await h["tool.execute.after"](inp, b) // 2 → warn
    expect(b.output).toContain("Tool loop warning")
    // new user turn
    await h["chat.message"]({ sessionID: s })
    const c = out("SAME"); await h["tool.execute.after"](inp, c) // 1 again → allow
    expect(c.output).toBe("SAME")
  })

  test("missing sessionID → no throw, no reset side effect", async () => {
    const h = await baseHooks()
    await expect(h["chat.message"]({})).resolves.toBeUndefined()
    await expect(h["chat.message"]({ sessionID: undefined })).resolves.toBeUndefined()
    await expect(h["chat.message"](null)).resolves.toBeUndefined()
    await expect(h["chat.message"](undefined)).resolves.toBeUndefined()
  })

  test("reset is per-session: resetting A does not reset B", async () => {
    const h = await baseHooks()
    const A = sid("A"), B = sid("B")
    const ia = { tool: "view", sessionID: A, args: { path: "/a" } }
    const ib = { tool: "view", sessionID: B, args: { path: "/a" } }
    await h["tool.execute.after"](ia, out("SAME"))
    await h["tool.execute.after"](ib, out("SAME"))
    // B at count 2 → warn
    const b2 = out("SAME"); await h["tool.execute.after"](ib, b2)
    expect(b2.output).toContain("Tool loop warning")
    // reset only A
    await h["chat.message"]({ sessionID: A })
    // A back to allow
    const a1 = out("SAME"); await h["tool.execute.after"](ia, a1)
    expect(a1.output).toBe("SAME")
    // B still escalating (count 3, still warn-tier text present)
    const b3 = out("SAME"); await h["tool.execute.after"](ib, b3)
    expect(b3.output).toContain("Tool loop warning")
  })

  test("repeated chat.message calls are idempotent (double reset is harmless)", async () => {
    const h = await baseHooks()
    const s = sid("doublereset")
    await h["chat.message"]({ sessionID: s })
    await h["chat.message"]({ sessionID: s })
    const o = out("SAME"); await h["tool.execute.after"]({ tool: "view", sessionID: s, args: { path: "/a" } }, o)
    expect(o.output).toBe("SAME") // fresh after double reset
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('"event" — session.deleted drops state; others ignored; malformed props tolerated', () => {
  test("session.deleted with properties.sessionID drops in-memory loop state", async () => {
    const h = await baseHooks()
    const s = sid("evt-del")
    const inp = { tool: "view", sessionID: s, args: { path: "/a" } }
    await h["tool.execute.after"](inp, out("SAME"))
    const w = out("SAME"); await h["tool.execute.after"](inp, w)
    expect(w.output).toContain("Tool loop warning") // count 2 → warn
    await h.event({ event: { type: "session.deleted", properties: { sessionID: s } } })
    const fresh = out("SAME"); await h["tool.execute.after"](inp, fresh)
    expect(fresh.output).toBe("SAME") // dropped → starts at allow
  })

  test("session.deleted id resolved from info.id / id / session.id alternates", async () => {
    const h = await baseHooks()
    for (const props of [
      (s: string) => ({ info: { id: s } }),
      (s: string) => ({ id: s }),
      (s: string) => ({ session: { id: s } }),
    ]) {
      const s = sid("evt-altid")
      const inp = { tool: "view", sessionID: s, args: { path: "/a" } }
      await h["tool.execute.after"](inp, out("SAME"))
      const w = out("SAME"); await h["tool.execute.after"](inp, w)
      expect(w.output).toContain("Tool loop warning")
      await h.event({ event: { type: "session.deleted", properties: props(s) } })
      const fresh = out("SAME"); await h["tool.execute.after"](inp, fresh)
      expect(fresh.output).toBe("SAME")
    }
  })

  test("non-session.deleted events are ignored (state untouched)", async () => {
    const h = await baseHooks()
    const s = sid("evt-other")
    const inp = { tool: "view", sessionID: s, args: { path: "/a" } }
    await h["tool.execute.after"](inp, out("SAME")) // count 1
    for (const type of ["session.updated", "message.created", "file.edited", "random.event"]) {
      await h.event({ event: { type, properties: { sessionID: s } } })
    }
    // state was NOT dropped → next call is count 2 → warn
    const w = out("SAME"); await h["tool.execute.after"](inp, w)
    expect(w.output).toContain("Tool loop warning")
  })

  test("malformed / missing event.properties do not throw", async () => {
    const h = await baseHooks()
    const cases: any[] = [
      { event: { type: "session.deleted" } },                              // no properties
      { event: { type: "session.deleted", properties: null } },            // null props
      { event: { type: "session.deleted", properties: {} } },              // empty props → no id
      { event: { type: "session.deleted", properties: { sessionID: 123 } } }, // non-string id
      { event: { type: "session.deleted", properties: { info: null } } },  // info null
      { event: { type: "session.deleted", properties: { session: 5 } } },  // session not object
      { event: {} },                                                       // no type
      { event: null },                                                     // null event
      {},                                                                  // no event key
      { event: { type: "session.deleted", properties: { sessionID: ["x"] } } }, // array id (non-string)
    ]
    for (const c of cases) {
      await expect(h.event(c)).resolves.toBeUndefined()
    }
  })

  test("non-string id (number) is NOT treated as a session → no spurious drop", async () => {
    const h = await baseHooks()
    const s = sid("evt-numid")
    const inp = { tool: "view", sessionID: s, args: { path: "/a" } }
    await h["tool.execute.after"](inp, out("SAME")) // count 1
    // event carries a numeric id that does NOT match our string session → guard.dropSession not called
    await h.event({ event: { type: "session.deleted", properties: { sessionID: 42 } } })
    const w = out("SAME"); await h["tool.execute.after"](inp, w) // count 2 → still warn (not dropped)
    expect(w.output).toContain("Tool loop warning")
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('"tool.execute.before" — arg repair / strip / passthrough', () => {
  test("strips stray top-level keys from actor, keeps operation (strict tool)", async () => {
    const h = await baseHooks()
    const o = { args: { operation: { action: "run", subagent_type: "general", description: "d", prompt: "p" }, timeout_ms: 999, model: "x", options: {} } }
    await h["tool.execute.before"]({ tool: "actor", sessionID: sid() }, o)
    expect(Object.keys(o.args)).toEqual(["operation"])
  })

  test("strict tool `task` is also whitelisted-stripped", async () => {
    const h = await baseHooks()
    const o = { args: { operation: { action: "run", subagent_type: "general", description: "d", prompt: "p" }, timeout: 5 } }
    await h["tool.execute.before"]({ tool: "task", sessionID: sid() }, o)
    expect(o.args).toEqual({ operation: { action: "run", subagent_type: "general", description: "d", prompt: "p" } })
  })

  test("non-strict tool passes through unchanged (extra keys kept, object identity preserved when no change)", async () => {
    const h = await baseHooks()
    const original = { path: "/a", timeout_ms: 5, anything: true }
    const o = { args: original }
    await h["tool.execute.before"]({ tool: "view", sessionID: sid() }, o)
    expect(o.args).toEqual({ path: "/a", timeout_ms: 5, anything: true })
    // r.changed is false for non-strict clean args → hook does NOT reassign → same reference
    expect(o.args).toBe(original)
  })

  test("actor with null args → normalized to a VALID operation (never raw → no strict-validation loop)", async () => {
    const h = await baseHooks()
    const o: any = { args: null }
    await expect(h["tool.execute.before"]({ tool: "actor", sessionID: sid() }, o)).resolves.toBeUndefined()
    expect(o.args.operation.action).toBe("run") // the engine validates with the original STRICT schema after this hook
  })

  test("actor with undefined args → normalized to a VALID operation, no throw", async () => {
    const h = await baseHooks()
    const o: any = { args: undefined }
    await expect(h["tool.execute.before"]({ tool: "actor", sessionID: sid() }, o)).resolves.toBeUndefined()
    expect(o.args.operation.action).toBe("run")
  })

  test("output itself null/undefined → early return, no throw", async () => {
    const h = await baseHooks()
    await expect(h["tool.execute.before"]({ tool: "actor", sessionID: sid() }, null)).resolves.toBeUndefined()
    await expect(h["tool.execute.before"]({ tool: "actor", sessionID: sid() }, undefined)).resolves.toBeUndefined()
  })

  test("missing input.tool → repairArgs(undefined,…) treats as non-strict passthrough", async () => {
    const h = await baseHooks()
    const o = { args: { description: "d", timeout_ms: 9 } }
    await h["tool.execute.before"]({ sessionID: sid() }, o) // no tool field
    // undefined tool not in STRICT_TOOL_KEYS → nothing stripped
    expect(o.args).toEqual({ description: "d", timeout_ms: 9 })
  })

  test("strict tool with ONLY the operation key → unchanged (no spurious mutation)", async () => {
    const h = await baseHooks()
    const clean = { operation: { action: "run", subagent_type: "general", description: "d", prompt: "p" } }
    const o = { args: { operation: { action: "run", subagent_type: "general", description: "d", prompt: "p" } } }
    await h["tool.execute.before"]({ tool: "actor", sessionID: sid() }, o)
    expect(o.args).toEqual(clean)
  })

  test("lone-surrogate sanitization on string args (the JSON-reencode crash guard)", async () => {
    const h = await baseHooks()
    // lone high surrogate \uD83D with no low surrogate following
    const o = { args: { operation: { action: "run", subagent_type: "g", description: "hi\uD83Dthere", prompt: "p" } } }
    await h["tool.execute.before"]({ tool: "actor", sessionID: sid() }, o)
    // the lone surrogate code unit (0xD83D) must be gone, replaced by U+FFFD (0xFFFD)
    const codes = Array.from(o.args.operation.description as string).map((c) => c.codePointAt(0))
    expect(codes).not.toContain(0xd83d)
    expect(o.args.operation.description).toBe("hi�there")
    // crucially: the repaired value must JSON-reencode without throwing (the whole point)
    expect(() => JSON.stringify(o.args)).not.toThrow()
    // valid emoji (paired surrogates) must survive untouched
    const o2 = { args: { operation: { action: "run", subagent_type: "g", description: "ok 😀", prompt: "p" } } }
    await h["tool.execute.before"]({ tool: "actor", sessionID: sid() }, o2)
    expect(o2.args.operation.description).toBe("ok 😀")
  })

  test("actor with non-plain-object args (array) → normalized to a VALID operation, no throw", async () => {
    const h = await baseHooks()
    const oArr: any = { args: ["a", "b"] }
    await expect(h["tool.execute.before"]({ tool: "actor", sessionID: sid() }, oArr)).resolves.toBeUndefined()
    expect(oArr.args.operation.action).toBe("run") // array coerced → valid run op (never raw)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('"tool.execute.after" — loop-steer + failure escalation + output cap', () => {
  test("idempotent identical result: allow@1, warn@2, stop@5", async () => {
    const h = await baseHooks()
    const s = sid("steer")
    const inp = { tool: "view", sessionID: s, args: { path: "/a" } }
    const o1 = out("SAME"); await h["tool.execute.after"](inp, o1)
    expect(o1.output).toBe("SAME") // count1 allow
    const o2 = out("SAME"); await h["tool.execute.after"](inp, o2)
    expect(o2.output).toContain("Tool loop warning")          // count2 warn
    const o3 = out("SAME"); await h["tool.execute.after"](inp, o3)
    expect(o3.output).toContain("Tool loop warning")          // count3 warn
    const o4 = out("SAME"); await h["tool.execute.after"](inp, o4)
    expect(o4.output).toContain("Tool loop warning")          // count4 warn
    const o5 = out("SAME"); await h["tool.execute.after"](inp, o5)
    expect(o5.output).toContain("HARD STOP")                  // count5 stop
    expect(o5.output).toContain("idempotent_no_progress_stop")
  })

  test("different result each call → no no-progress warning (progress made)", async () => {
    const h = await baseHooks()
    const s = sid("progress")
    const inp = { tool: "view", sessionID: s, args: { path: "/a" } }
    for (let i = 0; i < 6; i++) {
      const o = out(`RESULT_${i}`)
      await h["tool.execute.after"](inp, o)
      expect(o.output).toBe(`RESULT_${i}`)
    }
  })

  test("mutating tool repeated identical result is NOT loop-steered (write may do new work)", async () => {
    const h = await baseHooks()
    const s = sid("mutate")
    const inp = { tool: "write", sessionID: s, args: { path: "/a", content: "x" } }
    for (let i = 0; i < 6; i++) {
      const o = out("OK")
      await h["tool.execute.after"](inp, o)
      expect(o.output).toBe("OK") // never steered
    }
  })

  test("failure escalation via metadata.error: warn@2, stop@5 (same args)", async () => {
    const h = await baseHooks()
    const s = sid("fail")
    const inp = { tool: "bash", sessionID: s, args: { command: "false" } }
    const f1 = out("boom", { error: true }); await h["tool.execute.after"](inp, f1)
    expect(f1.output).toBe("boom") // count1 allow
    const f2 = out("boom", { error: true }); await h["tool.execute.after"](inp, f2)
    expect(f2.output).toContain("Tool loop warning")
    expect(f2.output).toContain("repeated_exact_failure_warning")
    const f3 = out("boom", { error: true }); await h["tool.execute.after"](inp, f3)
    const f4 = out("boom", { error: true }); await h["tool.execute.after"](inp, f4)
    const f5 = out("boom", { error: true }); await h["tool.execute.after"](inp, f5)
    expect(f5.output).toContain("HARD STOP")
    expect(f5.output).toContain("repeated_exact_failure_stop")
  })

  test("failure classified from exit code in metadata (non-zero)", async () => {
    const h = await baseHooks()
    const s = sid("exit")
    const inp = { tool: "bash", sessionID: s, args: { command: "x" } }
    const f1 = out("oops", { exit: 1 }); await h["tool.execute.after"](inp, f1)
    const f2 = out("oops", { exit: 1 }); await h["tool.execute.after"](inp, f2)
    expect(f2.output).toContain("Tool loop warning") // 2nd identical failure
  })

  test("failure classified from string output prefix 'Error'", async () => {
    const h = await baseHooks()
    const s = sid("errstr")
    const inp = { tool: "view", sessionID: s, args: { path: "/missing" } }
    const f1 = out("Error: ENOENT no such file"); await h["tool.execute.after"](inp, f1)
    const f2 = out("Error: ENOENT no such file"); await h["tool.execute.after"](inp, f2)
    expect(f2.output).toContain("Tool loop warning")
  })

  // Non-string tool output must not crash the after-hook.
  // The engine's typed contract declares output.output: string, so this is UNREACHABLE on the typed path.
  // The after-hook half-defends: capOutput() guards with `typeof output.output === "string"` (so the cap
  // is skipped for non-strings), then calls guard.observe(... output.output ...). Inside
  // LoopGuard.classifyFailure (lib/loopguard.ts) the only guard is `if (result == null) return false` — a
  // non-null, non-string result reaches `result.slice(0, 500)` and would throw `TypeError: result.slice is
  // not a function`, propagating OUT of the hook and aborting the tool-execution pipeline. Guarding in
  // classifyFailure (`if (typeof result !== "string") return false`, or coercing in the after-hook)
  // keeps a non-string output a no-op.
  test("FIXED: non-string output.output does NOT crash the after-hook (no-op, unchanged)", async () => {
    const h = await baseHooks()
    const o: any = { title: "t", output: { complex: true, n: 5 }, metadata: {} }
    await expect(h["tool.execute.after"]({ tool: "view", sessionID: sid("nonstr"), args: { p: "/a" } }, o)).resolves.toBeUndefined()
    expect(o.output).toEqual({ complex: true, n: 5 }) // non-string output left untouched, no throw
  })

  test("FIXED: a numeric output.output is also handled gracefully (no throw)", async () => {
    const h = await baseHooks()
    const o: any = { title: "t", output: 12345, metadata: {} }
    await expect(h["tool.execute.after"]({ tool: "view", sessionID: sid("nonstr2"), args: { p: "/a" } }, o)).resolves.toBeUndefined()
    expect(o.output).toBe(12345)
  })

  test("empty-string output: no crash; loop tracking still runs on '' result", async () => {
    const h = await baseHooks()
    const s = sid("empty")
    const inp = { tool: "view", sessionID: s, args: { p: "/a" } }
    const e1 = out(""); await h["tool.execute.after"](inp, e1)
    expect(e1.output).toBe("")
    const e2 = out(""); await h["tool.execute.after"](inp, e2) // identical "" → warn
    expect(e2.output).toContain("Tool loop warning")
  })

  test("output.output undefined: hook tolerates, observe gets ?? '' fallback", async () => {
    const h = await baseHooks()
    const s = sid("undefout")
    const o: any = { title: "t", metadata: {} } // no output field
    await expect(h["tool.execute.after"]({ tool: "view", sessionID: s, args: { p: "/a" } }, o)).resolves.toBeUndefined()
    // allow on first → LoopGuard.apply only runs when action != allow, so output stays undefined
    expect(o.output).toBeUndefined()
  })

  test("output object itself null/undefined → early return, no throw", async () => {
    const h = await baseHooks()
    await expect(h["tool.execute.after"]({ tool: "view", sessionID: sid() }, null)).resolves.toBeUndefined()
    await expect(h["tool.execute.after"]({ tool: "view", sessionID: sid() }, undefined)).resolves.toBeUndefined()
  })

  test("missing sessionID on after-hook: observe still works (keyed by undefined), no throw", async () => {
    const h = await baseHooks()
    const o = out("hello")
    await expect(h["tool.execute.after"]({ tool: "view", args: { p: "/a" } }, o)).resolves.toBeUndefined()
    expect(o.output).toBe("hello")
  })

  test("DEFAULT cap (120k) does NOT truncate a 50k output", async () => {
    const h = await baseHooks() // base module uses default 120k (env unset)
    const s = sid("nocap")
    const big = "y".repeat(50_000)
    const o = out(big)
    await h["tool.execute.after"]({ tool: "view", sessionID: s, args: { p: "/a" } }, o)
    expect(o.output).toBe(big)
    expect(o.output).not.toContain("tool output truncated")
  })

  test("output cap via FRESH import with FABULA_TOOL_OUTPUT_CAP=1000 truncates 5k output", async () => {
    const h = await freshHooks("cap=1000", { FABULA_TOOL_OUTPUT_CAP: "1000" })
    const o = out("x".repeat(5000))
    await h["tool.execute.after"]({ tool: "view", sessionID: sid("capped"), args: {} }, o)
    expect(o.output.length).toBeLessThan(5000)
    expect(o.output.length).toBeGreaterThanOrEqual(1000)
    expect(o.output.startsWith("x".repeat(1000))).toBe(true)
    expect(o.output).toContain("tool output truncated")
    expect(o.output).toContain("4000 characters omitted")
  })

  test("cap=0 (disabled) via fresh import: huge output untouched", async () => {
    const h = await freshHooks("cap=0", { FABULA_TOOL_OUTPUT_CAP: "0" })
    const big = "z".repeat(200_000)
    const o = out(big)
    await h["tool.execute.after"]({ tool: "view", sessionID: sid("cap0"), args: {} }, o)
    expect(o.output).toBe(big) // OUTPUT_CAP falsy → capOutput returns input
  })

  test("invalid cap env (NaN) falls back to default 120k (200k output stays untruncated below... actually truncated >120k)", async () => {
    const h = await freshHooks("cap=bad", { FABULA_TOOL_OUTPUT_CAP: "not-a-number" })
    // NaN → default 120_000. A 130k output should be truncated to 120k + notice.
    const o = out("q".repeat(130_000))
    await h["tool.execute.after"]({ tool: "view", sessionID: sid("capbad"), args: {} }, o)
    expect(o.output).toContain("tool output truncated")
    expect(o.output.startsWith("q".repeat(120_000))).toBe(true)
  })

  test("negative cap env rejected → default 120k used", async () => {
    const h = await freshHooks("cap=neg", { FABULA_TOOL_OUTPUT_CAP: "-5" })
    const o = out("w".repeat(130_000))
    await h["tool.execute.after"]({ tool: "view", sessionID: sid("capneg"), args: {} }, o)
    expect(o.output).toContain("tool output truncated") // proves default (not -5) is in effect
  })

  test("cap is applied BEFORE loop-steer, so guidance text is never truncated away", async () => {
    // small cap + repeated identical idempotent → on the stop-tier call the guidance must be present
    const h = await freshHooks("cap=order", { FABULA_TOOL_OUTPUT_CAP: "50" })
    const s = sid("caporder")
    const inp = { tool: "view", sessionID: s, args: { p: "/a" } }
    let last: any
    for (let i = 0; i < 5; i++) {
      last = out("R".repeat(500)) // each call exceeds the 50-char cap
      await h["tool.execute.after"](inp, last)
    }
    // 5th call = stop tier: the body is capped but the HARD STOP guidance is appended AFTER the cap
    expect(last.output).toContain("HARD STOP")
    expect(last.output).toContain("tool output truncated")
    // guidance appears after the truncation notice (i.e. not cut)
    expect(last.output.indexOf("HARD STOP")).toBeGreaterThan(last.output.indexOf("tool output truncated"))
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('"tool.definition" — STRICT note added once, non-strict untouched', () => {
  test("actor gets the operation-nested schema note", async () => {
    const h = await baseHooks()
    const o = { description: "Spawn a subagent.", parameters: {} }
    await h["tool.definition"]({ toolID: "actor" }, o)
    expect(o.description).toContain("operation-nested")  // the real nested shape, not flat keys
    expect(o.description).toContain('"operation"')
    expect(o.description).toContain("subagent_type")
    expect(o.description).toContain("prompt")
  })

  test("task does NOT get actor-shaped guidance/schema (different tool) — only the generic operation note", async () => {
    const h = await baseHooks()
    const o: any = { description: "Run a task.", parameters: { realTaskSchema: true } }
    await h["tool.definition"]({ toolID: "task" }, o)
    // task must NOT be steered with ACTOR semantics — that mis-shapes task calls (its ops are create:{summary},
    // start:{id}, … not subagent_type/prompt) → "task tool called with invalid arguments".
    expect(o.description).not.toContain("operation-nested")
    expect(o.description).not.toContain("subagent_type")
    expect(o.description).not.toContain('"run"')
    // it gets ONLY the harmless generic strict note (task IS operation-nested) …
    expect(o.description).toContain("STRICT SCHEMA")
    expect(o.description).toContain("operation")
    // … and its REAL schema is preserved (NOT replaced with the permissive actor schema)
    expect(o.parameters).toEqual({ realTaskSchema: true })
  })

  test("note is added ONCE — second pass over same definition does not duplicate it", async () => {
    const h = await baseHooks()
    const o = { description: "Spawn a subagent.", parameters: {} }
    await h["tool.definition"]({ toolID: "actor" }, o)
    const after1 = o.description
    await h["tool.definition"]({ toolID: "actor" }, o) // idempotent
    expect(o.description).toBe(after1)
    expect(o.description.match(/operation-nested/g)?.length).toBe(1)
  })

  test("non-strict tool description is untouched", async () => {
    const h = await baseHooks()
    const o = { description: "Read a file.", parameters: {} }
    await h["tool.definition"]({ toolID: "view" }, o)
    expect(o.description).toBe("Read a file.")
  })

  test("unknown / missing toolID → untouched, no throw", async () => {
    const h = await baseHooks()
    const o = { description: "x" }
    await expect(h["tool.definition"]({}, o)).resolves.toBeUndefined()
    expect(o.description).toBe("x")
    await expect(h["tool.definition"]({ toolID: "nonexistent_tool" }, o)).resolves.toBeUndefined()
    expect(o.description).toBe("x")
  })

  test("output null / non-string description → no throw, no mutation", async () => {
    const h = await baseHooks()
    await expect(h["tool.definition"]({ toolID: "actor" }, null)).resolves.toBeUndefined()
    const o: any = { description: 123, parameters: {} } // non-string description
    await h["tool.definition"]({ toolID: "actor" }, o)
    expect(o.description).toBe(123) // guarded by typeof === "string"
    const o2: any = { parameters: {} } // no description field
    await h["tool.definition"]({ toolID: "actor" }, o2)
    expect(o2.description).toBeUndefined()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('"experimental.session.compacting" — pushes preserve/compress hint', () => {
  test("appends the preserve/compress guidance to a context array", async () => {
    const h = await baseHooks()
    const o = { context: ["existing system prompt chunk"] }
    await h["experimental.session.compacting"]({}, o)
    expect(o.context.length).toBe(2)
    expect(o.context[1]).toContain("PRESERVE")
    expect(o.context[1]).toContain("COMPRESS")
    expect(o.context[1]).toContain("absolute paths")
  })

  test("output.context not an array → no throw, nothing pushed", async () => {
    const h = await baseHooks()
    const oStr: any = { context: "a string not array" }
    await expect(h["experimental.session.compacting"]({}, oStr)).resolves.toBeUndefined()
    expect(oStr.context).toBe("a string not array")
    const oNull: any = { context: null }
    await h["experimental.session.compacting"]({}, oNull)
    expect(oNull.context).toBeNull()
    const oMissing: any = {} // no context key
    await h["experimental.session.compacting"]({}, oMissing)
    expect(oMissing.context).toBeUndefined()
  })

  test("output null/undefined → early return, no throw", async () => {
    const h = await baseHooks()
    await expect(h["experimental.session.compacting"]({}, null)).resolves.toBeUndefined()
    await expect(h["experimental.session.compacting"]({}, undefined)).resolves.toBeUndefined()
  })

  test("empty context array → hint appended (becomes length 1)", async () => {
    const h = await baseHooks()
    const o = { context: [] as string[] }
    await h["experimental.session.compacting"]({}, o)
    expect(o.context.length).toBe(1)
    expect(o.context[0]).toContain("PRESERVE")
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('"chat.params" — FABULA_TOOL_SAMPLING gate + clamps', () => {
  test("DEFAULT (env unset / sampling OFF): temperature & topP UNTOUCHED", async () => {
    const h = await baseHooks() // base module loaded with sampling off (env unset in this run)
    const o = { temperature: 0.95, topP: 0.99 }
    await h["chat.params"]({}, o)
    expect(o.temperature).toBe(0.95)
    expect(o.topP).toBe(0.99)
  })

  test("sampling OFF explicitly (FABULA_TOOL_SAMPLING=0) via fresh import: untouched", async () => {
    const h = await freshHooks("samp=0", { FABULA_TOOL_SAMPLING: "0" })
    const o = { temperature: 1.0, topP: 1.0 }
    await h["chat.params"]({}, o)
    expect(o.temperature).toBe(1.0)
    expect(o.topP).toBe(1.0)
  })

  test("sampling ON (=1) clamps temperature to ≤0.3 and topP to ≤0.9", async () => {
    const h = await freshHooks("samp=1", { FABULA_TOOL_SAMPLING: "1" })
    const hi = { temperature: 0.9, topP: 0.99 }
    await h["chat.params"]({}, hi)
    expect(hi.temperature).toBe(0.3)
    expect(hi.topP).toBe(0.9)
  })

  test("sampling ON but values already below clamp → left as-is (Math.min keeps the smaller)", async () => {
    const h = await freshHooks("samp=1b", { FABULA_TOOL_SAMPLING: "1" })
    const lo = { temperature: 0.1, topP: 0.5 }
    await h["chat.params"]({}, lo)
    expect(lo.temperature).toBe(0.1)
    expect(lo.topP).toBe(0.5)
  })

  test("sampling ON, only temperature present (no topP) → only temperature clamped", async () => {
    const h = await freshHooks("samp=1c", { FABULA_TOOL_SAMPLING: "1" })
    const o: any = { temperature: 0.8 }
    await h["chat.params"]({}, o)
    expect(o.temperature).toBe(0.3)
    expect(o.topP).toBeUndefined()
  })

  test("sampling ON, non-number temperature/topP ignored (typeof guard)", async () => {
    const h = await freshHooks("samp=1d", { FABULA_TOOL_SAMPLING: "1" })
    const o: any = { temperature: "hot", topP: null }
    await h["chat.params"]({}, o)
    expect(o.temperature).toBe("hot") // untouched (not a number)
    expect(o.topP).toBeNull()
  })

  test("sampling ON but output null/undefined → no throw", async () => {
    const h = await freshHooks("samp=1e", { FABULA_TOOL_SAMPLING: "1" })
    await expect(h["chat.params"]({}, null)).resolves.toBeUndefined()
    await expect(h["chat.params"]({}, undefined)).resolves.toBeUndefined()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe("hook-order independence & cross-hook integration", () => {
  test("before→after on the same call: repaired args don't break loop signature tracking", async () => {
    const h = await baseHooks()
    const s = sid("integ")
    // repair strips timeout_ms; loop sig in after uses input.args (the executed args) — independent paths
    const bo = { args: { operation: { action: "run", subagent_type: "g", description: "d", prompt: "p" }, timeout_ms: 1 } }
    await h["tool.execute.before"]({ tool: "actor", sessionID: s }, bo)
    expect(bo.args.timeout_ms).toBeUndefined()
    expect(bo.args.operation).toBeDefined()
    // actor is a MUTATING tool → after-hook never no-progress-steers it even if identical
    const a1 = out("done"); await h["tool.execute.after"]({ tool: "actor", sessionID: s, args: bo.args }, a1)
    const a2 = out("done"); await h["tool.execute.after"]({ tool: "actor", sessionID: s, args: bo.args }, a2)
    expect(a1.output).toBe("done")
    expect(a2.output).toBe("done")
  })

  test("calling hooks out of natural order (after before chat.message) does not throw / corrupt", async () => {
    const h = await baseHooks()
    const s = sid("order")
    // after-hook first (no prior chat.message reset) → guard lazily creates the session
    const o1 = out("SAME"); await h["tool.execute.after"]({ tool: "view", sessionID: s, args: { p: "/a" } }, o1)
    expect(o1.output).toBe("SAME")
    // now a chat.message reset clears it
    await h["chat.message"]({ sessionID: s })
    const o2 = out("SAME"); await h["tool.execute.after"]({ tool: "view", sessionID: s, args: { p: "/a" } }, o2)
    expect(o2.output).toBe("SAME") // back to count1 allow
  })

  test("compacting + chat.params + definition are pure-per-call (no shared state leakage)", async () => {
    const h = await baseHooks()
    const c1 = { context: ["a"] }; await h["experimental.session.compacting"]({}, c1)
    const c2 = { context: ["b"] }; await h["experimental.session.compacting"]({}, c2)
    expect(c1.context.length).toBe(2)
    expect(c2.context.length).toBe(2)
    expect(c1.context[1]).toBe(c2.context[1]) // same constant hint, independent arrays
    expect(c1.context).not.toBe(c2.context)
  })
})
