// FABULA-LLM-5 — the DETERMINISTIC Go analysis floor: pure core, zero IO.
//
// WHY THIS EXISTS, and it is measured rather than assumed. arXiv:2602.16741 (9,366 trials over
// 8 models + 4,646 defence trials) found that of every defence tried for an AI security reviewer,
// **static-analysis cross-referencing is the best: 96.9% detection, recovering 47% of the model's
// baseline misses**. The same study measured the gap this project lives in — 89-96% detection for
// commercial models vs **53-72% for open-weight ones** — so the weaker the model in the socket, the
// MORE the floor carries. Any model in the socket (RULE #14) therefore reviews Go on top of evidence
// a program produced, never on its reading alone.
//
// Two further findings from that study are encoded here as behaviour, not prose:
//   · adversarial code comments do NOT degrade detection (McNemar p>0.21) — so a diff is reviewed WITH
//     its comments, never sanitised first;
//   · stripping comments HURTS weaker models — so `goFloorBlock` never advises removing them.
//
// And the second measurement that shapes the design, arXiv:2601.19239 (222 real vulnerabilities,
// 24 projects, 385 reports hand-labelled): the dominant cause of BOTH misses and false alarms is
// source/sink specifications that do not match the project's real APIs — 62/64, 64/64 and 64/64 of
// CodeQL's, Semgrep's and KNighter's misses. Average false discovery rate reached 85.3%. Hence the
// division below: a criterion a linter already decides is NEVER handed to a model (zero FP, zero
// tokens), and the model is spent only where no linter can reach.
//
// Facts vs policy: which tools EXIST on the machine is a fact, probed at call time by the plugin.
// Severity ordering, caps and the criterion split are POLICY and live here, named, in one place.

/** Normalised finding — one shape for every tool, so the caller never special-cases a parser. */
export interface GoFinding {
  /** "govulncheck" | "gosec" | "staticcheck" | "nilaway" | "go vet" | "golangci-lint" */
  tool: string
  /** tool-native rule id: GO-2024-1234, G201, SA1019, "nilness", "errcheck". */
  rule: string
  severity: GoSeverity
  /** repository-relative where the tool gave one, else whatever it printed. */
  file: string
  line: number
  message: string
  /**
   * govulncheck ONLY, and it is the single most valuable bit on this type: the vulnerable symbol is
   * actually CALLED from this module (call-graph reachable), not merely present in a dependency.
   * `false` means "the advisory touches a package you import but no vulnerable function is reached".
   * Never synthesised for other tools — absent means "this tool does not answer that question".
   */
  reachable?: boolean
}

export type GoSeverity = "critical" | "high" | "medium" | "low" | "info"

const SEVERITY_ORDER: GoSeverity[] = ["critical", "high", "medium", "low", "info"]

export function severityRank(s: GoSeverity): number {
  const i = SEVERITY_ORDER.indexOf(s)
  return i < 0 ? SEVERITY_ORDER.length : i
}

/** POLICY: how each tool's own severity words map onto ours. Unknown words land on "medium" — a
 *  finding whose severity we cannot read is not thereby harmless. */
function mapSeverity(raw: unknown, fallback: GoSeverity = "medium"): GoSeverity {
  const s = String(raw ?? "").trim().toLowerCase()
  if (!s) return fallback
  if (s === "critical" || s === "crit") return "critical"
  if (s === "high" || s === "error") return "high"
  if (s === "medium" || s === "moderate" || s === "warning" || s === "warn") return "medium"
  if (s === "low" || s === "minor") return "low"
  if (s === "info" || s === "note" || s === "informational" || s === "ignore") return "info"
  return fallback
}

function toLine(raw: unknown): number {
  // gosec reports `line` as a STRING and may give a RANGE ("42-45"); take the first number.
  const m = String(raw ?? "").match(/\d+/)
  return m ? Number(m[0]) : 0
}

function clean(s: unknown, cap = 400): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, cap)
}

/** Absolute path → repository-relative, when the root is known. Purely lexical: no fs, no realpath
 *  (a resolver that touches the filesystem cannot run in a pure core, and an iCloud-backed path can
 *  wedge `realpathSync` — that exact defect is on record in this repo). */
export function relativeTo(root: string | undefined, file: string): string {
  const f = String(file ?? "")
  if (!root) return f
  const r = root.endsWith("/") ? root : root + "/"
  return f.startsWith(r) ? f.slice(r.length) : f
}

