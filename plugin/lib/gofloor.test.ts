// Unit tests for the deterministic Go floor. Fixtures are the REAL output shapes of each tool —
// govulncheck's JSON STREAM (not an array), gosec's string `line` (which can be a range), staticcheck's
// one-object-per-line, and the `file:line:col: msg` text format go vet and NilAway share. A parser
// tested against a shape its tool does not emit proves nothing.
import { describe, expect, test } from "bun:test"
import {
  armsFloor,
  blockingFindings,
  criteriaAuditPrompt,
  criteriaFor,
  FLOOR_MAX_FINDINGS,
  GO_LLM_CRITERIA,
  goFloorBlock,
  goFloorSteer,
  goSourceEdits,
  goToolPath,
  LINTER_COVERED,
  looksGoModule,
  normalizeFindings,
  parseCriteriaFindings,
  parseGolangciLint,
  parseGosec,
  parseGovulncheck,
  parseGoVet,
  parseNilaway,
  parseStaticcheck,
  relativeTo,
  whereOf,
  safeGoTarget,
  severityRank,
  type GoFinding,
} from "./gofloor"
import { current as currentPlatform } from "./platform/index"
const IS_MAC = currentPlatform() === "darwin"

const ROOT = "/repo"
// The engine's marker for a tree edit whose file cannot be named (lib/edittools.ts BASH_EDIT_MARKER).
const MARK = "«bash-tree-edit»"

describe("parseGovulncheck — reachability is the whole point", () => {
  // A real govulncheck -format json run: a stream of distinct top-level objects, not an array.
  const STREAM = [
    '{"config":{"protocol_version":"v1.0.0","scanner_name":"govulncheck"}}',
    '{"progress":{"message":"Scanning your code..."}}',
    '{"osv":{"id":"GO-2024-2687","summary":"HTTP/2 CONTINUATION flood in golang.org/x/net"}}',
    '{"finding":{"osv":"GO-2024-2687","fixed_version":"v0.23.0","trace":[{"module":"golang.org/x/net","package":"golang.org/x/net/http2","function":"processHeaders","position":{"filename":"/repo/internal/api/server.go","line":142,"column":9}}]}}',
    '{"osv":{"id":"GO-2023-1111","summary":"something in an unused dependency"}}',
    '{"finding":{"osv":"GO-2023-1111","trace":[{"module":"example.com/unused"}]}}',
  ].join("\n")

  test("a symbol with a call path is REACHABLE and high", () => {
    const f = parseGovulncheck(STREAM, ROOT)
    const reach = f.find((x) => x.rule === "GO-2024-2687")!
    expect(reach.reachable).toBe(true)
    expect(reach.severity).toBe("high")
    expect(reach.file).toBe("internal/api/server.go") // made repo-relative
    expect(reach.line).toBe(142)
    expect(reach.message).toContain("reachable:")
    expect(reach.message).toContain("processHeaders")
  })

  test("a module-only finding is inventory, not exposure — info and reachable:false", () => {
    const f = parseGovulncheck(STREAM, ROOT)
    const inv = f.find((x) => x.rule === "GO-2023-1111")!
    expect(inv.reachable).toBe(false)
    expect(inv.severity).toBe("info")
    expect(inv.message).toContain("no vulnerable symbol reached")
  })

  test("pretty-printed multi-line JSON objects are parsed too", () => {
    const pretty = `{
  "finding": {
    "osv": "GO-2025-0001",
    "trace": [
      { "module": "m", "package": "p", "function": "F", "position": { "filename": "/repo/a.go", "line": 7 } }
    ]
  }
}`
    const f = parseGovulncheck(pretty, ROOT)
    expect(f).toHaveLength(1)
    expect(f[0]!.reachable).toBe(true)
    expect(f[0]!.line).toBe(7)
  })

  test("garbage and truncation yield fewer findings, never a throw", () => {
    expect(() => parseGovulncheck("not json at all", ROOT)).not.toThrow()
    expect(parseGovulncheck("not json at all", ROOT)).toEqual([])
    expect(parseGovulncheck('{"finding":{"osv":"X","trace":[{"module"', ROOT)).toEqual([])
    expect(parseGovulncheck("", ROOT)).toEqual([])
  })
})

