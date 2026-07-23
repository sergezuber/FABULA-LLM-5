import { test, expect } from "bun:test"
import { shouldArm, buildContract, NAMED_TERMINALS } from "./contract"

test("shouldArm: only when the contract declares checkable criteria (fail-silent otherwise)", () => {
  expect(shouldArm(buildContract(true))).toBe(true) // verifiable, no conclusions yet → arm
  expect(shouldArm(buildContract(false))).toBe(false) // not verifiable (chat/opinion) → silent
  expect(shouldArm(undefined)).toBe(false)
  expect(shouldArm(buildContract(true, ["cover all chapters"]))).toBe(true) // real conclusion
  expect(shouldArm({ verifiable: true, conclusions: ["", "  "], criteria: [], terminals: [] })).toBe(false) // only empty conclusions
})

test("buildContract: keeps only non-empty conclusions; NAMED_TERMINALS present", () => {
  const c = buildContract(true, ["give a total", "", "  ", "cover every day"])
  expect(c.conclusions).toEqual(["give a total", "cover every day"])
  expect(c.verifiable).toBe(true)
  expect(c.terminals).toEqual([...NAMED_TERMINALS])
  expect(NAMED_TERMINALS).toContain("no-change")
})
