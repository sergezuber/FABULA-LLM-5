// Wiring test: the brainstorm plugin exposes its tool (execution hits the aux model; the prompt/parse
// are unit-tested in lib/brainstorm.test.ts).
import { test, expect } from "bun:test"
import { FabulaBrainstorm } from "../fabula-brainstorm"

test("exposes brainstorm_prototypes tool", async () => {
  const p = (await FabulaBrainstorm({} as any)) as any
  expect(p.tool?.brainstorm_prototypes).toBeDefined()
  expect(typeof p.tool.brainstorm_prototypes.execute).toBe("function")
})