describe("parseGosec", () => {
  const OUT = JSON.stringify({
    Issues: [
      {
        severity: "HIGH",
        confidence: "HIGH",
        rule_id: "G201",
        details: "SQL query construction using format string",
        file: "/repo/store/query.go",
        line: "88",
        column: "12",
      },
      { severity: "LOW", rule_id: "G104", details: "Errors unhandled", file: "/repo/main.go", line: "12-15" },
    ],
    Stats: { files: 3, lines: 900 },
  })

  test("maps severity words and a repo-relative path", () => {
    const f = parseGosec(OUT, ROOT)
    expect(f).toHaveLength(2)
    expect(f[0]).toMatchObject({ tool: "gosec", rule: "G201", severity: "high", file: "store/query.go", line: 88 })
  })

  test("a RANGE line ('12-15') takes the first number — gosec really emits this", () => {
    const f = parseGosec(OUT, ROOT)
    expect(f[1]!.line).toBe(12)
    expect(f[1]!.severity).toBe("low")
  })

  test("gosec never reports reachability, so the field stays absent rather than false", () => {
    for (const f of parseGosec(OUT, ROOT)) expect(f.reachable).toBeUndefined()
  })

  test("malformed input is empty, not a throw", () => {
    expect(parseGosec("{", ROOT)).toEqual([])
    expect(parseGosec(JSON.stringify({ Issues: "nope" }), ROOT)).toEqual([])
  })
})

describe("parseStaticcheck — one JSON object per LINE", () => {
  const OUT = [
    '{"code":"SA1019","severity":"error","location":{"file":"/repo/a.go","line":10,"column":2},"message":"deprecated"}',
    '{"code":"ST1005","severity":"warning","location":{"file":"/repo/b.go","line":3,"column":1},"message":"error strings should not be capitalized"}',
  ].join("\n")

  test("parses each line and maps error/warning", () => {
    const f = parseStaticcheck(OUT, ROOT)
    expect(f).toHaveLength(2)
    expect(f[0]).toMatchObject({ tool: "staticcheck", rule: "SA1019", severity: "high", file: "a.go", line: 10 })
    expect(f[1]!.severity).toBe("medium")
  })
})

describe("parseVetText family (go vet · nilaway)", () => {
  test("go vet's `# package` banner is skipped, findings are parsed", () => {
    const out = "# example.com/m/store\n/repo/store/tx.go:41:9: the cancel function is not used on all paths\n"
    const f = parseGoVet(out, ROOT)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ tool: "go vet", rule: "vet", severity: "medium", file: "store/tx.go", line: 41 })
  })

  test("nil panic lands HIGH — it is the dominant crash class of a Go service", () => {
    const f = parseNilaway("/repo/handler.go:77:2: error: Potential nil panic detected. Observed nil flow from ...", ROOT)
    expect(f[0]).toMatchObject({ tool: "nilaway", rule: "nilness", severity: "high", line: 77 })
  })

  test("non-.go lines and prose are ignored", () => {
    expect(parseGoVet("go: downloading example.com/x v1.2.3\nsome prose\n", ROOT)).toEqual([])
    // A bare "1:2: msg" with no filename is not actionable.
    expect(parseGoVet("1:2: something", ROOT)).toEqual([])
  })

  test("a Windows drive letter does not split the path", () => {
    const f = parseGoVet("C:\\work\\a.go:5:1: bad", undefined)
    expect(f).toHaveLength(1)
    expect(f[0]!.line).toBe(5)
  })
})

describe("parseGolangciLint", () => {
  test("reads FromLinter + Pos", () => {
    const out = JSON.stringify({ Issues: [{ FromLinter: "errcheck", Text: "Error return value is not checked", Pos: { Filename: "/repo/x.go", Line: 22 } }] })
    const f = parseGolangciLint(out, ROOT)
    expect(f[0]).toMatchObject({ tool: "golangci-lint", rule: "errcheck", file: "x.go", line: 22 })
  })
})

describe("relativeTo", () => {
  test("strips the root prefix, leaves foreign paths alone", () => {
    expect(relativeTo("/repo", "/repo/a/b.go")).toBe("a/b.go")
    expect(relativeTo("/repo/", "/repo/a.go")).toBe("a.go")
    expect(relativeTo("/repo", "/other/a.go")).toBe("/other/a.go")
    expect(relativeTo(undefined, "/repo/a.go")).toBe("/repo/a.go")
  })
})

