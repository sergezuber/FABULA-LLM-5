// Tests for the floor's ORCHESTRATION, driven through the real `runFloor` with `exec` injected.
// This is the half that the pure-parser tests cannot reach: probing, argv construction, the non-zero
// exit that a linter uses to mean "I found something", per-tool timeout, and honest reporting of what
// did not run. A mutation that stops a tool being invoked has to fail here.
import { describe, expect, test } from "bun:test"
import { DEFAULT_FLOOR_TIMEOUT_MS, GO_TOOL_SPECS, floorEnabled, runFloor, selectedTools, type Exec, type ExecResult } from "./gofloorrun"

const OK: ExecResult = { stdout: "", stderr: "", code: 0 }
const NOT_FOUND: ExecResult = { stdout: "", stderr: "command not found", code: null }

/** An exec that records every argv it was asked to run and answers from a table by tool name. */
function fakeExec(answers: Record<string, Partial<ExecResult>>, log: string[][] = []): { exec: Exec; log: string[][] } {
  const exec: Exec = async (argv, opts) => {
    log.push([...argv])
    void opts
    const name = argv[0]!
    const sub = argv[1] ?? ""
    // The probe is the short form; the run is anything else.
    const isProbe = ["-h", "-help", "-version", "--version", "version"].includes(sub)
    const a = answers[name]
    if (a === undefined) return NOT_FOUND
    // A listed tool always PROBES clean — the scenarios under test are about the RUN (findings,
    // non-zero exit, hang), so the probe must not also carry the run's outcome.
    if (isProbe) return OK
    return { ...OK, ...a }
  }
  return { exec, log }
}

describe("selectedTools", () => {
  test("no selection = every tool", () => {
    expect(selectedTools({}, GO_TOOL_SPECS)).toHaveLength(GO_TOOL_SPECS.length)
    expect(selectedTools(undefined, GO_TOOL_SPECS)).toHaveLength(GO_TOOL_SPECS.length)
  })

  test("FABULA_GO_TOOLS narrows it", () => {
    const s = selectedTools({ FABULA_GO_TOOLS: "gosec, govulncheck" }, GO_TOOL_SPECS)
    expect(s.map((x) => x.name).sort()).toEqual(["gosec", "govulncheck"])
  })

  test("an unreadable selection falls back to everything, never to nothing", () => {
    // Silently disabling the whole floor because a name was mistyped is the worst outcome.
    expect(selectedTools({ FABULA_GO_TOOLS: "nosuchtool" }, GO_TOOL_SPECS)).toHaveLength(GO_TOOL_SPECS.length)
    expect(selectedTools({ FABULA_GO_TOOLS: "   " }, GO_TOOL_SPECS)).toHaveLength(GO_TOOL_SPECS.length)
  })
})

