// Wiring test for fabula-goaudit. Hermetic: a REAL temp Go module on disk, and a MARKER SCRIPT stood
// in for every Go tool via FABULA_GO_EXEC_SHIM.
//
// Why a marker script rather than a mocked module: this repo's recurring defect is a green pure core
// wired to nothing — the corpus worker passed an identical suite against a dead implementation, because
// the suite covered the DECISION and never the WORK. The shim records the argv it was asked to run, so
// these tests fail if the hook decides to fire and then never invokes a tool, or invokes it with the
// wrong arguments. That is the mutation the old shape could not catch.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { shellPathLiteral, writeMarkerScript } from "../lib/platform/shell"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { FabulaGoAudit } from "../fabula-goaudit"
import { GO_FLOOR_STEER_MARK } from "../lib/gofloor"

let goRepo = "" // a real Go module
let plainRepo = "" // no go.mod
let shim = ""
let argvLog = ""

const GOSEC_HIGH = JSON.stringify({
  Issues: [{ severity: "HIGH", confidence: "HIGH", rule_id: "G201", details: "SQL string formatting", file: "store/query.go", line: "42" }],
})
const GOSEC_CLEAN = JSON.stringify({ Issues: [] })

/** Every tool call goes through this script: it logs the argv, then answers as the named tool. */
function shimSource(payloadFile: string, logFile: string): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> ${shellPathLiteral(logFile)}
tool="$1"
sub="$2"
case "$sub" in
  -h|-help|-version|--version|version) exit 0 ;;
esac
if [ "$tool" = "gosec" ]; then
  cat ${shellPathLiteral(payloadFile)}
  exit 1