describe("normalizeFindings", () => {
  const mk = (over: Partial<GoFinding>): GoFinding => ({ tool: "gosec", rule: "G1", severity: "medium", file: "a.go", line: 1, message: "m", ...over })

  test("dedupes by tool+rule+file+line", () => {
    const { findings } = normalizeFindings([mk({}), mk({}), mk({ line: 2 })])
    expect(findings).toHaveLength(2)
  })

  test("orders by severity, then file, then line — deterministically", () => {
    const { findings } = normalizeFindings([
      mk({ severity: "low", file: "z.go" }),
      mk({ severity: "critical", file: "m.go" }),
      mk({ severity: "high", file: "b.go" }),
      mk({ severity: "high", file: "a.go" }),
    ])
    expect(findings.map((f) => f.severity)).toEqual(["critical", "high", "high", "low"])
    expect(findings[1]!.file).toBe("a.go")
    // Byte-stable: the same input must give the same order every time.
    const again = normalizeFindings([
      mk({ severity: "low", file: "z.go" }),
      mk({ severity: "critical", file: "m.go" }),
      mk({ severity: "high", file: "b.go" }),
      mk({ severity: "high", file: "a.go" }),
    ])
    expect(again.findings).toEqual(findings)
  })

  test("the cap is applied AND declared — a silent cap reads as full coverage", () => {
    const many = Array.from({ length: FLOOR_MAX_FINDINGS + 7 }, (_, i) => mk({ line: i + 1 }))
    const { findings, dropped } = normalizeFindings(many)
    expect(findings).toHaveLength(FLOOR_MAX_FINDINGS)
    expect(dropped).toBe(7)
  })

  test("junk entries are skipped, not crashed on", () => {
    const { findings } = normalizeFindings([null as any, undefined as any, mk({})])
    expect(findings).toHaveLength(1)
  })
})

describe("blockingFindings — inventory must not block", () => {
  const mk = (over: Partial<GoFinding>): GoFinding => ({ tool: "t", rule: "r", severity: "low", file: "a.go", line: 1, message: "m", ...over })

  test("a REACHABLE advisory blocks even at info severity", () => {
    expect(blockingFindings([mk({ severity: "info", reachable: true })])).toHaveLength(1)
  })

  test("an imported-but-unreached advisory does NOT block", () => {
    expect(blockingFindings([mk({ severity: "info", reachable: false })])).toHaveLength(0)
  })

  test("high and critical block; medium and low do not", () => {
    expect(blockingFindings([mk({ severity: "critical" }), mk({ severity: "high", line: 2 })])).toHaveLength(2)
    expect(blockingFindings([mk({ severity: "medium" }), mk({ severity: "low", line: 2 })])).toHaveLength(0)
  })
})

describe("goFloorBlock — evidence, and honest about its own gaps", () => {
  test("names the tools that ran and marks reachability explicitly", () => {
    const b = goFloorBlock({
      ran: ["govulncheck", "gosec"],
      missing: [],
      dropped: 0,
      findings: [{ tool: "govulncheck", rule: "GO-2024-1", severity: "high", file: "a.go", line: 3, message: "x", reachable: true }],
    })
    expect(b).toContain("govulncheck, gosec")
    expect(b).toContain("[REACHABLE: the vulnerable symbol is actually called]")
    expect(b).toContain("HIGH govulncheck/GO-2024-1 a.go:3")
  })

  test("a MISSING tool is named — a thin floor must not read as a clean one", () => {
    const b = goFloorBlock({ ran: ["go vet"], missing: ["govulncheck", "gosec"], dropped: 0, findings: [] })
    expect(b).toContain("NOT available")
    expect(b).toContain("govulncheck")
    expect(b).toContain("means nothing")
  })

  test("zero findings is stated as narrowing, never as clearing", () => {
    const b = goFloorBlock({ ran: ["gosec"], missing: [], dropped: 0, findings: [] })
    expect(b).toContain("does not clear the change")
  })

  test("a dropped tail is declared", () => {
    const b = goFloorBlock({ ran: ["gosec"], missing: [], dropped: 5, findings: [{ tool: "gosec", rule: "G1", severity: "high", file: "a.go", line: 1, message: "m" }] })
    expect(b).toContain("5 more omitted")
  })

  test("it tells the reviewer to keep comments — stripping them measurably costs detection", () => {
    const b = goFloorBlock({ ran: ["gosec"], missing: [], dropped: 0, findings: [] })
    expect(b).toContain("WITH its comments")
  })

  test("nothing at all → empty string, so a non-Go turn is byte-identical", () => {
    expect(goFloorBlock(undefined)).toBe("")
    expect(goFloorBlock({ ran: [], missing: [], dropped: 0, findings: [] })).toBe("")
  })
})