describe("runFloor — the wiring", () => {
  test("a tool that is present is PROBED and then RUN with its documented argv", async () => {
    const { exec, log } = fakeExec({ gosec: { stdout: JSON.stringify({ Issues: [] }) } })
    const r = await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "gosec" } })
    expect(r.ran).toEqual(["gosec"])
    expect(log[0]).toEqual(["gosec", "-help"]) // probe
    expect(log[1]).toEqual(["gosec", "-fmt=json", "-no-fail", "./..."]) // run, module-wide
  })

  test("govulncheck is asked for JSON over the whole module — a single file cannot yield reachability", async () => {
    const { exec, log } = fakeExec({ govulncheck: { stdout: "" } })
    await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "govulncheck" } })
    expect(log[1]).toEqual(["govulncheck", "-format", "json", "./..."])
  })

  test("a NON-ZERO exit still has its stdout parsed — that is how a linter reports findings", async () => {
    const issues = JSON.stringify({ Issues: [{ severity: "HIGH", rule_id: "G201", details: "sqli", file: "/repo/a.go", line: "5" }] })
    const { exec } = fakeExec({ gosec: { stdout: issues, code: 1 } })
    const r = await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "gosec" } })
    expect(r.ran).toEqual(["gosec"])
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.rule).toBe("G201")
  })

  test("an absent tool is NAMED in missing, and the rest of the floor still runs", async () => {
    const { exec } = fakeExec({ gosec: { stdout: JSON.stringify({ Issues: [] }) } })
    const r = await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "gosec,govulncheck,staticcheck" } })
    expect(r.ran).toEqual(["gosec"])
    expect(r.missing.sort()).toEqual(["govulncheck", "staticcheck"])
  })

  test("a tool whose RUN times out is reported as timed out, not as clean", async () => {
    const { exec } = fakeExec({ staticcheck: { timedOut: true } })
    const r = await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "staticcheck" }, timeoutMs: 1234 })
    expect(r.ran).toEqual([])
    expect(r.missing[0]).toContain("timed out")
  })

  test("stderr is read for the tools that print findings there (go vet, nilaway)", async () => {
    const exec: Exec = async (argv) => {
      if (argv[1] === "version") return OK
      return { stdout: "", stderr: "# pkg\n/repo/a.go:3:1: lost cancel", code: 1 }
    }
    const r = await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "go vet" } })
    expect(r.ran).toEqual(["go vet"])
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.file).toBe("a.go")
  })

  test("an exec that THROWS degrades that tool only", async () => {
    const exec: Exec = async (argv) => {
      if (["-h", "-help", "-version", "--version", "version"].includes(argv[1] ?? "")) return OK
      throw new Error("boom")
    }
    const r = await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "gosec" } })
    expect(r.ran).toEqual([])
    expect(r.missing[0]).toContain("failed to run")
  })

  test("a probe that HANGS marks the tool missing instead of spending the floor budget", async () => {
    const exec: Exec = async () => ({ stdout: "", stderr: "", code: null, timedOut: true })
    const r = await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "gosec" } })
    expect(r.missing).toEqual(["gosec"])
  })

  test("findings from several tools are merged, deduped and ordered", async () => {
    const exec: Exec = async (argv) => {
      const sub = argv[1] ?? ""
      if (["-h", "-help", "-version", "--version", "version"].includes(sub)) return OK
      if (argv[0] === "gosec") return { stdout: JSON.stringify({ Issues: [{ severity: "LOW", rule_id: "G104", details: "x", file: "/repo/z.go", line: "1" }] }), code: 1 }
      if (argv[0] === "staticcheck") return { stdout: '{"code":"SA1019","severity":"error","location":{"file":"/repo/a.go","line":2},"message":"m"}', code: 1 }
      return OK
    }
    const r = await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "gosec,staticcheck" } })
    expect(r.ran.sort()).toEqual(["gosec", "staticcheck"])
    // staticcheck's "error" → high, so it sorts above gosec's low.
    expect(r.findings.map((f) => f.tool)).toEqual(["staticcheck", "gosec"])
  })

  test("the per-tool budget comes from FABULA_GO_FLOOR_TIMEOUT_MS, else the default", async () => {
    const seen: number[] = []
    const exec: Exec = async (argv, opts) => {
      if (!["-h", "-help", "-version", "--version", "version"].includes(argv[1] ?? "")) seen.push(opts.timeoutMs)
      return OK
    }
    await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "gosec", FABULA_GO_FLOOR_TIMEOUT_MS: "5000" } })
    expect(seen[0]).toBe(5000)
    seen.length = 0
    await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "gosec" } })
    expect(seen[0]).toBe(DEFAULT_FLOOR_TIMEOUT_MS)
  })

  test("an explicit target is honoured", async () => {
    const { exec, log } = fakeExec({ gosec: {} })
    await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "gosec" }, target: "./internal/..." })
    expect(log[1]).toContain("./internal/...")
  })
})

describe("floorEnabled", () => {
  test("default on; FABULA_GO_FLOOR=0 off; read at call time", () => {
    expect(floorEnabled({})).toBe(true)
    expect(floorEnabled({ FABULA_GO_FLOOR: "1" })).toBe(true)
    expect(floorEnabled({ FABULA_GO_FLOOR: "0" })).toBe(false)
    expect(floorEnabled(undefined)).toBe(true)
  })
})

