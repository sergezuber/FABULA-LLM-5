import { test, expect } from "bun:test"
import { aggregateCost, formatCostReport } from "./costledger"

test("aggregateCost sums tokens+cost by provider/model", () => {
  const s = aggregateCost([
    { cost: 0.01, tokens: { total: 100 }, modelID: "glm-4.7", providerID: "zai" },
    { cost: 0.02, tokens: { input: 50, output: 30, reasoning: 20 }, modelID: "glm-4.7", providerID: "zai" },
    { cost: 0, tokens: 200, modelID: "qwen", providerID: "lmstudio" },
    { tokens: 0, cost: 0 }, // ignored (no usage)
  ])
  expect(s.calls).toBe(3)
  expect(s.totalTokens).toBe(100 + 100 + 200)
  expect(s.totalCost).toBeCloseTo(0.03, 5)
  expect(s.byModel["zai/glm-4.7"].calls).toBe(2)
  expect(s.byModel["zai/glm-4.7"].tokens).toBe(200)
  expect(s.byModel["lmstudio/qwen"].tokens).toBe(200)
})
test("formatCostReport: empty vs populated", () => {
  expect(formatCostReport(aggregateCost([]), "x")).toContain("no usage")
  const r = formatCostReport(aggregateCost([{ cost: 1, tokens: 10, modelID: "m", providerID: "p" }]), "session")
  expect(r).toContain("p/m")
  expect(r).toContain("$1.0000")
  expect(r).toContain("10 tokens")
})