describe("goFloorSteer", () => {
  const f = (over: Partial<GoFinding> = {}): GoFinding => ({ tool: "gosec", rule: "G201", severity: "high", file: "a.go", line: 9, message: "sqli", ...over })

  test("says NOT YET DONE and lists the program-produced findings", () => {
    const s = goFloorSteer({ ran: ["gosec"], missing: [], dropped: 0, findings: [f()] }, [f()])
    expect(s).toContain("NOT YET DONE")
    expect(s).toContain("HIGH gosec/G201 a.go:9")
    expect(s).toContain("produced by a program")
  })

  test("a long list is capped and the remainder counted", () => {
    const many = Array.from({ length: 14 }, (_, i) => f({ line: i + 1 }))
    const s = goFloorSteer({ ran: ["gosec"], missing: [], dropped: 0, findings: many }, many)
    expect(s).toContain("and 4 more")
  })
})

describe("the division of labour — the part that protects precision", () => {
  test("no criterion is both linter-covered and handed to the model", () => {
    const llm = new Set(GO_LLM_CRITERIA.map((c) => c.slug))
    for (const slug of Object.keys(LINTER_COVERED)) expect(llm.has(slug)).toBe(false)
  })

  test("every LLM criterion is uniquely slugged and carries an fp risk", () => {
    const slugs = GO_LLM_CRITERIA.map((c) => c.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const c of GO_LLM_CRITERIA) expect(["low", "med", "high"]).toContain(c.fp)
  })

  test("criteriaFor filters by area and returns everything by default", () => {
    expect(criteriaFor()).toHaveLength(GO_LLM_CRITERIA.length)
    const tx = criteriaFor(["tx"])
    expect(tx.length).toBeGreaterThan(0)
    for (const c of tx) expect(c.area).toBe("tx")
  })
})

describe("criteriaAuditPrompt", () => {
  const built = () =>
    criteriaAuditPrompt({
      diff: "--- a/x.go\n+++ b/x.go\n+ rows, _ := r.db.Select(...)",
      criteria: criteriaFor(["tx"]),
      floor: { ran: ["gosec"], missing: [], dropped: 0, findings: [{ tool: "gosec", rule: "G201", severity: "high", file: "x.go", line: 1, message: "sqli" }] },
      task: "add a reload",
    })

  test("the floor's evidence precedes the diff, so the reviewer cross-references", () => {
    const user = built()
    expect(user.indexOf("STATIC-ANALYSIS EVIDENCE")).toBeGreaterThan(-1)
    expect(user.indexOf("STATIC-ANALYSIS EVIDENCE")).toBeLessThan(user.indexOf("```diff"))
  })

  test("linter-covered classes are declared OUT OF SCOPE by name", () => {
    const sys = built()
    expect(sys).toContain("OUT OF SCOPE")
    expect(sys).toContain("rowserrcheck")
    expect(sys).toContain("govulncheck")
  })

  test("an unanchored finding is forbidden and 'nothing' is allowed", () => {
    const sys = built()
    expect(sys).toContain("cite a file:line")
    expect(sys).toContain("Reporting nothing is a correct")
  })

  test("the prompt is ONE string — the aux contract takes a string, not a messages array", () => {
    expect(typeof built()).toBe("string")
  })

  test("high-FP criteria are marked ASK rather than asserted", () => {
    const user = criteriaAuditPrompt({ diff: "d", criteria: criteriaFor(["concurrency"]) })
    expect(user).toContain("ASK, do not assert")
  })
})

