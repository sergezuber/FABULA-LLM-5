// Wiring test: invokes the REAL plugin hooks with the engine's exact input/output contract
// (shapes from @mimo-ai/plugin Hooks .d.ts). The engine calls these hooks and appending to
// output.output reaches the model; this proves our glue does the right thing.
import { test, expect } from "bun:test"
import { tool } from "@mimo-ai/plugin"
import { FabulaReliability } from "../fabula-reliability"
import { eofNotice } from "../lib/loopguard"
import { normalizeActorArgs } from "../lib/argrepair"

async function hooks() {
  return await FabulaReliability({} as any)
}

test("after-hook appends loop guidance on repeated identical idempotent reads", async () => {
  const h: any = await hooks()
  await h["chat.message"]({ sessionID: "s" })
  const mk = () => ({ title: "t", output: "SAME_RESULT", metadata: {} })
  const inp = { tool: "view", sessionID: "s", callID: "c", args: { path: "/a" } }
  const o1 = mk(); await h["tool.execute.after"](inp, o1) // 1 → allow
  expect(o1.output).toBe("SAME_RESULT")
  const o2 = mk(); await h["tool.execute.after"](inp, o2) // 2 → warn appended
  expect(o2.output).toContain("Tool loop warning")
})

test("eofNotice: paginated read with a short final page → END OF FILE notice", () => {
  // offset 1650, limit 200, but only 1 line came back → EOF
  const n = eofNotice("read", { filePath: "/b.md", offset: 1650, limit: 200 }, "  1650\ttail line")
  expect(n).toMatch(/END OF FILE/)
})
test("eofNotice: whole-file read (no/low offset) → no notice", () => {
  expect(eofNotice("read", { filePath: "/b.md", offset: 0, limit: 200 }, "one\ntwo\nthree")).toBeNull()
  expect(eofNotice("read", { filePath: "/b.md" }, "one\ntwo")).toBeNull()
})
test("eofNotice: a FULL page (lines >= limit) is NOT EOF", () => {
  const out = Array.from({ length: 200 }, (_, i) => "line " + i).join("\n")
  expect(eofNotice("read", { filePath: "/b.md", offset: 200, limit: 200 }, out)).toBeNull()
})
test("eofNotice: non-read tools never get the notice", () => {
  expect(eofNotice("bash", { offset: 5000 }, "x")).toBeNull()
  expect(eofNotice("web_search", { offset: 5000 }, "x")).toBeNull()
})
test("after-hook appends EOF notice for a paginated read at end-of-file", async () => {
  const h: any = await hooks()
  await h["chat.message"]({ sessionID: "se" })
  const o = { title: "t", output: "  1650\ttail line", metadata: {} }
  await h["tool.execute.after"]({ tool: "read", sessionID: "se", callID: "c", args: { filePath: "/b.md", offset: 1650, limit: 200 } }, o)
  expect(o.output).toContain("END OF FILE")
})

test("before-hook strips a stray top-level key from actor via real wiring", async () => {
  const h: any = await hooks()
  const out = { args: { operation: { action: "run", subagent_type: "general", description: "d", prompt: "p" }, timeout_ms: 999 } }
  await h["tool.execute.before"]({ tool: "actor", sessionID: "s", callID: "c" }, out)
  expect(Object.keys(out.args)).toEqual(["operation"])
})

test("before-hook THROWS on an empty/catch-all grep pattern (search-thrash death-spiral fix)", async () => {
  const h: any = await hooks()
  await h["chat.message"]({ sessionID: "sg" })
  // empty pattern → would match every line and flood context → must be aborted before execution
  await expect(
    h["tool.execute.before"]({ tool: "grep", sessionID: "sg", callID: "c", args: { pattern: "", path: "/x" } }, {}),
  ).rejects.toThrow(/empty or catch-all|matches every line|specific search/i)
})

test("before-hook ALLOWS a real grep (no false-positive block)", async () => {
  const h: any = await hooks()
  await h["chat.message"]({ sessionID: "sg2" })
  // a specific literal pattern must pass straight through
  await h["tool.execute.before"]({ tool: "grep", sessionID: "sg2", callID: "c", args: { pattern: "func NewServer", path: "/x" } }, {})
  expect(true).toBe(true)
})