describe("runFloor sanitises the target at the choke point", () => {
  test("a flag-shaped target NEVER reaches the argv — it falls back to the whole module", async () => {
    const { exec, log } = fakeExec({ gosec: {} })
    await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "gosec" }, target: "-vettool=/tmp/evil" })
    const run = log[1]!
    expect(run).not.toContain("-vettool=/tmp/evil")
    expect(run).toContain("./...")
  })

  test("a target climbing out of the module is replaced, not passed through", async () => {
    const { exec, log } = fakeExec({ gosec: {} })
    await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "gosec" }, target: "../../etc" })
    expect(log[1]).toContain("./...")
    expect(log[1]).not.toContain("../../etc")
  })
})

describe("a tool that rejects its OWN arguments is never counted as clean", () => {
  // The sharpest defect the first live run exposed: golangci-lint v2 removed `--out-format`, the call
  // exited on `unknown flag`, stdout was empty, the parser returned [] — and the tool was reported as
  // having RUN with no findings. A tool that never looked at the code must not read as one that found
  // nothing. That is the "thin floor reads as a clean floor" failure this module exists to prevent.
  const USAGE: ExecResult = { stdout: "", stderr: "Error: unknown flag: --out-format", code: 1 }
  const PROBE_FLAGS = ["-h", "-help", "-version", "--version", "version"]
  const isProbe = (argv: readonly string[]) => PROBE_FLAGS.includes(argv[1] ?? "")

  test("golangci-lint falls back to the LEGACY argv when the v2 form is rejected", async () => {
    const calls: string[][] = []
    const exec: Exec = async (argv) => {
      calls.push([...argv])
      if (isProbe(argv)) return OK
      if (argv.includes("--output.json.path")) return USAGE
      return {
        stdout: JSON.stringify({ Issues: [{ FromLinter: "errcheck", Text: "unchecked error", Pos: { Filename: "/repo/a.go", Line: 4 } }] }),
        stderr: "",
        code: 1,
      }
    }
    const r = await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "golangci-lint" } })
    expect(r.ran).toEqual(["golangci-lint"])
    expect(r.findings).toHaveLength(1)
    expect(calls.some((c) => c.includes("--out-format"))).toBe(true) // the retry really happened
  })

  test("when BOTH argv forms are rejected it goes to missing, NOT to ran", async () => {
    const exec: Exec = async (argv) => (isProbe(argv) ? OK : USAGE)
    const r = await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "golangci-lint" } })
    expect(r.ran).toEqual([])
    expect(r.findings).toEqual([])
    expect(r.missing).toHaveLength(1)
    expect(r.missing[0]).toContain("rejected its arguments")
  })

  test("a tool with NO legacy form is refused outright on a usage error", async () => {
    const exec: Exec = async (argv) => (isProbe(argv) ? OK : USAGE)
    const r = await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "gosec" } })
    expect(r.ran).toEqual([])
    expect(r.missing[0]).toContain("rejected its arguments")
  })

  test("golangci-lint is asked for the v2 argv FIRST", async () => {
    const { exec, log } = fakeExec({ "golangci-lint": { stdout: JSON.stringify({ Issues: [] }) } })
    await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "golangci-lint" } })
    expect(log[1]).toEqual(["golangci-lint", "run", "--output.json.path", "stdout", "./..."])
  })

  test("a legacy retry that TIMES OUT is reported, not swallowed", async () => {
    const exec: Exec = async (argv) => {
      if (isProbe(argv)) return OK
      if (argv.includes("--output.json.path")) return USAGE
      return { stdout: "", stderr: "", code: null, timedOut: true }
    }
    const r = await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "golangci-lint" } })
    expect(r.ran).toEqual([])
    expect(r.missing[0]).toContain("rejected its arguments")
  })

  test("a NORMAL run is untouched — the word 'flag' in a finding is not a rejection", async () => {
    const exec: Exec = async (argv) => {
      if (isProbe(argv)) return OK
      return {
        stdout: JSON.stringify({ Issues: [{ severity: "HIGH", rule_id: "G404", details: "weak random; consider a flag to disable", file: "/repo/a.go", line: "2" }] }),
        stderr: "",
        code: 1,
      }
    }
    const r = await runFloor({ dir: "/repo", exec, env: { FABULA_GO_TOOLS: "gosec" } })
    expect(r.ran).toEqual(["gosec"])
    expect(r.findings).toHaveLength(1)
  })
})
