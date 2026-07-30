import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  discoverCorpus,
  planBatches,
  chapterSummaryPrompt,
  synthTokensFor,
  synthesizeReportPrompt,
  cleanAnswer,
  ANALYST_PREAMBLE,
  ASK_LABEL,
  askLine,
  corpusBudgets,
  accumulatorKey,
  readAccumulator,
  writeAccumulator,
  seedAccumulator,
  markDone,
  pendingBatches,
  doneSummaries,
  clearAccumulator,
  type CorpusFile,
  emptyBatchCount,
  chapterSummaryPrompt,
  MAP_PREAMBLE, synthesizeWithFallback, groupSummaries, DEFAULT_SYNTH_TOKENS_MAX } from "./corpus"

// ── test workspace helpers ─────────────────────────────────────────────────

let CWD = ""
let ACC_DIR = ""

function makeFile(dir: string, name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}
function file(path: string, name: string): CorpusFile { return { path, name } }

beforeEach(() => {
  CWD = mkdtempSync("corpus-cwd-")
  ACC_DIR = mkdtempSync("corpus-acc-")
  process.env.XDG_DATA_HOME = ACC_DIR
})
afterEach(() => {
  rmSync(CWD, { recursive: true, force: true })
  rmSync(ACC_DIR, { recursive: true, force: true })
  delete process.env.XDG_DATA_HOME
})
function mkdtempSync(prefix: string): string {
  const d = join(tmpdir(), `${prefix}${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(d, { recursive: true })
  return d
}

// ── discoverCorpus ─────────────────────────────────────────────────────────

describe("discoverCorpus", () => {
  test("empty dir → no files, fallback true", () => {
    const d = discoverCorpus(CWD)
    expect(d.files.length).toBe(0)
    expect(d.fallback).toBe(true)
  })
  test("picks up .md and .txt, sorted by name (numeric-aware)", () => {
    makeFile(CWD, "глава_10.md", "# Глава 10")
    makeFile(CWD, "глава_02.md", "# Глава 2")
    makeFile(CWD, "глава_01.md", "# Глава 1")
    const d = discoverCorpus(CWD)
    expect(d.files.map((f) => f.name)).toEqual(["глава_01.md", "глава_02.md", "глава_10.md"])
    expect(d.matched).toBe(3)
    expect(d.fallback).toBe(false)
  })
  test("filters to chapter-pattern matches when present", () => {
    makeFile(CWD, "глава_01.md", "# Глава 1")
    makeFile(CWD, "README.md", "# project readme") // no chapter marker in name or head
    const d = discoverCorpus(CWD)
    expect(d.files.map((f) => f.name)).toEqual(["глава_01.md"])
    expect(d.matched).toBe(1)
    expect(d.fallback).toBe(false)
  })
  test("falls open to ALL .md/.txt when NONE match the pattern (chapter names are 01.md, no marker)", () => {
    makeFile(CWD, "01.md", "first segment of the story") // no chapter marker in name or head
    makeFile(CWD, "02.md", "second segment of the story")
    const d = discoverCorpus(CWD)
    expect(d.files.length).toBe(2)
    expect(d.matched).toBe(0)
    expect(d.fallback).toBe(true) // never strand a real corpus
  })
  test("ignores hidden dirs (.git, node_modules) and recurses into subdirs", () => {
    makeFile(CWD, "глава_01.md", "# Глава 1")
    const sub = join(CWD, "part2")
    mkdirSync(sub)
    makeFile(sub, "глава_02.md", "# Глава 2")
    mkdirSync(join(CWD, ".git")); makeFile(join(CWD, ".git"), "config.md", "git stuff")
    mkdirSync(join(CWD, "node_modules")); makeFile(join(CWD, "node_modules"), "x.md", "nm")
    const d = discoverCorpus(CWD)
    expect(d.files.map((f) => f.name).sort()).toEqual(["глава_01.md", "глава_02.md"])
  })
  test("matches chapter marker in the first line too, not just filename", () => {
    makeFile(CWD, "intro.txt", "Глава первая\n...")
    const d = discoverCorpus(CWD)
    expect(d.matched).toBe(1)
    expect(d.fallback).toBe(false)
  })
})

// ── planBatches ────────────────────────────────────────────────────────────

describe("planBatches", () => {
  test("groups by maxFiles (default 4)", () => {
    const files = Array.from({ length: 9 }, (_, i) => {
      const name = `p${i}.md`
      return file(join(CWD, name), name) // path in temp CWD, NOT repo root
    })
    files.forEach((f) => writeFileSync(f.path, "x")) // real files so size reads don't throw
    const b = planBatches(files)
    expect(b.length).toBe(3) // 4 + 4 + 1
    expect(b[0].length).toBe(4)
    expect(b[2].length).toBe(1)
  })
  test("a single huge file becomes its own batch (respects maxBatchChars)", () => {
    makeFile(CWD, "huge.md", "x".repeat(80000))
    makeFile(CWD, "tiny.md", "y")
    const files = discoverCorpus(CWD).files
    const b = planBatches(files, { maxFiles: 4, maxBatchChars: 60000 })
    // huge alone (80k > 60k), then tiny
    expect(b.length).toBe(2)
    expect(b[0][0].name).toBe("huge.md")
    expect(b[1][0].name).toBe("tiny.md")
  })
  test("empty input → empty plan", () => {
    expect(planBatches([])).toEqual([])
  })
})

// ── the map budget is derived from the socket, not typed into the file ─────
//
// The old constants read a fifth of a real chapter and inferred the rest — a hardcoded volume in the exact
// case this pipeline exists for. What replaces them has to MOVE with the window, or it is the same defect
// with a different number in it.
describe("corpusBudgets", () => {
  const env = { FABULA_CTX_CHARS_PER_TOKEN: "5" }

  test("scales with the window, for the batch and for a single file alike", () => {
    const small = corpusBudgets(8_000, env)
    const big = corpusBudgets(64_000, env)
    expect(big.batchChars).toBeGreaterThan(small.batchChars)
    expect(big.chapterCap).toBeGreaterThan(small.chapterCap)
  })

  test("a real chapter is read WHOLE on a real window — the defect that prompted this", () => {
    const CHAPTER = 36_000 // measured on a live corpus: the average, not the maximum
    expect(corpusBudgets(135_168, env).chapterCap).toBeGreaterThan(CHAPTER)
    expect(corpusBudgets(135_168, env).chapterCap).toBeGreaterThan(8000) // the constant it replaces
  })

  test("both ends stay env-overridable for anyone with a reason", () => {
    expect(corpusBudgets(135_168, { ...env, FABULA_CORPUS_BATCH_CHARS: "5000" }).batchChars).toBe(5000)
    expect(corpusBudgets(135_168, { ...env, FABULA_CORPUS_CHAPTER_CAP: "3000" }).chapterCap).toBe(3000)
  })

  test("a nonsense override never produces a nonsense budget", () => {
    for (const bad of ["0", "-1", "abc", ""]) {
      const b = corpusBudgets(64_000, { ...env, FABULA_CORPUS_BATCH_CHARS: bad, FABULA_CORPUS_CHAPTER_CAP: bad })
      expect(b.batchChars).toBeGreaterThan(1024)
      expect(b.chapterCap).toBeGreaterThan(1024)
    }
  })
})

// ── the framing carries the reader's words instead of classifying them ─────
//
// The preamble used to be CHOSEN by a regex over the task text — literary critic if it saw "критик" or
// "literary", generic analyst otherwise. That is the same word-matching that armed this pipeline, and it
// fails the same way: silently, on the first phrasing nobody anticipated, by handing a book to an analyst
// who was told nothing about books. The reader's own words go through verbatim now.

describe("askLine — the reader's ask, carried not classified", () => {
  test("carries the words exactly, whatever they are", () => {
    for (const q of [
      "о чем книга? прочти полностью и дай ответ",
      "дай критическое развернутое описание книги",
      "read the book in full",
      "ну и?",
    ]) expect(askLine(q)).toBe(`${ASK_LABEL}: ${q}`)
  })

  test("an ask is bounded — it is paid for once per batch", () => {
    const line = askLine("x".repeat(9000), 2000)
    expect(line.length).toBeLessThan(2100)
    expect(line.endsWith("…")).toBe(true)
  })

  test("no ask is no line, not an empty label", () => {
    expect(askLine("")).toBe("")
    expect(askLine("   ")).toBe("")
    expect(askLine(null as any)).toBe("")
  })
})

describe("ANALYST_PREAMBLE", () => {
  // The property the deleted classifier could not have: every ask gets the SAME framing, so no phrasing
  // can fall through to a weaker one.
  test("is one constant framing, identical for every phrasing of the ask", () => {
    makeFile(CWD, "глава_01.md", "# Глава 1\ntext")
    const files = discoverCorpus(CWD).files
    const skeleton = (q: string) => chapterSummaryPrompt(files, q, 1000).replace(askLine(q), "<ASK>")
    expect(skeleton("сделай литературный разбор романа")).toBe(skeleton("ну и?"))
  })
  test("asks for analysis rather than retelling, and answers in the reader's language", () => {
    expect(ANALYST_PREAMBLE).toContain("не пересказ")
    expect(ANALYST_PREAMBLE).toContain("языке запроса")
  })
})

describe("chapterSummaryPrompt", () => {
  test("frames corpus content as UNTRUSTED data and caps long chapters", () => {
    makeFile(CWD, "глава_01.md", "# Глава 1\n" + "А".repeat(20000))
    const files = discoverCorpus(CWD).files
    const p = chapterSummaryPrompt(files, "глубокий анализ книги", 1000)
    expect(p).toContain("UNTRUSTED data")
    expect(p).toContain("глава_01.md")
    expect(p).toContain("[обрезано")
    expect(p).toContain("ОСТАНОВИСЬ")
    expect(p.length).toBeLessThan(20000) // cap held
  })

  // The map step needs the SAME delimiter contract as the reduce step. Without it there is no boundary
  // between a model's visible reasoning and its answer, and a model that narrates its thinking as plain
  // text (no tags at all — observed live on a real book run: summaries beginning "Thinking Process: 1.
  // Analyze the Request…") stores that preamble in the accumulator, which is then quoted verbatim into
  // the synthesize prompt and into the fallback report. Asking for the delimiter works for any model;
  // matching a particular phrasing would not.
  test("asks for the same <final> delimiter the reduce step uses, so reasoning cannot leak into a summary", () => {
    makeFile(CWD, "глава_02.md", "# Глава 2\ntext")
    const p = chapterSummaryPrompt(discoverCorpus(CWD).files, "глубокий анализ книги", 1000)
    expect(p).toContain("<final>")
    expect(p).toContain("</final>")
  })
})

// A fixed synthesis budget is a hardcoded volume. Observed live: a 28-chapter book produced a report
// chopped mid-heading at the old 1400-token constant, while the same constant is generous for 3 files.
describe("synthTokensFor", () => {
  test("scales with the amount of source the report has to cover", () => {
    expect(synthTokensFor(11, {})).toBeGreaterThan(synthTokensFor(3, {}))
    expect(synthTokensFor(3, {})).toBeGreaterThan(synthTokensFor(1, {}))
    expect(synthTokensFor(11, {})).toBeGreaterThan(1400) // the budget that truncated the real book
  })
  test("floor keeps a tiny corpus whole; ceiling keeps a huge one askable", () => {
    expect(synthTokensFor(1, {})).toBeGreaterThanOrEqual(1400)
    expect(synthTokensFor(10_000, {})).toBeLessThanOrEqual(6000)
    expect(synthTokensFor(28, {})).toBe(synthTokensFor(500, {})) // both clamped at the ceiling
  })
  test("both ends are env-overridable, and degenerate counts never produce nonsense", () => {
    expect(synthTokensFor(5, { FABULA_CORPUS_SYNTH_MAX: "2000" })).toBe(2000)
    expect(synthTokensFor(1, { FABULA_CORPUS_SYNTH_TOKENS: "500", FABULA_CORPUS_SYNTH_PER_BATCH: "100" })).toBe(600)
    for (const bad of [0, -5, NaN, Infinity]) expect(synthTokensFor(bad as number, {})).toBeGreaterThanOrEqual(1400)
  })
})

describe("synthesizeReportPrompt", () => {
  test("includes every summary and asks for <final> tag", () => {
    const summaries = [
      { name: "batch1", text: "Тема одиночества в главах 1-3." },
      { name: "batch2", text: "Арка героя в главах 4-6." },
    ]
    const p = synthesizeReportPrompt(summaries, "литературный анализ романа")
    expect(p).toContain("batch1")
    expect(p).toContain("batch2")
    expect(p).toContain("Тема одиночества")
    expect(p).toContain("<final>")
  })
})

describe("cleanAnswer", () => {
  test("prefers <final> content, strips <think>", () => {
    expect(cleanAnswer("reasoning here <final>THE REPORT</final> tail")).toBe("THE REPORT")
    expect(cleanAnswer("<think>scratch</think>\nvisible answer")).toBe("visible answer")
    expect(cleanAnswer("plain answer no tags")).toBe("plain answer no tags")
  })

  // Observed live: a finished report was delivered to the chat with a literal `<final>` at its head,
  // because the model opened the tag and never closed it — the paired-only regex left it untouched.
  test("unclosed <final>: the answer starts after the marker, and the marker never ships", () => {
    const out = cleanAnswer("thinking out loud\n<final>\n# REPORT\n\nbody of the report")
    expect(out).toBe("# REPORT\n\nbody of the report")
    expect(out).not.toContain("<final>")
  })

  test("unclosed <think> with no answer after it: the reasoning tail is dropped, not shipped", () => {
    expect(cleanAnswer("<think>rambling on and on and never closing")).toBe("")
    expect(cleanAnswer("preface\n<think>rambling forever")).toBe("preface")
  })

  test("unclosed <think> followed by an unclosed <final>: the answer wins", () => {
    expect(cleanAnswer("<think>weighing it up\n<final>ANSWER")).toBe("ANSWER")
  })

  test("a stray closing marker is never returned either", () => {
    expect(cleanAnswer("answer body</final>")).toBe("answer body")
    expect(cleanAnswer("answer body</think>")).toBe("answer body")
  })
})

// ── no detector survives here, and this is the test that keeps it that way ──
//
// A regex nobody imports is still a regex somebody re-wires. The module is asserted to hold no vocabulary
// of asks at all: the words that used to arm it, and the ones that used to be missing, are equally absent.
describe("the corpus core carries no vocabulary of asks", () => {
  test("exports nothing that classifies a task", () => {
    const mod = require("./corpus")
    for (const name of Object.keys(mod))
      expect(/^is[A-Z]|Task$|Detect|Classif/.test(name)).toBe(false)
  })

  // The behavioural form of the same claim, and the one that would actually catch a re-wiring: EVERY
  // function here that takes the reader's text must use it only by carrying it. Substitute the ask back
  // out and two completely different requests have to leave byte-identical output.
  test("no exported function branches on what the ask says", () => {
    const summaries = [{ name: "b1", text: "s" }]
    const asks = [
      "сделай литературный критический разбор романа",
      "о чем книга? прочти полностью и дай ответ",
      "read the book in full",
      "ну и?",
      "почини баг в adapter.ts",
    ]
    const shapes = new Set(
      asks.map((q) => synthesizeReportPrompt(summaries, q).split(askLine(q, 4000)).join("<ASK>")),
    )
    expect(shapes.size).toBe(1)
  })
})

// ── accumulator (resume-safe persistence) ─────────────────────────────────

describe("accumulator", () => {
  let n = 0
  const nextKey = () => { n += 1; return `ses-test-${process.pid}-${n}` }
  test("seedAccumulator → readAccumulator round-trip + reseed preserves startedAt", () => {
    const KEY = nextKey()
    const plan = [[file(join(CWD, "a.md"), "a.md")], [file(join(CWD, "b.md"), "b.md")]]
    const acc1 = seedAccumulator(KEY, "task", plan)
    expect(acc1.batches.length).toBe(2)
    expect(acc1.batches.every((b) => !b.done)).toBe(true)
    const read1 = readAccumulator(KEY)
    expect(read1?.task).toBe("task")
    expect(read1?.startedAt).toBe(acc1.startedAt)
    // reseed: startedAt preserved, all reset to not-done unless already done
    const acc2 = seedAccumulator(KEY, "task", plan)
    expect(acc2.startedAt).toBe(acc1.startedAt)
  })
  test("markDone persists progress; pendingBatches skips done", () => {
    const KEY = nextKey()
    const plan = [[file(join(CWD, "a.md"), "a.md"), file(join(CWD, "b.md"), "b.md")], [file(join(CWD, "c.md"), "c.md")]]
    seedAccumulator(KEY, "task", plan)
    markDone(KEY, plan[0], "summary of batch 0")
    const acc = readAccumulator(KEY)!
    expect(acc.batches.filter((b) => b.done).length).toBe(2) // a + b
    expect(doneSummaries(KEY).length).toBe(1) // one summary text for the batch
    const pending = pendingBatches(KEY, plan)
    expect(pending.length).toBe(1) // only batch 1 (c.md) pending
    expect(pending[0][0].name).toBe("c.md")
  })
  test("resume after 'crash': seed keeps done entries, pendingBatches returns only undone", () => {
    const KEY = nextKey()
    const plan = [[file(join(CWD, "a.md"), "a.md")], [file(join(CWD, "b.md"), "b.md")], [file(join(CWD, "c.md"), "c.md")]]
    seedAccumulator(KEY, "task", plan)
    markDone(KEY, plan[0], "done A")
    markDone(KEY, plan[1], "done B")
    // simulate crash: re-seed (preserves done state) then ask what's pending
    seedAccumulator(KEY, "task", plan)
    const pending = pendingBatches(KEY, plan)
    expect(pending.length).toBe(1)
    expect(pending[0][0].name).toBe("c.md")
    expect(doneSummaries(KEY).map((s) => s.name).sort()).toEqual(["a.md", "b.md"])
  })
  test("clearAccumulator removes the file", () => {
    const KEY = nextKey()
    seedAccumulator(KEY, "task", [[file(join(CWD, "a.md"), "a.md")]])
    expect(readAccumulator(KEY)).not.toBeNull()
    clearAccumulator(KEY)
    expect(readAccumulator(KEY)).toBeNull()
  })
  test("accumulatorKey is stable + sanitized", () => {
    const k1 = accumulatorKey("ses_abc", "/Users/x/BOOK NII-TRED FINAL")
    const k2 = accumulatorKey("ses_abc", "/Users/x/BOOK NII-TRED FINAL")
    expect(k1).toBe(k2)
    expect(k1).toMatch(/^[a-z0-9-]+$/i)
  })
})

// ── The edge is a contract here too ─────────────────────────────────────
describe("a batch that produced nothing is an absence, not a summary", () => {
  test("markDone(null) marks it done but stores no text, so a resume does not retry forever", () => {
    const key = accumulatorKey("sess-gap", "/tmp/x")
    const files = [{ name: "ch1", path: "/tmp/x/ch1.md", chars: 10 }, { name: "ch2", path: "/tmp/x/ch2.md", chars: 10 }]
    seedAccumulator(key, "read it all", [[files[0]], [files[1]]])
    markDone(key, [files[0]], "a real summary of chapter one")
    markDone(key, [files[1]], null)
    expect(pendingBatches(key, [[files[0]], [files[1]]])).toHaveLength(0)
    const texts = doneSummaries(key).map((s) => s.text)
    expect(texts).toContain("a real summary of chapter one")
    // The failed batch contributes NO text — nothing that reads like a chapter summary.
    expect(texts.some((t) => /fail|error|unknown/i.test(t))).toBe(false)
    expect(emptyBatchCount(key)).toBe(1)
    clearAccumulator(key)
  })

  test("a fully successful run reports no gaps", () => {
    const key = accumulatorKey("sess-ok", "/tmp/y")
    const f = [{ name: "ch1", path: "/tmp/y/ch1.md", chars: 10 }]
    seedAccumulator(key, "read it all", [f])
    markDone(key, f, "summary")
    expect(emptyBatchCount(key)).toBe(0)
    clearAccumulator(key)
  })
})

describe("prefix-cache layout in the corpus MAP", () => {
  test("every batch opens with the same bytes", () => {
    const a = chapterSummaryPrompt([{ name: "ch1", path: "/nope/a.md", chars: 5 }], "разбери всю книгу")
    const b = chapterSummaryPrompt([{ name: "ch2", path: "/nope/b.md", chars: 5 }], "разбери всю книгу")
    expect(a.startsWith(MAP_PREAMBLE)).toBe(true)
    expect(b.startsWith(MAP_PREAMBLE)).toBe(true)
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    expect(i).toBeGreaterThanOrEqual(MAP_PREAMBLE.length)
  })

  test("the batch-specific part stays behind the constant block", () => {
    const p = chapterSummaryPrompt([{ name: "UNIQUECHAP", path: "/nope/x.md", chars: 5 }], "разбери всю книгу")
    expect(p.indexOf("UNIQUECHAP")).toBeGreaterThan(MAP_PREAMBLE.length)
  })
})

// The asks that broke the old detector, measured 2026-07-28: none of them matched, so the whole-work path
// never fired and the book was read a chapter at a time until the thread was lost. They are kept here — no
// longer as inputs to a decision, but as proof that the pipeline treats every one of them the same, next
// to the ordinary asks that must never be dragged into a corpus pass. A detector could tell these two
// groups apart and got it wrong; this pipeline does not have to, because it never sees them at all.
describe("how people actually ask makes no difference to this pipeline", () => {
  const asks = [
    "о чем книга? прочти полностью и дай ответ",
    "дай критическое развернутое описание книги",
    "прочти книгу целиком и скажи о чём она",
    "перескажи роман",
    "read the book in full and tell me what it is about",
    "summarise the book",
    // …and the ones a detector had to keep OUT, which are equally uninteresting here:
    "прочти полностью текст ошибки и объясни",
    "полностью перепиши модуль авторизации",
    "почини баг в adapter.ts",
    "ну и?",
  ]

  test("every ask produces the same prompt but for the reader's own sentence", () => {
    makeFile(CWD, "глава_01.md", "# Глава 1\ntext")
    const files = discoverCorpus(CWD).files
    const shapes = new Set(asks.map((q) => chapterSummaryPrompt(files, q, 1000).replace(askLine(q), "<ASK>")))
    expect(shapes.size).toBe(1)
  })

  test("and the reader's own sentence is in there, whichever it was", () => {
    makeFile(CWD, "глава_01.md", "# Глава 1\ntext")
    const files = discoverCorpus(CWD).files
    for (const q of asks) expect(chapterSummaryPrompt(files, q, 1000)).toContain(q)
  })
})

// The owner's rule, 2026-07-28: the chat receives the FINISHED report or nothing. A failed reduce used
// to dump the raw per-batch summaries joined with "---" — seven half-summaries cut mid-word, presented
// as the answer to one question about a book.
describe("synthesizeWithFallback — the finished answer or nothing", () => {
  const sums = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `b${i}`, text: `summary ${i} raw material` }))

  test("a working flat call returns its report", async () => {
    const r = await synthesizeWithFallback(async () => "полный разбор книги", sums(10), "о чем книга")
    expect(r).toBe("полный разбор книги")
  })

  test("a failed flat call reduces hierarchically instead of giving up", async () => {
    let calls = 0
    const r = await synthesizeWithFallback(async (p) => {
      calls++
      if (calls === 1) return "" // the flat attempt fails
      return p.includes("part-1") ? "итоговый разбор из частей" : "внутренняя часть"
    }, sums(20), "о чем книга")
    expect(r).toBe("итоговый разбор из частей")
    expect(calls).toBeGreaterThan(2)
  })

  test("NEVER returns raw summaries, whatever fails", async () => {
    const r = await synthesizeWithFallback(async () => "", sums(20), "о чем книга")
    expect(r).toBeNull() // null — not a "---" join, not a fragment
  })

  test("a throwing call is a failure, not a crash", async () => {
    const r = await synthesizeWithFallback(async () => { throw new Error("HTTP 500") }, sums(12), "q")
    expect(r).toBeNull()
  })

  test("groups are balanced and ordered", () => {
    const g = groupSummaries(Array.from({ length: 21 }, (_, i) => i), 8)
    expect(g.length).toBe(3)
    expect(g.map((x) => x.length)).toEqual([7, 7, 7])
    expect(g.flat()).toEqual(Array.from({ length: 21 }, (_, i) => i))
  })

  test("a group of one never trails", () => {
    for (const n of [9, 17, 25, 33]) {
      const g = groupSummaries(Array.from({ length: n }, (_, i) => i), 8)
      for (const grp of g) expect(grp.length).toBeGreaterThanOrEqual(2)
    }
  })
})

// ── The report's room comes from the window (measured 2026-07-30) ────────────
// A 28-chapter book earned 8680 tokens of report and was handed a typed 6000, so the analysis stopped
// mid-word: "Для читателя, привыкшего к динами". The input side of this file was derived from the window
// one docstring earlier; the output side was still a constant.
describe("synthTokensFor scales with the material, bounded by the window", () => {
  test("a real window gives the material everything it earned", () => {
    // 28 batches earn 1400 + 260*28 = 8680, and a 135168 window has room for all of it.
    expect(synthTokensFor(28, {}, 135168, 13000)).toBe(8680)
  })

  test("the typed ceiling no longer decides when a window is known", () => {
    expect(synthTokensFor(28, {}, 135168, 13000)).toBeGreaterThan(DEFAULT_SYNTH_TOKENS_MAX)
  })

  test("more material, more room — the whole point", () => {
    const small = synthTokensFor(3, {}, 135168, 4000)
    const big = synthTokensFor(100, {}, 135168, 40000)
    expect(big).toBeGreaterThan(small * 5)
  })

  test("a small corpus does not get a book-sized budget", () => {
    expect(synthTokensFor(3, {}, 135168, 4000)).toBeLessThan(3000)
  })

  test("the window BOUNDS it — a report cannot ask for more than can come back", () => {
    // 400 batches would earn 105 400; a 32k window with a 20k prompt cannot return that.
    const b = synthTokensFor(400, {}, 32768, 20000)
    expect(b).toBeLessThan(32768 - 20000)
  })

  test("no window reported falls back to the constant, never to nonsense", () => {
    expect(synthTokensFor(28, {})).toBe(DEFAULT_SYNTH_TOKENS_MAX)
    expect(synthTokensFor(28, {}, 0, 0)).toBe(DEFAULT_SYNTH_TOKENS_MAX)
  })

  test("an explicit override is a decision and wins", () => {
    expect(synthTokensFor(28, { FABULA_CORPUS_SYNTH_MAX: "2000" }, 135168, 13000)).toBe(2000)
  })

  test("a window fully consumed by its own prompt still returns a usable floor", () => {
    expect(synthTokensFor(28, {}, 10000, 9999)).toBeGreaterThan(0)
  })
})