// ROOT CAUSE: the engine converts our Zod schema to JSON Schema (z.toJSONSchema)
// and the AI SDK validates the model's args against the JSON Schema — a Zod `z.preprocess` is LOST and never runs.
// So the strict discriminated `operation` rejected malformed calls → endless repair loop. The fix makes the schema
// PERMISSIVE (validation always passes); `tool.execute.before` normalizeActorArgs reshapes the args before execute.
test("tool.definition makes the actor schema PERMISSIVE so malformed calls validate (kills the AI-SDK repair loop)", async () => {
  const h: any = await hooks()
  const z: any = tool.schema
  // a STRICT actor schema like the engine's — it REJECTS the real malformed call (operation as a JSON string + the extra
  // keys output_schema/model the audit model actually sent) — exactly the bug behind the 30-cycle repair loop.
  const strict = typeof z.strictObject === "function"
    ? z.strictObject({ operation: z.object({ action: z.literal("run") }) })
    : z.object({ operation: z.object({ action: z.literal("run") }) }).strict()
  const malformed = { operation: '{"action":"run"}', output_schema: {}, model: "x" }
  expect(() => strict.parse(malformed)).toThrow()                                  // the bug
  const out: any = { description: "Spawn a subagent.", parameters: strict }
  await h["tool.definition"]({ toolID: "actor" }, out)
  // AFTER: the schema is permissive → the SAME malformed call validates (so the AI SDK never enters the repair loop)
  expect(() => out.parameters.parse(malformed)).not.toThrow()
  expect(() => out.parameters.parse({ action: "run", subagent_type: "general", description: "d", prompt: "p" })).not.toThrow() // flat
  expect(() => out.parameters.parse({ operation: { action: "run" } })).not.toThrow()                                          // correct
  // the model is still steered to the right shape via the description (the actual reshaping happens in execute.before)
  expect(out.description).toContain("operation")
})

test("before-hook reshapes a malformed actor call (operation as JSON string + stray keys) into clean {operation}", async () => {
  const h: any = await hooks()
  const out: any = { args: {
    operation: JSON.stringify({ action: "run", subagent_type: "explore", description: "audit", prompt: "find vulns" }),
    output_schema: { type: "object" }, model: "lmstudio/x", timeout_ms: 9,
  } }
  await h["tool.execute.before"]({ tool: "actor", sessionID: "s", callID: "c" }, out)
  expect(Object.keys(out.args)).toEqual(["operation"])           // only operation — output_schema/timeout_ms dropped
  expect(out.args.operation.prompt).toBe("find vulns")
  expect(out.args.operation.subagent_type).toBe("explore")
})