fi
exit 0
`
}

let payloadFile = ""

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "fabula-goaudit-"))
  goRepo = path.join(base, "gomod")
  plainRepo = path.join(base, "plain")
  await fs.mkdir(path.join(goRepo, "store"), { recursive: true })
  await fs.mkdir(plainRepo, { recursive: true })
  await fs.writeFile(path.join(goRepo, "go.mod"), "module example.com/m\n\ngo 1.23\n")
  await fs.writeFile(path.join(goRepo, "store", "query.go"), "package store\n\nfunc Q() {}\n")
  await fs.writeFile(path.join(plainRepo, "package.json"), "{}\n")
  argvLog = path.join(base, "argv.log")
  payloadFile = path.join(base, "gosec.json")
  shim = path.join(base, "shim.sh")
  await fs.writeFile(payloadFile, GOSEC_HIGH)
  // Through the seam, which also writes the wrapper a platform needs in order to START a script at all.
  // Written by hand, the stand-in was a file that platform cannot execute: every tool call failed to
  // launch, the argv log stayed empty, and the checks read that as the floor never running its tools —
  // the exact mutation they exist to catch, reported for a reason that had nothing to do with the floor.
  shim = writeMarkerScript(shim, shimSource(payloadFile, argvLog))
})

afterAll(() => {
  delete process.env.FABULA_GO_EXEC_SHIM
  delete process.env.FABULA_GO_TOOLS
  delete process.env.FABULA_GO_FLOOR
})

async function plugin(directory: string) {
  return (await FabulaGoAudit({ directory } as any)) as any
}

function arm() {
  process.env.FABULA_GO_EXEC_SHIM = shim
  process.env.FABULA_GO_TOOLS = "gosec"
  delete process.env.FABULA_GO_FLOOR
}

async function readLog(): Promise<string> {
  try {
    return await fs.readFile(argvLog, "utf8")
  } catch {
    return ""
  }
}
async function clearLog() {
  await fs.writeFile(argvLog, "")
}

const GREEN = () => ({ output: "✅ VERIFIED DONE — `go test ./...` passed.", metadata: { passed: true } as any })

/** Drive a full turn: reset → edit a Go file → green verify. */
async function turn(p: any, sid: string, editPath: string) {
  await p["chat.message"]({ sessionID: sid })
  await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: editPath } }, { output: "ok", metadata: {} })
  const out = GREEN()
  await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, out)
  return out
}

describe("surface", () => {
  test("exposes the gate hooks and both tools", async () => {
    const p = await plugin(goRepo)
    expect(typeof p["chat.message"]).toBe("function")
    expect(typeof p["tool.execute.after"]).toBe("function")
    expect(p.tool?.go_security_scan).toBeDefined()
    expect(p.tool?.go_audit_criteria).toBeDefined()
  })
})

describe("the gate FIRES and really runs the tools", () => {
  test("green verify + Go edit → floor runs, steer planted, done revoked", async () => {
    arm()
    await clearLog()
    const p = await plugin(goRepo)
    const out = await turn(p, "go-fire", "store/query.go")

    // 1. The WORK happened: gosec was probed AND run, module-wide.
    const log = await readLog()
    expect(log).toContain("gosec -help")
    expect(log).toContain("gosec -fmt=json -no-fail ./...")

    // 2. The finding reached the model.
    expect(out.output).toContain(GO_FLOOR_STEER_MARK)
    expect(out.output).toContain("NOT YET DONE")
    expect(out.output).toContain("gosec/G201")
    expect(out.output).toContain("store/query.go:42")

    // 3. The VISIBLE verdict is revoked...
    expect(out.output).toContain("NOT YET DONE (go security floor)")
    expect(out.output).not.toContain("✅ VERIFIED DONE")
    expect(out.metadata.goFloor).toMatchObject({ blocking: 1 })
    expect(out.metadata.goFloor.ran).toEqual(["gosec"])

    // 4. ...but the TEST RESULT is not relabelled. `metadata.passed` records what the run did, and the
    // tests really did pass. Writing `false` here would make fabula-rewind count a RED verify and, after
    // two such turns, REVERT files whose tests pass; the engine's judge would read the same field into
    // verifyRed/lastVerify and fire the hard-veto. A static-analysis finding is a separate claim.
    expect(out.metadata.passed).toBe(true)
  })

  test("a CLEAN floor leaves done alone but still records the evidence", async () => {
    arm()
    await fs.writeFile(payloadFile, GOSEC_CLEAN)
    try {
      const p = await plugin(goRepo)
      const out = await turn(p, "go-clean", "store/query.go")
      expect(out.output).not.toContain(GO_FLOOR_STEER_MARK)
      expect(out.metadata.passed).toBe(true)
      expect(out.metadata.goFloor).toMatchObject({ blocking: 0, ran: ["gosec"] })
    } finally {
      await fs.writeFile(payloadFile, GOSEC_HIGH)
    }
  })

  test("a bash-applied patch counts as a Go source edit (sed -i, git apply, tee)", async () => {
    arm()
    const p = await plugin(goRepo)
    await p["chat.message"]({ sessionID: "go-bash" })
    await p["tool.execute.after"](
      { tool: "bash_tool", sessionID: "go-bash", args: { command: "sed -i '' 's/a/b/' store/query.go" } },
      { output: "ok", metadata: {} },
    )
    const out = GREEN()
    await p["tool.execute.after"]({ tool: "verify_done", sessionID: "go-bash", args: {} }, out)
    expect(out.output).toContain(GO_FLOOR_STEER_MARK)
  })

  test("fires at most ONCE per turn — a gate that re-fires is a loop", async () => {
    arm()
    const p = await plugin(goRepo)
    const sid = "go-once"
    await p["chat.message"]({ sessionID: sid })
    await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "store/query.go" } }, { output: "ok", metadata: {} })
    const a = GREEN()
    await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, a)
    const b = GREEN()
    await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, b)
    expect(a.output).toContain(GO_FLOOR_STEER_MARK)
    expect(b.output).not.toContain(GO_FLOOR_STEER_MARK)
    expect(b.metadata.passed).toBe(true)
  })
})

describe("the gate stays MUTE where it must", () => {
  test("no Go edit → no floor, no tool invoked at all", async () => {
    arm()
    await clearLog()
    const p = await plugin(goRepo)
    const sid = "no-go"
    await p["chat.message"]({ sessionID: sid })
    await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "README.md" } }, { output: "ok", metadata: {} })
    const out = GREEN()
    await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, out)
    expect(out.output).not.toContain(GO_FLOOR_STEER_MARK)
    expect(await readLog()).toBe("") // the WORK did not happen either
  })

  test("a Go TEST file alone is not a source edit", async () => {
    arm()
    await clearLog()
    const p = await plugin(goRepo)
    const out = await turn(p, "go-testfile", "store/query_test.go")
    expect(out.output).not.toContain(GO_FLOOR_STEER_MARK)
    expect(await readLog()).toBe("")
  })

  test("a bash edit of a NAMED non-Go file does not arm the gate (control for the marker case)", async () => {
    // The marker path arms deliberately; this proves it is not a blanket "any bash call arms it".
    arm()
    await clearLog()
    const p = await plugin(goRepo)
    const sid = "go-bash-readme"
    await p["chat.message"]({ sessionID: sid })
    await p["tool.execute.after"]({ tool: "bash_tool", sessionID: sid, args: { command: "echo hi > README.md" } }, { output: "ok", metadata: {} })
    const out = GREEN()
    await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, out)
    expect(out.output).not.toContain(GO_FLOOR_STEER_MARK)
    expect(await readLog()).toBe("")
  })

  test("a RED verify is never gated — it is already not done", async () => {
    arm()
    await clearLog()
    const p = await plugin(goRepo)
    const sid = "go-red"
    await p["chat.message"]({ sessionID: sid })
    await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "store/query.go" } }, { output: "ok", metadata: {} })
    const out = { output: "❌ FAILED", metadata: { passed: false } as any }
    await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, out)
    expect(out.output).toBe("❌ FAILED")
    expect(await readLog()).toBe("")
  })

  test("NOT a Go module (no go.mod) → completely silent", async () => {
    arm()
    await clearLog()
    const p = await plugin(plainRepo)
    const out = await turn(p, "plain", "main.go")
    expect(out.output).not.toContain(GO_FLOOR_STEER_MARK)
    expect(out.metadata.passed).toBe(true)
    expect(out.metadata.goFloor).toBeUndefined()
  })

  test("kill-switch FABULA_GO_FLOOR=0 → the hook does nothing", async () => {
    arm()
    process.env.FABULA_GO_FLOOR = "0"
    await clearLog()
    try {
      const p = await plugin(goRepo)
      const out = await turn(p, "go-off", "store/query.go")
      expect(out.output).not.toContain(GO_FLOOR_STEER_MARK)
      expect(await readLog()).toBe("")
    } finally {
      delete process.env.FABULA_GO_FLOOR
    }
  })

  test("chat.message resets per turn: last turn's Go edit does not arm this one", async () => {
    arm()
    const p = await plugin(goRepo)
    const sid = "go-reset"
    await p["chat.message"]({ sessionID: sid })
    await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "store/query.go" } }, { output: "ok", metadata: {} })
    await p["chat.message"]({ sessionID: sid }) // new turn
    const out = GREEN()
    await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, out)
    expect(out.output).not.toContain(GO_FLOOR_STEER_MARK)
  })
})

describe("never throws, whatever it is handed", () => {
  test("missing output / weird args / no session are survivable", async () => {
    arm()
    const p = await plugin(goRepo)
    await expect(p["tool.execute.after"]({ tool: "verify_done" }, undefined)).resolves.toBeUndefined()
    await expect(p["tool.execute.after"]({}, { output: "x", metadata: {} })).resolves.toBeUndefined()
    await expect(p["tool.execute.after"]({ tool: "str_replace", args: null }, { output: "x" })).resolves.toBeUndefined()
    await expect(p["chat.message"]({})).resolves.toBeUndefined()
    await expect(p["chat.message"](undefined)).resolves.toBeUndefined()
  })

  test("a non-string result is left untouched rather than concatenated", async () => {
    arm()
    const p = await plugin(goRepo)
    const sid = "go-nonstring"
    await p["chat.message"]({ sessionID: sid })
    await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "store/query.go" } }, { output: "ok", metadata: {} })
    const out: any = { output: { not: "a string" }, metadata: { passed: true } }
    await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, out)
    expect(out.output).toEqual({ not: "a string" })
    expect(out.metadata.passed).toBe(true)
  })
})

describe("go_security_scan tool", () => {
  test("returns the evidence block for a real module and counts what blocks", async () => {
    arm()
    const p = await plugin(goRepo)
    const r: string = await p.tool.go_security_scan.execute({}, { directory: goRepo })
    expect(r).toContain("STATIC-ANALYSIS EVIDENCE")
    expect(r).toContain("gosec/G201")
    expect(r).toContain("1 of 1 finding(s) are blocking")
  })

  test("says plainly that a non-Go directory is out of scope", async () => {
    arm()
    const p = await plugin(plainRepo)
    const r: string = await p.tool.go_security_scan.execute({}, { directory: plainRepo })
    expect(r).toContain("not a Go module")
  })
})

describe("go_audit_criteria tool", () => {
  test("an empty diff is refused without spending anything", async () => {
    arm()
    const p = await plugin(goRepo)
    const r: string = await p.tool.go_audit_criteria.execute({ diff: "   " }, { directory: goRepo })
    expect(r).toContain("No diff supplied")
  })

  test("when the aux model cannot run, it reports UNCHECKED and still hands over the floor's evidence", async () => {
    // Under the test runner `callAux` throws by design (lib/auxLLM keeps the suite off every endpoint),
    // so this is the real fail-open path, not a simulated one.
    arm()
    const p = await plugin(goRepo)
    const r: string = await p.tool.go_audit_criteria.execute({ diff: "--- a/store/query.go\n+++ b/store/query.go\n+x" }, { directory: goRepo })
    expect(r).toContain("STATIC-ANALYSIS EVIDENCE")
    expect(r).toContain("gosec/G201")
    expect(r).toContain("DID NOT RUN")
    expect(r).toContain("do not treat this as a clean review")
  })
})