describe("parseCriteriaFindings", () => {
  test("reads a JSON array, keeps only declared criteria", () => {
    const raw =
      'Thinking about this... [{"criterion":"tx-read-via-pool","file":"store/x.go","line":42,"evidence":"r.db.Select","why":"reads via pool","confidence":"high"},' +
      '{"criterion":"totally-made-up","file":"a.go","line":1,"evidence":"e","why":"w"}]'
    const f = parseCriteriaFindings(raw)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ criterion: "tx-read-via-pool", file: "store/x.go", line: 42, confidence: "high" })
  })

  test("a finding with no file or no line is dropped — an unanchored claim is not a finding", () => {
    expect(parseCriteriaFindings('[{"criterion":"fat-handler","why":"w"}]')).toEqual([])
    expect(parseCriteriaFindings('[{"criterion":"fat-handler","file":"a.go","line":0}]')).toEqual([])
  })

  test("unparseable output reads as no findings, never as a crash", () => {
    expect(parseCriteriaFindings("I could not complete this")).toEqual([])
    expect(parseCriteriaFindings("")).toEqual([])
    expect(() => parseCriteriaFindings(undefined as any)).not.toThrow()
  })

  test("an unknown confidence normalises to medium", () => {
    const f = parseCriteriaFindings('[{"criterion":"n-plus-one","file":"a.go","line":2,"confidence":"absolutely"}]')
    expect(f[0]!.confidence).toBe("medium")
  })
})

describe("scoping — why a non-Go repo pays nothing", () => {
  test("looksGoModule finds go.mod among directory entries", () => {
    expect(looksGoModule(["README.md", "go.mod", "main.go"])).toBe(true)
    expect(looksGoModule(["package.json", "src"])).toBe(false)
    expect(looksGoModule([])).toBe(false)
  })

  test("goSourceEdits keeps real Go source and drops what the author cannot act on", () => {
    expect(
      goSourceEdits([
        "internal/api/handler.go",
        "internal/api/handler_test.go", // test
        "vendor/x/y.go", // vendored
        "mocks/store.go", // generated mocks
        "testdata/fixture.go",
        "api/v1/service.pb.go", // protobuf
        "store/queries_gen.go", // generated
        "README.md",
        "internal/api/handler.go", // duplicate
      ]),
    ).toEqual(["internal/api/handler.go"])
  })

  test("armsFloor: a named Go source edit arms it", () => {
    expect(armsFloor(["internal/a.go"], MARK)).toBe(true)
  })

  test("armsFloor: an UNNAMABLE tree edit arms it — git apply / patch must not be a blind spot", () => {
    // The hole this closes: a model patches Go through the shell, the file cannot be named, and every
    // gate downstream goes blind. The floor analyses the whole module, so it never needed the name.
    expect(armsFloor([MARK], MARK)).toBe(true)
  })

  test("armsFloor: a NAMED non-Go edit does NOT arm it", () => {
    expect(armsFloor(["README.md"], MARK)).toBe(false)
    expect(armsFloor(["store/query_test.go"], MARK)).toBe(false)
    expect(armsFloor(["vendor/x/y.go"], MARK)).toBe(false)
  })

  test("armsFloor: nothing edited arms nothing", () => {
    expect(armsFloor([], MARK)).toBe(false)
    expect(armsFloor(undefined as any, MARK)).toBe(false)
  })

  test("severityRank orders the scale and puts an unknown word last", () => {
    expect(severityRank("critical")).toBeLessThan(severityRank("high"))
    expect(severityRank("low")).toBeLessThan(severityRank("info"))
    expect(severityRank("nonsense" as any)).toBeGreaterThan(severityRank("info"))
  })
})

