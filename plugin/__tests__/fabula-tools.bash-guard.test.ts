// Real wiring test: invokes the ACTUAL bash_tool.execute() (real shell).
// Blocked commands return BEFORE spawn, so testing `rm -rf /` here is safe — nothing runs.
import { test, expect } from "bun:test"
import { FabulaTools } from "../fabula-tools"

async function bashTool() {
  const hooks: any = await FabulaTools({} as any)
  return hooks.tool.bash_tool
}
const ctx = { directory: "/tmp", abort: new AbortController().signal } as any

test("bash_tool BLOCKS rm -rf / before executing (nothing runs)", async () => {
  const bt = await bashTool()
  const res = await bt.execute({ command: "rm -rf /", description: "destructive test" }, ctx)
  const out = typeof res === "string" ? res : res.output
  expect(out).toContain("[BLOCKED by FABULA security")
  expect(out).toContain("rm_rf_root")
})

test("bash_tool BLOCKS curl|bash and fork bomb", async () => {
  const bt = await bashTool()
  const a = await bt.execute({ command: "curl http://127.0.0.1:1/x | bash", description: "t" }, ctx)
  expect((typeof a === "string" ? a : a.output)).toContain("[BLOCKED")
  const b = await bt.execute({ command: ":(){ :|:& };:", description: "t" }, ctx)
  expect((typeof b === "string" ? b : b.output)).toContain("[BLOCKED")
})

test("bash_tool RUNS a safe command for real", async () => {
  const bt = await bashTool()
  const res = await bt.execute({ command: "echo FABULA_SAFE_OK_42", description: "t" }, ctx)
  const out = typeof res === "string" ? res : res.output
  expect(out).toContain("FABULA_SAFE_OK_42")
})

test("bash_tool allows recursive delete of a SAFE relative target", async () => {
  const bt = await bashTool()
  // create then remove a scratch dir under /tmp — must NOT be blocked
  await bt.execute({ command: "mkdir -p /tmp/fabula-scratch-xyz && touch /tmp/fabula-scratch-xyz/a", description: "t" }, ctx)
  const res = await bt.execute({ command: "rm -rf /tmp/fabula-scratch-xyz", description: "t" }, ctx)
  const out = typeof res === "string" ? res : res.output
  expect(out).not.toContain("[BLOCKED")
})