// THE definitive fix proof: the engine validates the model's actor args with the ORIGINAL strict discriminatedUnion
// (tool.ts), NOT the permissive schema it sent the model. So normalizeActorArgs output MUST conform to that
// strict schema for EVERY malformed shape — else the "operation: expected object, received undefined" loop.
test("normalizeActorArgs output ALWAYS conforms to the real STRICT actor schema (kills the validation loop)", () => {
  const z: any = tool.schema
  // subagent_type is a DYNAMIC enum (z.enum(spawnableNames) built from the live agent registry) — we can't
  // replicate the exact runtime set, so validate it as a non-empty string (what our normalizer guarantees;
  // the model itself picks a valid enum member from the schema it's shown).
  const sub = z.string().min(1)
  const runLike = (a: string) => z.strictObject({
    action: z.literal(a), subagent_type: sub, description: z.string().min(1), prompt: z.string().min(1),
    model: z.string().min(1).optional(), actor_id: z.string().min(1).optional(), task_id: z.string().min(1).optional(),
  })
  const STRICT = z.strictObject({
    operation: z.discriminatedUnion("action", [
      runLike("run"), runLike("spawn"),
      z.strictObject({ action: z.literal("status"), actor_id: z.string().min(1) }),
      z.strictObject({ action: z.literal("wait"), actor_id: z.string().min(1), timeout_ms: z.number().optional() }),
      z.strictObject({ action: z.literal("cancel"), actor_id: z.string().min(1) }),
      z.strictObject({ action: z.literal("send"), to_actor_id: z.string().min(1), content: z.string().min(1), to_session_id: z.string().min(1).optional(), type: z.string().optional() }),
    ]),
  })
  const cases: any[] = [
    {},                                                                                   // empty → the exact 'received undefined' bug
    { action: "run", subagent_type: "general", description: "audit", prompt: "find bugs" }, // flat
    { operation: '{"action":"run","subagent_type":"explore","description":"d","prompt":"p"}' }, // operation as JSON string
    { operation: { action: "run", subagent_type: "general", description: "d", prompt: "p" }, model: "x", timeout_ms: 9, output_schema: {} }, // stray top-level keys
    { tasks: [{ x: 1 }], foo: "bar" },                                                    // unrecognized / parallel-ish shape
    { operation: "garbage not json" },                                                    // operation as non-JSON string
    { action: "status", actor_id: "explore-1" },                                          // valid management call
    { action: "status" },                                                                 // management missing handle → falls back to a valid run
    { description: "scan", prompt: "x", subagent_type: "weird" },                         // bad enum → general
    { operation: { action: "send", to_actor_id: "main", content: "hi", type: "text" } },  // send
  ]
  for (const c of cases) {
    const out = normalizeActorArgs(c)
    const r = STRICT.safeParse(out)
    expect(r.success).toBe(true)
  }
})

test("tool.definition leaves non-strict tools untouched", async () => {
  const h: any = await hooks()
  const out2 = { description: "Read a file.", parameters: {} }
  await h["tool.definition"]({ toolID: "view" }, out2)
  expect(out2.description).toBe("Read a file.")
})

// REGRESSION GUARD (the user's "task tool called with invalid arguments" bug): the `task` tool must NOT be run
// through the ACTOR normalizer. Its operations are create:{summary} / start|done:{id} — actor-shaping CORRUPTS them.
test("task create call passes the before-hook UNCORRUPTED (not actor-normalized)", async () => {
  const h: any = await hooks()
  const out: any = { args: { operation: { action: "create", summary: "Deep critical analysis of letsgo" } } }
  await h["tool.execute.before"]({ tool: "task", sessionID: "tk", callID: "c" }, out)
  expect(out.args.operation.action).toBe("create")                       // NOT rewritten to "run"
  expect(out.args.operation.summary).toBe("Deep critical analysis of letsgo") // summary NOT dropped
  expect(out.args.operation.subagent_type).toBeUndefined()               // no actor fields injected
  expect(out.args.operation.prompt).toBeUndefined()
})

test("task start call (id) passes the before-hook uncorrupted", async () => {
  const h: any = await hooks()
  const out: any = { args: { operation: { action: "start", id: "T1" } } }
  await h["tool.execute.before"]({ tool: "task", sessionID: "tk2", callID: "c2" }, out)
  expect(out.args.operation).toEqual({ action: "start", id: "T1" })       // id preserved, nothing injected
})

// CRITICAL LOCK-IN: the installed engine binary validates the ORIGINAL args object
// reference and IGNORES a REPLACED output.args. So the before-hook MUST mutate the SAME object in place. If a
// future edit reverts to `output.args = normalizeActorArgs(...)` (replace), the actor call fails live again
// while a naive test still passes — THIS test guards that by asserting the object reference is preserved.
test("actor before-hook mutates output.args IN PLACE (same object ref) — empty call", async () => {
  const h: any = await hooks()
  const out: any = { args: {} }
  const ref = out.args
  await h["tool.execute.before"]({ tool: "actor", sessionID: "ip1", callID: "c" }, out)
  expect(out.args).toBe(ref)                       // SAME reference — not replaced (binary needs this)
  expect(out.args.operation.action).toBe("run")    // and normalized to a valid operation
})

