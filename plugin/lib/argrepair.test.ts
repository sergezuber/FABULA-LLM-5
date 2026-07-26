import { describe, expect, test } from "bun:test"
import { repairArgs } from "./argrepair"

describe("workflow carries the same discriminated-union shape as task and actor", () => {
  test("a flat run payload is wrapped rather than stripped to nothing", () => {
    const out = repairArgs("workflow", { action: "run", script: "export const meta = {}" }).args
    expect(out.operation).toBeDefined()
    expect((out.operation as any).action).toBe("run")
    expect((out.operation as any).script).toContain("export const meta")
  })

  test("an already-correct nested payload is left alone", () => {
    const out = repairArgs("workflow", { operation: { action: "status", run_id: "wf_1" } }).args
    expect((out.operation as any).action).toBe("status")
  })

  test("genuine junk is still stripped, so the wrap is not a hole", () => {
    expect(repairArgs("workflow", { nonsense: 1 }).args.operation).toBeUndefined()
  })
})