describe("safeGoTarget — the target reaches an argv, and Go tools take flags anywhere", () => {
  test("real package patterns are accepted", () => {
    expect(safeGoTarget("./...")).toBe("./...")
    expect(safeGoTarget("./internal/...")).toBe("./internal/...")
    expect(safeGoTarget("example.com/m/store")).toBe("example.com/m/store")
    expect(safeGoTarget("  ./...  ")).toBe("./...")
  })

  test("a value starting with '-' is a FLAG and is refused — this is the injection", () => {
    // `go vet -vettool=/tmp/evil ./...` would make the harness execute an arbitrary binary.
    expect(safeGoTarget("-vettool=/tmp/evil")).toBeNull()
    expect(safeGoTarget("-h")).toBeNull()
    expect(safeGoTarget("--help")).toBeNull()
  })

  test("climbing out of the module is refused", () => {
    expect(safeGoTarget("../../etc")).toBeNull()
    expect(safeGoTarget("./a/../../b")).toBeNull()
  })

  test("argv/shell metacharacters are refused even though no shell is involved", () => {
    for (const t of ["a;b", "a|b", "a&b", "a b", "$(id)", "`id`", "a>b", "a*", "a'b", 'a"b'])
      expect(safeGoTarget(t)).toBeNull()
  })

  test("empty, absurdly long, and non-string inputs are refused", () => {
    expect(safeGoTarget("")).toBeNull()
    expect(safeGoTarget("   ")).toBeNull()
    expect(safeGoTarget("x".repeat(301))).toBeNull()
    expect(safeGoTarget(undefined)).toBeNull()
    expect(safeGoTarget(null)).toBeNull()
    expect(safeGoTarget({ evil: true })).toBeNull()
  })
})

describe("REGRESSIONS from the first live run against a real Go module", () => {
  // Everything here is verbatim output observed on 2026-07-30 from real `go vet` 1.26.5 and real
  // staticcheck. Both defects were invisible to the marker-script suite, because a fixture written from
  // the documented format is not the format the tool actually prints.
  test("go vet's `vet: ` driver prefix does not end up in the filename", () => {
    const REAL = "vet: store/query.go:21:2: declared and not used: y"
    const f = parseGoVet(REAL, undefined)
    expect(f).toHaveLength(1)
    expect(f[0]!.file).toBe("store/query.go") // NOT "vet: store/query.go"
    expect(f[0]!.line).toBe(21)
    expect(f[0]!.message).toBe("declared and not used: y")
  })

  test("a nilaway-prefixed line is handled the same way", () => {
    const f = parseNilaway("nilaway: handler.go:7:1: error: Potential nil panic", undefined)
    expect(f[0]!.file).toBe("handler.go")
  })

  test("a path containing a colon is NOT damaged by the prefix strip", () => {
    const f = parseGoVet("weird:dir/a.go:3:1: msg", undefined)
    expect(f).toHaveLength(1)
    expect(f[0]!.file).toBe("weird:dir/a.go")
  })

  test("staticcheck's compile error recovers a location from the message instead of blocking blindly", () => {
    const REAL = '{"code":"compile","severity":"error","location":{"file":"","line":0,"column":0},"message":"# example.com/floorprobe/store store/query.go:21:2: declared and not used: y"}'
    const f = parseStaticcheck(REAL, undefined)
    expect(f).toHaveLength(1)
    expect(f[0]!.file).toBe("store/query.go") // was "" — a blocking finding with nowhere to look
    expect(f[0]!.line).toBe(21)
    expect(f[0]!.message).toContain("does not compile")
    expect(f[0]!.severity).toBe("high")
  })

  test("a normal staticcheck finding keeps its own location, untouched", () => {
    const f = parseStaticcheck('{"code":"SA4006","severity":"error","location":{"file":"/repo/a.go","line":9,"column":2},"message":"value never used"}', ROOT)
    expect(f[0]).toMatchObject({ file: "a.go", line: 9, message: "value never used", rule: "SA4006" })
  })
})

describe("JSON with a human summary after it — the third live defect", () => {
  // Real golangci-lint 2.12.2 prints the JSON document and THEN a summary. JSON.parse over the whole
  // buffer failed on the trailing text, so three real findings silently became zero.
  const REAL_TAIL = JSON.stringify({
    Issues: [
      { FromLinter: "govet", Text: "lostcancel: the cancel function should be called", Pos: { Filename: "store/query.go", Line: 11, Column: 7 } },
      { FromLinter: "ineffassign", Text: "ineffectual assignment to x", Pos: { Filename: "store/query.go", Line: 22, Column: 2 } },
    ],
    Report: { Linters: [{ Name: "errcheck", Enabled: true }] },
  }) + "\n3 issues:\n* govet: 2\n* ineffassign: 1\n"

  test("golangci-lint findings survive the trailing summary", () => {
    const f = parseGolangciLint(REAL_TAIL, undefined)
    expect(f).toHaveLength(2)
    expect(f[0]).toMatchObject({ tool: "golangci-lint", rule: "govet", file: "store/query.go", line: 11 })
    expect(f[1]!.rule).toBe("ineffassign")
  })

  test("gosec gets the same tolerance — a banner or summary around the JSON", () => {
    const withNoise =
      "[gosec] Including rules: default\n" +
      JSON.stringify({ Issues: [{ severity: "HIGH", rule_id: "G201", details: "sqli", file: "/repo/a.go", line: "5" }] }) +
      "\nSummary:\n  Files: 3\n"
    const f = parseGosec(withNoise, ROOT)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ rule: "G201", file: "a.go", line: 5 })
  })

  test("a document with no Issues array is still empty, not a crash", () => {
    expect(parseGolangciLint('{"Report":{"Linters":[]}}\n0 issues.', undefined)).toEqual([])
    expect(parseGosec("no json here at all", ROOT)).toEqual([])
  })
})

