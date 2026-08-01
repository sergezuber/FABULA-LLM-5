import { describe, expect, test } from "bun:test"
import { repairArgs } from "./argrepair"
import { z } from "zod"

// `workflow` is NOT shaped like task/actor, and believing it was is what broke it. Its schema
// (engine/…/tool/workflow.ts) is z.discriminatedUnion("operation", [...]) over z.strictObject branches
// where `operation` is a STRING LITERAL and the other fields are real siblings. The whitelist
// ["operation"] therefore stripped every sibling: all 6 operations were broken by the repair meant to
// help them. These cases validate against a faithful replica of that schema, so a future edit that
// re-conflates the two shapes fails here rather than in production.
describe("workflow — a FLAT discriminated union, not a nested one", () => {
  const runS = z.strictObject({
    operation: z.literal("run"),
    name: z.string().min(1).optional(),
    script: z.string().min(1).optional(),
    args: z.any().optional(),
    workspace: z.string().optional(),
    async: z.boolean().optional(),
  })
  const WF = z.discriminatedUnion("operation", [
    runS,
    z.strictObject({ operation: z.literal("status"), run_id: z.string().min(1) }),
    z.strictObject({ operation: z.literal("wait"), run_id: z.string().min(1), timeout_ms: z.number().int().positive().optional() }),
    z.strictObject({ operation: z.literal("cancel"), run_id: z.string().min(1) }),
    z.strictObject({ operation: z.literal("resume"), run_id: z.string().min(1) }),
  ])

  const CALLS: any[] = [
    { operation: "run", script: "export const meta = {}", async: false },
    { operation: "run", name: "deep-research" },
    { operation: "status", run_id: "wf_123" },
    { operation: "wait", run_id: "wf_123", timeout_ms: 5000 },
    { operation: "cancel", run_id: "wf_123" },
    { operation: "resume", run_id: "wf_123" },
  ]
  for (const call of CALLS) {
    test(`survives the repair and stays RUNNABLE: ${call.operation}`, () => {
      const out = repairArgs("workflow", call).args
      const parsed = WF.safeParse(out)
      expect(parsed.success).toBe(true)
      // "Parses" is not enough for run: stripped to {operation:"run"} it parses AND the engine then
      // answers "requires either name or script". The measured failure hid behind exactly that.
      if (call.operation === "run") expect(!!(out.name || out.script)).toBe(true)
      if (call.run_id) expect(out.run_id).toBe(call.run_id)
    })
  }

  test("the OTHER spelling of the discriminator is renamed, never wrapped", () => {
    const out = repairArgs("workflow", { action: "run", script: "export const meta = {}" }).args
    expect(out.operation).toBe("run") // a string literal — wrapping produced an object here and zod-FAILED
    expect(out.script).toContain("export const meta")
    expect(WF.safeParse(out).success).toBe(true)
  })

  test("genuine junk is still stripped, so the repair is not a hole", () => {
    expect(repairArgs("workflow", { nonsense: 1 }).args.nonsense).toBeUndefined()
  })
})

// MEASURED 2026-08-01: 7 failures in one day, latest 13:11:44, every one with input exactly
// {"operation":"list"} and the error "Invalid input: expected object, received string → at operation".
// Neither layer covered it — the plugin wrap requires `operation` to be ABSENT, and the engine's
// recoverTaskArgs tries JSON.parse("list"), which throws and leaves the string where it was.
describe("task/actor — a bare action name as the operation value", () => {
  test("{operation:'list'} becomes the nested payload it was meant to be", () => {
    expect(repairArgs("task", { operation: "list" }).args).toEqual({ operation: { action: "list" } })
    expect(repairArgs("actor", { operation: "list" }).args).toEqual({ operation: { action: "list" } })
  })

  test("siblings ride along into the wrapper", () => {
    expect(repairArgs("task", { operation: "create", summary: "ship it" }).args)
      .toEqual({ operation: { action: "create", summary: "ship it" } })
  })

  test("the shapes already handled are unchanged", () => {
    expect(repairArgs("task", { action: "list" }).args).toEqual({ operation: { action: "list" } })
    expect(repairArgs("task", { operation: { action: "list" } }).args).toEqual({ operation: { action: "list" } })
    expect(repairArgs("task", { foo: 1 }).args).toEqual({})
  })
})