// ---------------------------------------------------------------------------------------------
// Parsers. Each takes the tool's raw stdout and NEVER throws: a tool that changed its output
// format, printed a warning banner first, or died mid-stream yields fewer findings, not a crash.
// A parser that throws would turn a broken dependency into a broken agent turn.
// ---------------------------------------------------------------------------------------------

/**
 * `govulncheck -json` — a STREAM of JSON objects (config / progress / osv / finding), not one array.
 * The precision property lives in `trace`: a frame carrying a `function` means a real call path was
 * found, so the advisory is reachable. Module-only findings are kept as `info`/`reachable:false` —
 * they are true facts about the dependency graph, just not evidence that this code is exposed.
 */
export function parseGovulncheck(raw: string, root?: string): GoFinding[] {
  const out: GoFinding[] = []
  const osvSeverity = new Map<string, GoSeverity>()
  const osvSummary = new Map<string, string>()
  for (const obj of jsonStream(raw)) {
    const osv = (obj as any)?.osv
    if (osv && typeof osv === "object" && typeof (osv as any).id === "string") {
      const id = (osv as any).id
      osvSummary.set(id, clean((osv as any).summary || (osv as any).details, 200))
      // OSV severity is optional; Go advisories usually carry none, so absence must not read as low.
      const sev = Array.isArray((osv as any).severity) && (osv as any).severity.length ? "high" : "high"
      osvSeverity.set(id, sev as GoSeverity)
      continue
    }
    const f = (obj as any)?.finding
    if (!f || typeof f !== "object") continue
    const id = typeof (f as any).osv === "string" ? (f as any).osv : ""
    const trace = Array.isArray((f as any).trace) ? (f as any).trace : []
    const called = trace.find((t: any) => t && typeof t.function === "string" && t.function)
    const positioned = trace.find((t: any) => t?.position && typeof t.position.filename === "string")
    const reachable = Boolean(called)
    const where = positioned?.position
    const symbol = called ? `${called.package ?? ""}.${called.function}`.replace(/^\./, "") : (trace[0]?.module ?? "")
    out.push({
      tool: "govulncheck",
      rule: id || "GO-ADVISORY",
      // A reachable advisory is a live exposure; an imported-but-uncalled one is inventory.
      severity: reachable ? osvSeverity.get(id) ?? "high" : "info",
      file: relativeTo(root, where?.filename ?? ""),
      line: toLine(where?.line),
      message:
        (reachable ? "reachable: " : "imported, no vulnerable symbol reached: ") +
        (symbol ? symbol + " — " : "") +
        (osvSummary.get(id) || "see advisory"),
      reachable,
    })
  }
  return out
}

/** `gosec -fmt=json` — one object with `Issues[]`. Severity/confidence are words; `line` is a string. */
export function parseGosec(raw: string, root?: string): GoFinding[] {
  const issues = firstArrayUnder(raw, "Issues")
  if (!issues) return []
  return issues.flatMap((i: any) => {
    if (!i || typeof i !== "object") return []
    return [
      {
        tool: "gosec",
        rule: clean(i.rule_id || i.RuleID || "gosec", 24) || "gosec",
        severity: mapSeverity(i.severity ?? i.Severity, "medium"),
        file: relativeTo(root, i.file ?? i.File ?? ""),
        line: toLine(i.line ?? i.Line),
        message: clean(i.details ?? i.Details),
      } as GoFinding,
    ]
  })
}

/** `staticcheck -f json` — ONE JSON OBJECT PER LINE (not an array). */
export function parseStaticcheck(raw: string, root?: string): GoFinding[] {
  const out: GoFinding[] = []
  for (const obj of jsonStream(raw)) {
    const o = obj as any
    if (!o || typeof o !== "object" || typeof o.code !== "string") continue
    let file = relativeTo(root, o.location?.file ?? "")
    let line = toLine(o.location?.line)
    let message = clean(o.message)
    // OBSERVED on the first live run: a module that does not COMPILE makes staticcheck emit
    // `code:"compile"` with an EMPTY location and the real `file:line:col: reason` inside the message
    // (behind a `# package` banner). Left as-is that is a blocking finding with nowhere to go. The
    // location is recovered from the message so the reader gets somewhere to look.
    if (!file || !line) {
      const m = /([^\s:]+\.go):(\d+)(?::\d+)?:\s*(.+)$/.exec(message)
      if (m) {
        file = relativeTo(root, m[1]!)
        line = Number(m[2])
        message = clean(m[3])
      }
    }
    out.push({
      tool: "staticcheck",
      rule: clean(o.code, 16),
      severity: mapSeverity(o.severity, "medium"),
      file,
      line,
      message: o.code === "compile" ? `does not compile: ${message}` : message,
    })
  }
  return out
}