test("actor before-hook reshapes operation-as-string IN PLACE (same ref, stray key removed)", async () => {
  const h: any = await hooks()
  const out: any = { args: { operation: '{"action":"run","subagent_type":"explore","description":"d","prompt":"p"}', subagent_type: "explore" } }
  const ref = out.args
  await h["tool.execute.before"]({ tool: "actor", sessionID: "ip2", callID: "c" }, out)
  expect(out.args).toBe(ref)                        // same object
  expect(Object.keys(out.args)).toEqual(["operation"]) // stray top-level subagent_type removed in place
  expect(out.args.operation.prompt).toBe("p")
})

test("after-hook caps oversized output before it enters history", async () => {
  process.env.FABULA_TOOL_OUTPUT_CAP = "1000"
  // re-import with fresh module state so the new cap is read
  const mod = await import("../fabula-reliability?cap=1000")
  const h: any = await mod.FabulaReliability({} as any)
  const out = { title: "t", output: "x".repeat(5000), metadata: {} }
  await h["tool.execute.after"]({ tool: "view", sessionID: "z", callID: "c", args: {} }, out)
  expect(out.output.length).toBeLessThan(5000)
  expect(out.output).toContain("tool output truncated")
  delete process.env.FABULA_TOOL_OUTPUT_CAP
})

test("session.deleted drops in-memory state (no crash)", async () => {
  const h: any = await hooks()
  await h["tool.execute.after"]({ tool: "view", sessionID: "d", callID: "c", args: { p: "/a" } },
    { title: "t", output: "R", metadata: {} })
  await h.event({ event: { type: "session.deleted", properties: { sessionID: "d" } } })
  // after drop, a fresh observe on same session starts at allow
  const o = { title: "t", output: "R", metadata: {} }
  await h["tool.execute.after"]({ tool: "view", sessionID: "d", callID: "c", args: { p: "/a" } }, o)
  expect(o.output).toBe("R")
})

// The wedged checkpoint-writer, driven through the REAL plugin hooks rather than the guard class.
//
// Live measurement (2026-07-21): one checkpoint-writer issued the byte-identical call
// `task {"action":"list"}` 456 times in a single session and was never stopped, consuming 62.6M input
// tokens against the main agent's 2.1M — ~97% of the machine. The pure core is unit-tested elsewhere;
// what this asserts is that the wiring actually reaches it, because the reason the loop survived was a
// classification in the core, not a missing hook: the engine triggers tool.execute.before in ONE tool
// path with no agent filter, so a system agent is covered exactly like the main one.
test("a multiplexer's repeated READ is stopped through the real hooks", async () => {
  const h = await hooks()
  const SID = "ses_wiring_mux"
  const ARGS = { action: "list" }
  const SAME = "T1 open\nT2 open"
  let aborted = false
  for (let i = 0; i < 12; i++) {
    // ENGINE SHAPE: input carries no args; the args live on the output object and the hook may rewrite
    // them in place. Driving it any other way tests a call that never happens.
    const beforeOut: any = { args: { ...ARGS } }
    try {
      await h["tool.execute.before"]({ tool: "task", sessionID: SID, callID: "c" }, beforeOut)
    } catch {
      aborted = true // the before-hook THROWS to physically stop the redundant call
      break
    }
    await h["tool.execute.after"](
      { tool: "task", sessionID: SID, callID: "c", args: beforeOut.args },
      { title: "task", output: SAME, metadata: {} },
    )
  }
  expect(aborted).toBe(true)
})

test("CONTROL through the real hooks: a repeated read that KEEPS PRODUCING NEW OUTPUT is never stopped", async () => {
  const h = await hooks()
  const SID = "ses_wiring_progress"
  const ARGS = { action: "list" }
  for (let i = 0; i < 40; i++) {
    const bo: any = { args: { ...ARGS } }
    await h["tool.execute.before"]({ tool: "task", sessionID: SID, callID: "c" }, bo)
    await h["tool.execute.after"](
      { tool: "task", sessionID: SID, callID: "c", args: bo.args },
      { title: "task", output: `T${i} open`, metadata: {} },
    )
  }
  // reaching here without a throw IS the assertion: progress is never punished
  expect(true).toBe(true)
})