describe("whereOf — a fact with no location is not a broken parser", () => {
  test("a module-level advisory says so instead of printing ':0'", () => {
    // Real govulncheck output: four of five advisories for golang.org/x/text carry no file at all,
    // because they are statements about the dependency graph. ":0" read like a parse failure.
    expect(whereOf({ file: "", line: 0 })).toBe("(module-level, no source location)")
  })

  test("a located finding is unchanged", () => {
    expect(whereOf({ file: "store/query.go", line: 42 })).toBe("store/query.go:42")
  })

  test("a file with no line drops the bogus ':0'", () => {
    expect(whereOf({ file: "store/query.go", line: 0 })).toBe("store/query.go")
  })

  test("the evidence block uses it, so no ':0' survives to the reader", () => {
    const b = goFloorBlock({
      ran: ["govulncheck"],
      missing: [],
      dropped: 0,
      findings: [{ tool: "govulncheck", rule: "GO-2020-0015", severity: "info", file: "", line: 0, message: "infinite loop", reachable: false }],
    })
    expect(b).toContain("(module-level, no source location)")
    expect(b).not.toContain(":0")
  })
})

describe("goToolPath — an app launched from Finder inherits no shell PATH", () => {
  // The repo's macOS host prepends ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin and ~/.local/bin —
  // and NEITHER of the two places Go tools live. Without this the floor reports five of six tools
  // missing inside the real application while every terminal test passes.
  test("GOPATH/bin is added (that is where `go install` puts govulncheck, gosec, nilaway)", () => {
    expect(goToolPath({ PATH: "/usr/bin", HOME: "/Users/x" }).split(":")).toContain("/Users/x/go/bin")
  })

  test("the official Go installer's own location is added (that is where `go` itself lives)", () => {
    expect(goToolPath({ PATH: "/usr/bin" }).split(":")).toContain("/usr/local/go/bin")
  })

  test("GOBIN and an explicit GOPATH win over the ~/go default", () => {
    const parts = goToolPath({ PATH: "/usr/bin", GOBIN: "/opt/gobin", GOPATH: "/srv/go", HOME: "/Users/x" }).split(":")
    expect(parts).toContain("/opt/gobin")
    expect(parts).toContain("/srv/go/bin")
    expect(parts).not.toContain("/Users/x/go/bin")
  })

  test("the caller's own PATH stays FIRST — an operator's choice is never overridden", () => {
    expect(goToolPath({ PATH: "/my/tools:/usr/bin", HOME: "/Users/x" }).startsWith("/my/tools:/usr/bin")).toBe(true)
  })

  test("nothing already on PATH is duplicated", () => {
    const p = goToolPath({ PATH: "/usr/local/go/bin:/usr/bin", HOME: "/Users/x" })
    expect(p.split(":").filter((x) => x === "/usr/local/go/bin")).toHaveLength(1)
  })

  // Scoped to the platform whose MECHANISM it asserts — launchd, Seatbelt, Homebrew paths. The
// assertion is unchanged; only where it applies is now stated, the same way this suite already
// scopes its Seatbelt and Docker cases. A suite that fails everywhere it was never about is a
// suite people stop reading.

  test.if(IS_MAC)("an empty environment still yields the documented defaults", () => {
    const parts = goToolPath({}).split(":").filter(Boolean)
    expect(parts).toContain("/usr/local/go/bin")
    expect(parts).toContain("/opt/homebrew/bin")
  })
})