/** `golangci-lint run --out-format json` — `{Issues:[{FromLinter,Text,Pos:{Filename,Line}}]}`. */
export function parseGolangciLint(raw: string, root?: string): GoFinding[] {
  const issues = firstArrayUnder(raw, "Issues")
  if (!issues) return []
  return issues.flatMap((i: any) => {
    if (!i || typeof i !== "object") return []
    return [
      {
        tool: "golangci-lint",
        rule: clean(i.FromLinter || "golangci", 24) || "golangci",
        severity: mapSeverity(i.Severity, "medium"),
        file: relativeTo(root, i.Pos?.Filename ?? ""),
        line: toLine(i.Pos?.Line),
        message: clean(i.Text),
      } as GoFinding,
    ]
  })
}

// `file:line:col: message` — the Go analysis-driver format shared by `go vet`, NilAway and friends.
// `# package` banner lines and blank lines are skipped. A Windows drive letter ("C:\x.go:4:1: m") is
// handled by requiring the LINE group to be digits, so the colon after the drive letter never splits.
const VET_LINE = /^(.*?):(\d+):(?:(\d+):)?\s*(.+)$/

/**
 * A driver prefix real `go vet` puts in front of the location — `vet: store/query.go:21:2: msg`.
 * OBSERVED, not imagined: the first live run against a real module produced exactly that, and the
 * filename came back as `"vet: store/query.go"` because the prefix was captured into it. Stripped
 * before matching. Kept narrow (a known tool name + colon) so a path that legitimately contains a
 * colon is untouched.
 */
const VET_DRIVER_PREFIX = /^(?:vet|nilaway|staticcheck|go):\s+/

/** Text-format analysis output (`go vet`, NilAway, any `golang.org/x/tools` analyzer). */
export function parseVetText(raw: string, tool: string, root?: string, severity: GoSeverity = "medium"): GoFinding[] {
  const out: GoFinding[] = []
  for (const rawLine of String(raw ?? "").split(/\r?\n/)) {
    const line = rawLine.trim().replace(VET_DRIVER_PREFIX, "")
    if (!line || line.startsWith("#")) continue
    const m = VET_LINE.exec(line)
    if (!m) continue
    const file = m[1]
    // A bare "1:2: x" with no filename is not a finding we can act on.
    if (!file || !/\.go$/i.test(file)) continue
    out.push({
      tool,
      rule: tool === "nilaway" ? "nilness" : "vet",
      severity,
      file: relativeTo(root, file),
      line: Number(m[2]),
      message: clean(m[4]),
    })
  }
  return out
}

/** NilAway text output. Nil panic is the dominant crash class of a Go service, so it lands "high". */
export function parseNilaway(raw: string, root?: string): GoFinding[] {
  return parseVetText(raw, "nilaway", root, "high")
}

export function parseGoVet(raw: string, root?: string): GoFinding[] {
  return parseVetText(raw, "go vet", root, "medium")
}

/**
 * The first top-level JSON object in `raw` carrying `key` as an array.
 *
 * OBSERVED, and the third defect the live run found: real `golangci-lint` prints its JSON document and
 * then a human summary after it (`3 issues:\n* govet: 2 …`). `JSON.parse` over the WHOLE stream fails on
 * that trailing text and yields null, so three real findings silently became zero — a tool reported as
 * having run and found nothing. Scanning for the object instead of parsing the whole buffer tolerates
 * any banner or summary around it, which is what these CLIs actually emit.
 */
function firstArrayUnder(raw: string, key: string): any[] | null {
  for (const v of jsonStream(raw)) {
    const arr = (v as any)?.[key]
    if (Array.isArray(arr)) return arr
  }
  return null
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(String(raw ?? ""))
  } catch {
    return null
  }
}

/** Every top-level JSON value in a stream, tolerating pretty-printed objects, one-per-line objects,
 *  a leading array, and non-JSON banner text around them. Brace/bracket depth aware, string aware. */
function jsonStream(raw: string): unknown[] {
  const s = String(raw ?? "")
  const out: unknown[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === "{" || c === "[") {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (c === "}" || c === "]") {
      depth--
      if (depth === 0 && start >= 0) {
        const v = safeJson(s.slice(start, i + 1))
        if (v !== null) {
          // A top-level array is a container of values, not a value.
          if (Array.isArray(v)) out.push(...v)
          else out.push(v)
        }
        start = -1
      }
      if (depth < 0) depth = 0
      continue
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------------

/** POLICY: how many findings the floor hands onward. A cap is fine; a SILENT cap is not (W6). */
export const FLOOR_MAX_FINDINGS = 40

export interface FloorResult {
  findings: GoFinding[]
  /** tools that actually ran and produced parseable output. */
  ran: string[]
  /** tools that are not installed / declined to run — named, so a thin floor is never mistaken for a clean one. */
  missing: string[]
  /** how many findings were dropped by the cap. */
  dropped: number
}

/** Dedupe by (tool, rule, file, line) and order by severity, then file. Deterministic: same input,
 *  same order, so the block a witness receives is byte-stable across runs. */
export function normalizeFindings(all: readonly GoFinding[], max = FLOOR_MAX_FINDINGS): { findings: GoFinding[]; dropped: number } {
  const seen = new Set<string>()
  const uniq: GoFinding[] = []
  for (const f of all ?? []) {
    if (!f || typeof f !== "object") continue
    const key = `${f.tool}|${f.rule}|${f.file}|${f.line}`
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(f)
  }
  uniq.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.rule.localeCompare(b.rule),
  )
  return { findings: uniq.slice(0, max), dropped: Math.max(0, uniq.length - max) }
}

/** Findings that should stop a "done" claim: a reachable advisory, or anything high/critical.
 *  An imported-but-unreached advisory (`reachable:false`) deliberately does NOT block — blocking on
 *  inventory is how a gate earns the reputation that gets it switched off. */
export function blockingFindings(findings: readonly GoFinding[]): GoFinding[] {
  return (findings ?? []).filter(
    (f) => f && (f.reachable === true || f.severity === "critical" || f.severity === "high"),
  )
}

// ---------------------------------------------------------------------------------------------
// The witness grounding block — the arXiv:2602.16741 mechanism, in text
// ---------------------------------------------------------------------------------------------

/**
 * Render the floor for a reviewer's prompt.
 *
 * This is the +47%-recovered-misses lever, so the block says what a program OBSERVED and marks the
 * reachability distinction explicitly — a reviewer that cannot tell "this vulnerable function is
 * called" from "this package is in go.mod" will rank the two the same. An empty floor is stated as
 * an empty floor: "nothing found" by tools that never ran is not evidence of anything, and the block
 * refuses to imply otherwise.
 */
/**
 * Where a finding points, in words. A module-level advisory genuinely HAS no file — govulncheck reports
 * it against the dependency graph, not a line — and rendering that as `:0` reads like a parser that
 * failed rather than a fact that has no location. Observed on the first live govulncheck run.
 */
export function whereOf(f: Pick<GoFinding, "file" | "line">): string {
  if (!f.file) return "(module-level, no source location)"
  return f.line > 0 ? `${f.file}:${f.line}` : f.file
}

export function goFloorBlock(r: FloorResult | undefined): string {
  if (!r || (!r.ran.length && !r.missing.length)) return ""
  const head = "STATIC-ANALYSIS EVIDENCE (produced by programs, outside the conversation — do not re-derive it):"
  const lines: string[] = []
  if (r.ran.length) lines.push(`- tools that ran: ${r.ran.join(", ")}`)
  if (r.missing.length)
    lines.push(
      `- tools NOT available here: ${r.missing.join(", ")} — their classes of defect were NOT checked, so absence of a finding from them means nothing`,
    )
  if (!r.findings.length) {
    lines.push("- no findings from the tools that ran. This narrows the classes those tools cover; it does not clear the change.")
  } else {
    lines.push(`- ${r.findings.length} finding(s)${r.dropped > 0 ? ` (${r.dropped} more omitted by the ${FLOOR_MAX_FINDINGS}-item cap)` : ""}:`)
    for (const f of r.findings) {
      const reach =
        f.reachable === true ? " [REACHABLE: the vulnerable symbol is actually called]" : f.reachable === false ? " [imported only, no call path found]" : ""
      lines.push(`  · ${f.severity.toUpperCase()} ${f.tool}/${f.rule} ${whereOf(f)} — ${f.message}${reach}`)
    }
  }
  lines.push(
    "Cross-reference the diff against these findings: a defect a tool already located needs confirming, not rediscovering, " +
      "and a claim contradicting a tool needs a reason. Read the code WITH its comments — comments do not fool this check, " +
      "and removing them measurably costs detection.",
  )
  return [head, ...lines].join("\n")
}

// ---------------------------------------------------------------------------------------------
// The division of labour: what a linter decides, and what only a reader can
// ---------------------------------------------------------------------------------------------

/**
 * Criteria a Go linter already decides, with near-zero false positives. Spending a model on these is
 * pure waste AND a precision risk: the linter is right, the model might not be. The floor runs these;
 * the model is never asked about them.
 */
export const LINTER_COVERED: Readonly<Record<string, string>> = Object.freeze({
  "missing-rows-err": "rowserrcheck",
  "missing-rows-close": "sqlclosecheck",
  "resp-body-not-closed": "bodyclose",
  "missing-defer-cancel": "go vet (lostcancel)",
  "mutex-by-value": "go vet (copylocks)",
  "loopvar-capture": "go vet (loopclosure)",
  "noctx-http": "noctx",
  "ctx-in-struct": "containedctx",
  "ctx-not-first-arg": "revive",
  "sql-sprintf-injection": "gosec (G201/G202)",
  "abbrev-case": "staticcheck (ST1003)",
  "errcheck-ignored": "errcheck",
  "struct-field-align": "govet (fieldalignment)",
  "nil-deref": "nilaway",
  "known-cve": "govulncheck",
})

/** A criterion no linter reaches: it needs the project's own intent, not a syntactic pattern.
 *  `fp` is the measured-in-practice false-positive risk — a "high" criterion must be phrased as a
 *  question and gated on context, or it collapses precision (the 85.3% FDR failure mode). */
export interface GoCriterion {
  slug: string
  area: "tx" | "concurrency" | "observability" | "error" | "security" | "api" | "perf" | "testing" | "style"
  rule: string
  fp: "low" | "med" | "high"
}

/**
 * The LLM-only half. Derived from a Go review taxonomy built for a real Go backend and kept here
 * because it is the part of a security audit no Go linter can take: each of these needs the
 * project's own intent, and none is a syntactic pattern.
 */
export const GO_LLM_CRITERIA: readonly GoCriterion[] = Object.freeze([
  { slug: "tx-read-via-pool", area: "tx", rule: "inside a tx-bound method every DB read goes through the passed executor, not the pool (r.db) — READ COMMITTED hides the uncommitted write from another connection", fp: "med" },
  { slug: "http-call-in-tx", area: "tx", rule: "no outbound HTTP call inside an open transaction (it holds locks for the round trip)", fp: "low" },
  { slug: "missing-for-update", area: "concurrency", rule: "a concurrently updated row is selected FOR UPDATE (or guarded by optimistic locking) before the update", fp: "high" },
  { slug: "rowsaffected-unchecked", area: "tx", rule: "a write checks RowsAffected() and reports the zero case instead of assuming success", fp: "med" },
  { slug: "unbounded-query", area: "perf", rule: "a query that can grow with data carries a LIMIT from the contract, not an unbounded load into memory", fp: "high" },
  { slug: "n-plus-one", area: "perf", rule: "no query per row inside a loop where a batch / IN / join is available", fp: "med" },
  { slug: "silent-skip-no-log", area: "observability", rule: "an `if exists` early return logs the skip — a silent branch is a silent data loss", fp: "high" },
  { slug: "log-without-ctx", area: "observability", rule: "logging carries ctx so trace id survives (the *Context methods), not a bare log.Info", fp: "med" },
  { slug: "duplicate-span", area: "observability", rule: "no span created in a use-case when controller middleware already opened one", fp: "high" },
  { slug: "span-not-ended", area: "observability", rule: "every StartSpan is followed by defer span.End()", fp: "low" },
  { slug: "goroutine-leak-unbuffered", area: "concurrency", rule: "a send on an unbuffered channel cannot outlive an early return — that leaks the goroutine forever", fp: "high" },
  { slug: "panic-across-goroutine", area: "concurrency", rule: "every `go` statement has its own recover — a recover only catches its own goroutine", fp: "med" },
  { slug: "nil-channel-block", area: "concurrency", rule: "no send/recv on a channel that can still be nil (an uninitialised struct field blocks forever)", fp: "med" },
  { slug: "errgroup-no-limit", area: "concurrency", rule: "errgroup use sets SetLimit — without it concurrency is unbounded", fp: "med" },
  { slug: "errgroup-first-error", area: "concurrency", rule: "Wait() returning only the first error is acceptable here, or the errors are aggregated", fp: "med" },
  { slug: "typed-nil-in-iface", area: "error", rule: "a typed nil pointer is not returned as an error interface (it compares != nil)", fp: "med" },
  { slug: "err-w-to-v", area: "error", rule: "wrapping uses %w, not %v/%s, so errors.Is/As still work", fp: "med" },
  { slug: "over-wrapping", area: "error", rule: "no wrapping that adds no new context at every layer", fp: "high" },
  { slug: "err-leak-to-client", area: "security", rule: "a raw internal or DB error is never returned to the client", fp: "med" },
  { slug: "fat-handler", area: "api", rule: "the handler stays thin: map to DTO, call the use-case, map back — no business logic or hand-rolled validation", fp: "high" },
  { slug: "map-order-in-api", area: "api", rule: "nondeterministic map iteration order does not leak into an API response", fp: "high" },
  { slug: "ctx-value-control", area: "api", rule: "context.Value informs (trace, logging) and never drives business logic", fp: "med" },
  { slug: "kafka-commit-before-process", area: "tx", rule: "the offset is committed AFTER successful processing, not before (at-least-once)", fp: "med" },
  { slug: "kafka-non-idempotent", area: "tx", rule: "the consumer deduplicates by an idempotency key — redelivery is guaranteed", fp: "med" },
  { slug: "large-array-slice-leak", area: "perf", rule: "a sub-slice kept long-term is copied, so it does not pin the whole backing array", fp: "high" },
  { slug: "syncpool-no-reset", area: "perf", rule: "an object from sync.Pool.Get() is Reset() before use — it carries the previous user's data", fp: "med" },
  { slug: "json-int64-precision", area: "api", rule: "a large int64 crossing JSON to a JS client is tagged json:\",string\"", fp: "med" },
  { slug: "metric-chan-blocks-req", area: "perf", rule: "a log/metric channel is buffered and drops on full — it never blocks the request path", fp: "med" },
  { slug: "gomaxprocs-cgroup", area: "perf", rule: "GOMAXPROCS respects the cgroup quota (automaxprocs), not the host core count", fp: "low" },
])

/** The criteria worth asking about for a given diff, hardest-to-fake first. `fp:\"high\"` criteria are
 *  included but must be asked as questions — see `criteriaAuditPrompt`. */
export function criteriaFor(areas?: readonly GoCriterion["area"][]): GoCriterion[] {
  if (!areas || !areas.length) return [...GO_LLM_CRITERIA]
  const want = new Set(areas)
  return GO_LLM_CRITERIA.filter((c) => want.has(c.area))
}

/**
 * The prompt for the LLM half. Deliberate shape, each line paying for a measured failure:
 *   · the floor's findings go in FIRST, so the model cross-references instead of re-deriving (+47%);
 *   · linter-covered classes are named as OUT OF SCOPE, so tokens are not spent where FP is already 0;
 *   · every answer must cite file:line from the diff — the 85.3%-FDR failure mode is a plausible
 *     claim with no anchor;
 *   · "no finding" is an allowed, first-class answer, because a gate that rewards output invents it.
 */
export function criteriaAuditPrompt(input: {
  diff: string
  criteria: readonly GoCriterion[]
  floor?: FloorResult
  task?: string
}): string {
  const crits = input.criteria.map((c) => `- ${c.slug}${c.fp === "high" ? " (ASK, do not assert: high false-positive risk)" : ""}: ${c.rule}`).join("\n")
  const covered = Object.entries(LINTER_COVERED)
    .map(([slug, by]) => `${slug} (${by})`)
    .join(", ")
  // ONE string, because that is what `callAux` takes (lib/auxLLM.ts) and what every other prompt builder
  // in this repo returns. A messages array here would be a second convention for the same job.
  const instructions =
    "You review a Go change against a fixed list of criteria that no linter can decide. " +
    "For each criterion you report, you MUST cite a file:line that appears in the diff and quote the " +
    "line that violates it. A criterion you cannot anchor in the diff is NOT reported. " +
    "Reporting nothing is a correct and expected outcome — do not manufacture a finding to fill the form.\n" +
    `OUT OF SCOPE (a linter already decides these; ignore them entirely): ${covered}.\n` +
    "Answer as a JSON array, one object per finding: " +
    '{"criterion":"<slug>","file":"<path>","line":<n>,"evidence":"<the offending line>","why":"<one sentence>","confidence":"high|medium|low"}. ' +
    "Empty array if nothing is anchored."
  const floor = goFloorBlock(input.floor)
  return (
    instructions +
    "\n\n" +
    (input.task ? `What the change is meant to do:\n${input.task}\n\n` : "") +
    (floor ? floor + "\n\n" : "") +
    `Criteria to check:\n${crits}\n\n` +
    "Go diff under review (read it WITH its comments):\n\n```diff\n" +
    input.diff +
    "\n```"
  )
}

/** Parse the criteria answer. Tolerant by design: a reasoning model emits prose around the array, and
 *  a run that returns nothing parseable must read as "no findings", never as a crash. */
export function parseCriteriaFindings(text: string): { criterion: string; file: string; line: number; evidence: string; why: string; confidence: string }[] {
  const out: { criterion: string; file: string; line: number; evidence: string; why: string; confidence: string }[] = []
  const slugs = new Set(GO_LLM_CRITERIA.map((c) => c.slug))
  for (const v of jsonStream(String(text ?? ""))) {
    const o = v as any
    if (!o || typeof o !== "object" || Array.isArray(o)) continue
    const criterion = clean(o.criterion ?? o.slug, 64)
    // Only a declared criterion counts. An invented one is the model widening its own scope.
    if (!slugs.has(criterion)) continue
    const file = clean(o.file ?? o.path, 300)
    const line = toLine(o.line)
    if (!file || !line) continue
    out.push({
      criterion,
      file,
      line,
      evidence: clean(o.evidence ?? o.code, 300),
      why: clean(o.why ?? o.reason ?? o.message, 300),
      confidence: mapConfidence(o.confidence),
    })
  }
  return out
}

function mapConfidence(raw: unknown): string {
  const s = String(raw ?? "").toLowerCase()
  return s === "high" || s === "medium" || s === "low" ? s : "medium"
}

// ---------------------------------------------------------------------------------------------
// Gate text
// ---------------------------------------------------------------------------------------------

export const GO_FLOOR_STEER_MARK = "🛡️ GO SECURITY FLOOR"

/** The steer planted on a green verify when the deterministic floor is not clean. States the facts and
 *  the one required next action; never asserts a verdict the floor did not produce. */
export function goFloorSteer(r: FloorResult, blocking: readonly GoFinding[]): string {
  const lines = blocking
    .slice(0, 10)
    .map((f) => `  · ${f.severity.toUpperCase()} ${f.tool}/${f.rule} ${whereOf(f)} — ${f.message}${f.reachable === true ? " [REACHABLE]" : ""}`)
  const more = blocking.length > 10 ? `\n  · …and ${blocking.length - 10} more` : ""
  return (
    `\n\n${GO_FLOOR_STEER_MARK} — NOT YET DONE. The tests passed, but Go static analysis ran on this change ` +
    `and did not come back clean:\n${lines.join("\n")}${more}\n` +
    `Tools that ran: ${r.ran.join(", ") || "none"}.${r.missing.length ? ` Not available: ${r.missing.join(", ")}.` : ""}\n` +
    `Each line above was produced by a program, not inferred — fix it or, if it is genuinely not a defect here, ` +
    `say which line and why in one sentence. A REACHABLE advisory means the vulnerable function is actually called ` +
    `by this module, not merely present in go.mod.`
  )
}

/**
 * PATH the Go analysers are actually reachable on.
 *
 * WHY THIS EXISTS, and it is the difference between "works in my terminal" and "works for the owner":
 * an app launched from Finder does NOT inherit the shell PATH — a gotcha this repo already pays for with
 * `PATH_PREFIX` in the macOS host. That prefix covers `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`
 * and `~/.local/bin`, and covers NEITHER of the two places Go tools actually live: `go install` puts them
 * in `$GOBIN` / `$GOPATH/bin` (default `~/go/bin`), and the official Go installer puts `go` itself in
 * `/usr/local/go/bin`. Without this the floor would report five of six tools missing inside the real
 * application while passing every test in a terminal — a false "we checked" wearing the costume of a
 * thin floor.
 *
 * Deliberately NOT resolved by shelling out to `go env GOPATH`: that needs `go` on PATH first, which is
 * the very thing being fixed. The documented defaults are used instead, and the caller's own PATH always
 * wins by staying in front of nothing — these are appended AFTER it, so an operator's explicit choice is
 * never overridden.
 */
export function goToolPath(env: Record<string, string | undefined>, home?: string): string {
  const h = home ?? env.HOME ?? ""
  const extra = [
    env.GOBIN,
    env.GOPATH ? `${env.GOPATH}/bin` : h ? `${h}/go/bin` : undefined,
    "/usr/local/go/bin", // the official Go installer's own location for `go`
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter((p): p is string => Boolean(p))
  const current = env.PATH ? env.PATH.split(":") : []
  const seen = new Set(current)
  const appended = extra.filter((p) => !seen.has(p) && !seen.has(p.replace(/\/$/, "")))
  return [...current, ...appended].join(":")
}

/**
 * Did the tool reject its OWN arguments rather than analyse anything?
 *
 * OBSERVED, and it is the sharpest defect the live run found: golangci-lint v2 removed `--out-format`,
 * so the documented argv exited on `unknown flag`, stdout was empty, the parser returned `[]` — and the
 * tool was reported as having RUN CLEAN. A tool that never looked at the code must never read as a tool
 * that found nothing; that is the "thin floor reads as a clean floor" failure this module exists to
 * avoid, committed by this module. Keyed on the shape every CLI uses for a usage error, so the next
 * flag rename in any of the six tools degrades honestly instead of silently.
 */
export function looksLikeUsageError(text: string): boolean {
  const t = String(text ?? "").slice(0, 4000).toLowerCase()
  if (!t) return false
  return (
    /\bunknown flag\b/.test(t) ||
    /\bflag provided but not defined\b/.test(t) ||
    /\bunknown shorthand flag\b/.test(t) ||
    /\bunrecognized (?:option|flag)\b/.test(t) ||
    /\binvalid (?:option|flag)\b/.test(t) ||
    /\bunknown option\b/.test(t)
  )
}

/**
 * Validate a caller-supplied Go analysis target, returning null when it is not one.
 *
 * WHY THIS EXISTS: the target lands in the analyser's argv, and Go tools accept flags in ANY position —
 * so a target beginning with `-` is not a package pattern, it is a flag. `go vet -vettool=/tmp/x` would
 * make the harness execute an arbitrary binary. There is no shell in the path (spawn takes an argv
 * array, so quoting cannot save or damn us) and that is exactly why the check must be on the VALUE:
 * the argv position is real regardless of shell. Accepts only Go package patterns —
 * `./...`, `./internal/...`, `example.com/m/pkg` — and refuses anything else, including a path that
 * climbs out with `..`.
 */
export function safeGoTarget(raw: unknown): string | null {
  const t = String(raw ?? "").trim()
  if (!t || t.length > 300) return null
  if (t.startsWith("-")) return null // a flag, not a target — the injection this guards
  // No climbing out of the module. Checked per SEGMENT, not as a substring: Go's own recursive wildcard
  // is `...`, so a substring test for ".." rejects the most common legitimate target there is — `./...`.
  if (t.split("/").some((seg) => seg === "..")) return null
  // Package patterns: dot-slash relative, or an import path; slashes, dots, dashes, underscores, `...`
  if (!/^(?:\.\/)?[A-Za-z0-9_.\-/]*(?:\.\.\.)?$/.test(t)) return null
  // Reject shell/argv metacharacters outright even though no shell is involved — a target carrying them
  // is not a package pattern, so accepting it could only ever be a mistake.
  if (/[\s;|&$`'"<>(){}\[\]*?!#~=]/.test(t)) return null
  return t
}

/** Is this a Go module at all? Cheap, lexical, and the reason the whole plugin stays silent elsewhere. */
export function looksGoModule(entries: readonly string[]): boolean {
  return (entries ?? []).some((e) => {
    const b = String(e ?? "").replace(/\\/g, "/").split("/").pop()
    return b === "go.mod"
  })
}

/**
 * Should the floor arm for this turn's edit units?
 *
 * Two ways in, and the second is the one that matters. A NAMED Go source edit is obvious. But a tree
 * edit whose file cannot be named — `git apply`, `patch < diff`, a `sed -i` form whose target the
 * detector cannot extract — arrives as `BASH_EDIT_MARKER`, and dropping it would leave exactly the hole
 * this repo already paid for once: "a model routinely patches via the shell and stops", and every gate
 * downstream went blind. Since the floor analyses the whole MODULE, it never needed the filename; so an
 * unnamable tree edit inside a Go module arms it. Conservative on purpose — the cost of a false arm is
 * one bounded, once-per-turn analysis run; the cost of a false miss is an ungated "done".
 */
export function armsFloor(units: readonly string[], bashEditMarker: string): boolean {
  if (!units?.length) return false
  if (goSourceEdits(units).length > 0) return true
  return units.includes(bashEditMarker)
}

/** Go source files among a set of edited paths — vendored, generated and test files excluded, because
 *  a finding the author cannot act on is noise. */
export function goSourceEdits(paths: readonly string[]): string[] {
  const out: string[] = []
  for (const p of paths ?? []) {
    const f = String(p ?? "").replace(/\\/g, "/")
    if (!/\.go$/i.test(f)) continue
    if (/(^|\/)vendor\//.test(f)) continue
    if (/(^|\/)(mocks?|testdata)\//.test(f)) continue
    if (/_test\.go$/i.test(f)) continue
    if (/\.pb\.go$|_gen\.go$|\.gen\.go$|_generated\.go$/i.test(f)) continue
    out.push(f)
  }
  return [...new Set(out)]
}
