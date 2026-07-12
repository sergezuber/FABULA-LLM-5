// EXHAUSTIVE corner-case tests for the str_replace code-edit path:
//   • str_replace tool execute()  (fabula-tools.ts §8)
//   • lib/fuzzymatch.ts  (findMatch + checkEscapeDrift)
//   • lib/filestate.ts   (FileStateTracker singleton + neverReadNote)
// Real temp files on the real fs, real tool execute(), real fs.utimes for mtime drift.
// fileState is a module-level SINGLETON, so every test uses a UNIQUE sessionID to control read-state.
//
// We verify FILE CONTENT after every edit (read the bytes back), not just the message.
import { test, expect, beforeAll, afterAll } from "bun:test"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { FabulaTools } from "../fabula-tools"
import { findMatch, checkEscapeDrift } from "../lib/fuzzymatch"
import { fileState, neverReadNote } from "../lib/filestate"

let T: any
let DIR = ""
let counter = 0
const out = (r: any) => (typeof r === "string" ? r : r.output)
const meta = (r: any) => (typeof r === "string" ? undefined : r.metadata)

// fresh temp file with given content; returns absolute path
async function tmpFile(content: string, name = "f"): Promise<string> {
  const p = path.join(DIR, `${name}-${process.pid}-${++counter}.txt`)
  await fs.writeFile(p, content, "utf8")
  return p
}
// fresh, unique sessionID per test (module singleton isolation)
const sid = () => `sess-${process.pid}-${++counter}`
const ctxFor = (s: string) => ({ sessionID: s, directory: DIR, abort: new AbortController().signal } as any)

beforeAll(async () => {
  T = (await FabulaTools({} as any)).tool
  DIR = await fs.mkdtemp(path.join(os.tmpdir(), `fabula-stredit-${process.pid}-`))
})
afterAll(async () => { try { await fs.rm(DIR, { recursive: true, force: true }) } catch {} })

// ───────────────────────── findMatch — pure unit ─────────────────────────

test("findMatch: exact unique → ok exact", () => {
  const m = findMatch("alpha beta gamma", "beta")
  expect(m.ok).toBe(true); expect(m.strategy).toBe("exact"); expect(m.matched).toBe("beta"); expect(m.count).toBe(1)
})

test("findMatch: ambiguous (>1) exact → refuse with count", () => {
  const m = findMatch("foo foo", "foo")
  expect(m.ok).toBe(false); expect(m.strategy).toBe("exact"); expect(m.count).toBe(2); expect(m.matched).toBe("")
})

test("findMatch: not found → none/0", () => {
  const m = findMatch("hello world", "zzz")
  expect(m.ok).toBe(false); expect(m.strategy).toBe("none"); expect(m.count).toBe(0)
})

test("findMatch: empty needle → not ok (count 0)", () => {
  const m = findMatch("anything", "")
  expect(m.ok).toBe(false); expect(m.count).toBe(0); expect(m.strategy).toBe("none")
})

test("findMatch: non-string args → none", () => {
  // @ts-expect-error deliberate bad input
  expect(findMatch(null, "x").ok).toBe(false)
  // @ts-expect-error deliberate bad input
  expect(findMatch("x", null).ok).toBe(false)
})

test("findMatch fuzzy: trim_trailing — needle has trailing whitespace the file lacks", () => {
  const hay = "line one\ntarget here\nline three"
  const m = findMatch(hay, "target here   ") // trailing spaces in needle
  expect(m.ok).toBe(true); expect(m.strategy).toBe("trim_trailing")
  expect(m.matched).toBe("target here") // EXACT original span (no trailing ws)
  expect(hay.indexOf(m.matched)).toBeGreaterThanOrEqual(0)
})

test("findMatch fuzzy: strip_indent — tab indent vs space indent (needle is NOT a raw substring)", () => {
  // file uses TAB indentation; needle uses SPACE indentation → "    return 42" is not a substring of
  // "\t\treturn 42" (so exact fails), trim_trailing leaves the leading mismatch (so it fails too),
  // only strip_indent (which removes leading+trailing ws) makes both sides equal.
  const hay = "def f():\n\t\treturn 42\n"
  const m = findMatch(hay, "    return 42")
  expect(m.ok).toBe(true); expect(m.strategy).toBe("strip_indent")
  expect(m.matched).toBe("\t\treturn 42") // original, TAB indentation preserved
})

test("findMatch fuzzy: unicode — smart quotes / em-dash normalized", () => {
  const hay = `const s = “hello” — world` // “hello” — world
  const m = findMatch(hay, `const s = "hello" - world`)  // ascii quotes + hyphen
  expect(m.ok).toBe(true); expect(m.strategy).toBe("unicode")
  expect(m.matched).toBe(hay) // returns ORIGINAL (curly) bytes
})

test("findMatch fuzzy: collapse_ws — internal whitespace differs", () => {
  const hay = "a    b\tc"          // multiple spaces + tab
  const m = findMatch(hay, "a b c") // single spaces
  expect(m.ok).toBe(true); expect(m.strategy).toBe("collapse_ws")
  expect(m.matched).toBe("a    b\tc")
})

test("findMatch fuzzy: block_anchor — first/last line anchor a unique multi-line span", () => {
  const hay = "head\nfunction g() {\n  // body the model paraphrased wrongly\n  doThing()\n}\ntail"
  const needle = "function g() {\n  THIS MIDDLE IS WRONG\n  ALSO WRONG\n}" // 4 lines, first+last trimmed match
  const m = findMatch(hay, needle)
  expect(m.ok).toBe(true); expect(m.strategy).toBe("block_anchor")
  expect(m.matched).toBe("function g() {\n  // body the model paraphrased wrongly\n  doThing()\n}")
})

test("findMatch: fuzzy match that resolves to AMBIGUOUS span → refuse (>1)", () => {
  // two identical 'x  ' lines (trailing ws) → trim_trailing finds 2 starts → refuse
  const hay = "x \ny\nx \nz"
  const m = findMatch(hay, "x") // exact 'x' alone: exact count? 'x' appears twice exactly
  // 'x' exact occurs at two places -> exact refuse
  expect(m.ok).toBe(false); expect(m.count).toBe(2)
})

test("findMatch: strict beats loose — trim_trailing chosen before collapse_ws", () => {
  const hay = "keep   me\n"
  const m = findMatch(hay, "keep   me ") // only trailing-ws differs
  expect(m.strategy).toBe("trim_trailing")
})

test("findMatch: AMBIGUOUS via collapse_ws (two lines collapse equal, neither exact) → refuse", () => {
  // "a  b" and "a   b" both collapse to "a b"; needle "a b" is not an exact substring of either.
  const m = findMatch("a  b\nzzz\na   b", "a b")
  expect(m.ok).toBe(false); expect(m.strategy).toBe("collapse_ws"); expect(m.count).toBe(2)
})

test("findMatch: AMBIGUOUS via unicode (two curly-quote lines) → refuse", () => {
  const m = findMatch("x = “a”\ny\nx = “a”", `x = "a"`)
  expect(m.ok).toBe(false); expect(m.strategy).toBe("unicode"); expect(m.count).toBe(2)
})

test("findMatch: block_anchor — first/last line of a multi-line needle that is itself unique span", () => {
  // anchor lines A…A bound a unique 3-line span; the inner needle line is wrong but ignored by the anchor.
  const m = findMatch("A\nm\nA\nB\nn\nB", "A\nWRONG\nA")
  expect(m.ok).toBe(true); expect(m.strategy).toBe("block_anchor"); expect(m.matched).toBe("A\nm\nA")
})

test("findMatch: needle with trailing newline still matched exactly", () => {
  const m = findMatch("foo\nbar\nbaz", "bar\n")
  expect(m.ok).toBe(true); expect(m.strategy).toBe("exact"); expect(m.matched).toBe("bar\n")
})

// ───────────────────────── checkEscapeDrift — pure unit ─────────────────────────

test("checkEscapeDrift: >=2 literal \\n and no real newline → drift", () => {
  const d = checkEscapeDrift("line1\\nline2\\nline3")
  expect(d.drift).toBe(true)
  expect(d.fixed).toBe("line1\nline2\nline3")
})

test("checkEscapeDrift: single literal \\n → NOT drift (below threshold)", () => {
  expect(checkEscapeDrift("just one \\n here").drift).toBe(false)
})

test("checkEscapeDrift: literal \\n mixed with a real newline → NOT drift", () => {
  expect(checkEscapeDrift("a\\nb\nc\\nd").drift).toBe(false) // realNL>0
})

test("checkEscapeDrift: real newlines only → NOT drift, fixed unchanged", () => {
  const d = checkEscapeDrift("a\nb\nc")
  expect(d.drift).toBe(false); expect(d.fixed).toBe("a\nb\nc")
})

test("checkEscapeDrift: also expands literal \\t in fixed", () => {
  const d = checkEscapeDrift("x\\ny\\tz") // 1 \n -> not drift, but fixed still expands
  expect(d.fixed).toBe("x\ny\tz")
})

test("checkEscapeDrift: non-string → no drift", () => {
  // @ts-expect-error bad input
  expect(checkEscapeDrift(123).drift).toBe(false)
})

// ───────────────────────── filestate — pure unit ─────────────────────────

test("filestate: never read → neverRead verdict, empty note", () => {
  const s = sid()
  const v = fileState.checkStale(s, "/some/path", 100)
  expect(v.neverRead).toBe(true); expect(v.stale).toBe(false); expect(v.note).toBe("")
})

test("filestate: read then unchanged mtime → not stale, no note", () => {
  const s = sid()
  fileState.recordRead(s, "/p", 1000, false)
  const v = fileState.checkStale(s, "/p", 1000)
  expect(v.neverRead).toBe(false); expect(v.stale).toBe(false); expect(v.note).toBe("")
})

test("filestate: external mtime bump → stale note", () => {
  const s = sid()
  fileState.recordRead(s, "/p", 1000, false)
  const v = fileState.checkStale(s, "/p", 2000) // disk newer
  expect(v.stale).toBe(true); expect(v.note).toContain("changed on disk")
})

test("filestate: partial read, unchanged → partialOnly note", () => {
  const s = sid()
  fileState.recordRead(s, "/p", 1000, true)
  const v = fileState.checkStale(s, "/p", 1000)
  expect(v.stale).toBe(false); expect(v.partialOnly).toBe(true); expect(v.note).toContain("only read PART")
})

test("filestate: stale takes priority over partial in note", () => {
  const s = sid()
  fileState.recordRead(s, "/p", 1000, true)
  const v = fileState.checkStale(s, "/p", 5000)
  expect(v.stale).toBe(true); expect(v.note).toContain("changed on disk")
})

test("filestate: currentMtime undefined/NaN → never stale (new file)", () => {
  const s = sid()
  fileState.recordRead(s, "/p", 1000, false)
  expect(fileState.checkStale(s, "/p", undefined).stale).toBe(false)
  expect(fileState.checkStale(s, "/p", NaN).stale).toBe(false)
})

test("filestate: noteWrite makes a never-read file safe (full)", () => {
  const s = sid()
  fileState.noteWrite(s, "/p", 1000)
  const v = fileState.checkStale(s, "/p", 1000)
  expect(v.neverRead).toBe(false); expect(v.partialOnly).toBe(false); expect(v.note).toBe("")
})

test("filestate: empty sid or path → record is a no-op (still neverRead)", () => {
  fileState.recordRead("", "/p", 1)
  expect(fileState.checkStale("", "/p", 1).neverRead).toBe(true)
  const s = sid()
  fileState.recordRead(s, "", 1)
  expect(fileState.checkStale(s, "", 1).neverRead).toBe(true)
})

test("filestate: dropSession forgets reads", () => {
  const s = sid()
  fileState.recordRead(s, "/p", 1000)
  expect(fileState.checkStale(s, "/p", 1000).neverRead).toBe(false)
  fileState.dropSession(s)
  expect(fileState.checkStale(s, "/p", 1000).neverRead).toBe(true)
})

test("neverReadNote includes the path", () => {
  expect(neverReadNote("/x/y.ts")).toContain("/x/y.ts")
})

// ───────────────────────── str_replace execute() — real fs ─────────────────────────

test("str_replace: exact unique edit writes correct bytes + never-read warning", async () => {
  const s = sid(); const ctx = ctxFor(s)
  const p = await tmpFile("alpha\nbeta\ngamma\n")
  const r = await T.str_replace.execute({ description: "d", old_str: "beta", new_str: "BETA", path: p }, ctx)
  expect(out(r)).toContain("1 replacement")
  expect(out(r)).toContain("[warning:") // edited without reading this session
  expect(meta(r)?.strategy).toBe("exact")
  expect(await fs.readFile(p, "utf8")).toBe("alpha\nBETA\ngamma\n") // VERIFY CONTENT
})

test("str_replace: ambiguous old_str → refuse, file UNCHANGED", async () => {
  const s = sid(); const ctx = ctxFor(s)
  const before = "dup\ndup\n"
  const p = await tmpFile(before)
  const r = await T.str_replace.execute({ description: "d", old_str: "dup", new_str: "X", path: p }, ctx)
  expect(out(r)).toContain("must be unique")
  expect(out(r)).toContain("matches 2 places")
  expect(await fs.readFile(p, "utf8")).toBe(before) // NO WRITE
})

test("str_replace: not found → refuse, file UNCHANGED", async () => {
  const s = sid(); const ctx = ctxFor(s)
  const before = "only this line\n"
  const p = await tmpFile(before)
  const r = await T.str_replace.execute({ description: "d", old_str: "nonexistent", new_str: "X", path: p }, ctx)
  expect(out(r)).toContain("not found")
  expect(await fs.readFile(p, "utf8")).toBe(before)
})

test("str_replace: file does not exist → error", async () => {
  const ctx = ctxFor(sid())
  const r = await T.str_replace.execute({ description: "d", old_str: "a", new_str: "b", path: path.join(DIR, "nope-does-not-exist.txt") }, ctx)
  expect(out(r)).toContain("file does not exist")
})

test("str_replace: escape-drift new_str rejected, file UNCHANGED", async () => {
  const s = sid(); const ctx = ctxFor(s)
  const before = "target\n"
  const p = await tmpFile(before)
  const r = await T.str_replace.execute({ description: "d", old_str: "target", new_str: "a\\nb\\nc", path: p }, ctx)
  expect(out(r)).toContain("escape drift")
  expect(await fs.readFile(p, "utf8")).toBe(before) // rejected before write
})

test("str_replace: new_str empty → deletion", async () => {
  const ctx = ctxFor(sid())
  const p = await tmpFile("keepXdeletemeXkeep".replace(/X/g, ""))
  await fs.writeFile(p, "head DELETE tail")
  const r = await T.str_replace.execute({ description: "d", old_str: " DELETE", new_str: "", path: p }, ctx)
  expect(out(r)).toContain("1 replacement")
  expect(await fs.readFile(p, "utf8")).toBe("head tail")
})

test("str_replace: default new_str (omitted) → treated as deletion", async () => {
  const ctx = ctxFor(sid())
  const p = await tmpFile("a-REMOVE-b")
  // omit new_str entirely; zod default "" applies at the schema layer, but execute reads args.new_str ?? ""
  const r = await T.str_replace.execute({ description: "d", old_str: "REMOVE", path: p } as any, ctx)
  expect(out(r)).toContain("1 replacement")
  expect(await fs.readFile(p, "utf8")).toBe("a--b")
})

test("str_replace: CRLF file — edit preserves CRLF around the span", async () => {
  const ctx = ctxFor(sid())
  const before = "one\r\ntwo\r\nthree\r\n"
  const p = await tmpFile(before)
  const r = await T.str_replace.execute({ description: "d", old_str: "two", new_str: "TWO", path: p }, ctx)
  expect(out(r)).toContain("1 replacement")
  expect(await fs.readFile(p, "utf8")).toBe("one\r\nTWO\r\nthree\r\n") // CRLF intact
})

test("str_replace: unicode + emoji content edit", async () => {
  const ctx = ctxFor(sid())
  const before = "héllo 🌟 wörld\nобразец\n"
  const p = await tmpFile(before)
  const r = await T.str_replace.execute({ description: "d", old_str: "🌟", new_str: "⭐", path: p }, ctx)
  expect(out(r)).toContain("1 replacement")
  expect(await fs.readFile(p, "utf8")).toBe("héllo ⭐ wörld\nобразец\n")
})

test("str_replace: multi-line old_str exact replace", async () => {
  const ctx = ctxFor(sid())
  const before = "a\nblock start\ninner\nblock end\nz\n"
  const p = await tmpFile(before)
  const r = await T.str_replace.execute({ description: "d", old_str: "block start\ninner\nblock end", new_str: "REPLACED", path: p }, ctx)
  expect(out(r)).toContain("1 replacement")
  expect(await fs.readFile(p, "utf8")).toBe("a\nREPLACED\nz\n")
})

test("str_replace: old_str at start of file", async () => {
  const ctx = ctxFor(sid())
  const p = await tmpFile("FIRST line\nsecond\n")
  const r = await T.str_replace.execute({ description: "d", old_str: "FIRST", new_str: "1ST", path: p }, ctx)
  expect(await fs.readFile(p, "utf8")).toBe("1ST line\nsecond\n")
  expect(meta(r)?.line).toBe(1)
})

test("str_replace: old_str at end of file (no trailing newline)", async () => {
  const ctx = ctxFor(sid())
  const p = await tmpFile("line1\nlastTOKEN")
  const r = await T.str_replace.execute({ description: "d", old_str: "lastTOKEN", new_str: "LAST", path: p }, ctx)
  expect(await fs.readFile(p, "utf8")).toBe("line1\nLAST")
})

test("str_replace: whole-file replace", async () => {
  const ctx = ctxFor(sid())
  const before = "the entire content"
  const p = await tmpFile(before)
  const r = await T.str_replace.execute({ description: "d", old_str: before, new_str: "brand new", path: p }, ctx)
  expect(out(r)).toContain("1 replacement")
  expect(await fs.readFile(p, "utf8")).toBe("brand new")
})

test("str_replace: huge file (~30k lines) edit near the end", async () => {
  const ctx = ctxFor(sid())
  const lines = Array.from({ length: 30000 }, (_, i) => `line ${i}`)
  lines[29999] = "UNIQUE_TAIL_MARKER"
  const before = lines.join("\n")
  const p = await tmpFile(before, "huge")
  const r = await T.str_replace.execute({ description: "d", old_str: "UNIQUE_TAIL_MARKER", new_str: "DONE", path: p }, ctx)
  expect(out(r)).toContain("1 replacement")
  const after = await fs.readFile(p, "utf8")
  expect(after.endsWith("DONE")).toBe(true)
  expect(after.startsWith("line 0\n")).toBe(true)
}, 20000)

test("str_replace: fuzzy strip_indent strategy reported in message + correct bytes", async () => {
  const ctx = ctxFor(sid())
  const before = "def f():\n\t\treturn 42\n"
  const p = await tmpFile(before)
  // space-indented needle vs tab-indented file → forces strip_indent.
  // NOTE: the matched span is the WHOLE original line incl. its tab indent, so it is replaced
  // entirely by new_str — the caller's new_str must carry the indentation it wants to keep.
  const r = await T.str_replace.execute({ description: "d", old_str: "    return 42", new_str: "\t\treturn 99", path: p }, ctx)
  expect(out(r)).toContain("via strip_indent match")
  expect(await fs.readFile(p, "utf8")).toBe("def f():\n\t\treturn 99\n")
})

test("str_replace: fuzzy unicode (smart quotes) replaces original curly bytes", async () => {
  const ctx = ctxFor(sid())
  const before = `x = “hi”\n`
  const p = await tmpFile(before)
  const r = await T.str_replace.execute({ description: "d", old_str: `x = "hi"`, new_str: `x = "bye"`, path: p }, ctx)
  expect(out(r)).toContain("via unicode match")
  expect(await fs.readFile(p, "utf8")).toBe(`x = "bye"\n`)
})

// ── read-before-edit staleness via the REAL view tool + real fs.utimes ──

test("str_replace: after view (full read) → NO warning", async () => {
  const s = sid(); const ctx = ctxFor(s)
  const p = await tmpFile("read me first\nedit me\n")
  await T.view.execute({ description: "d", path: p }, ctx) // records full read at current mtime
  const r = await T.str_replace.execute({ description: "d", old_str: "edit me", new_str: "EDITED", path: p }, ctx)
  expect(out(r)).not.toContain("[warning:")
  expect(await fs.readFile(p, "utf8")).toBe("read me first\nEDITED\n")
})

test("str_replace: never-read warning when edited without view", async () => {
  const s = sid(); const ctx = ctxFor(s)
  const p = await tmpFile("blind edit target\n")
  const r = await T.str_replace.execute({ description: "d", old_str: "blind edit target", new_str: "X", path: p }, ctx)
  expect(out(r)).toContain("[warning:")
  expect(out(r)).toContain("without having read it")
})

test("str_replace: external mtime change after view → stale warning", async () => {
  const s = sid(); const ctx = ctxFor(s)
  const p = await tmpFile("v1 content here\n")
  await T.view.execute({ description: "d", path: p }, ctx) // read at mtime0
  // simulate an external edit by bumping mtime far into the future (no content change needed for the guard)
  const future = new Date(Date.now() + 60_000)
  await fs.utimes(p, future, future)
  const r = await T.str_replace.execute({ description: "d", old_str: "v1 content here", new_str: "v2", path: p }, ctx)
  expect(out(r)).toContain("[warning:")
  expect(out(r)).toContain("changed on disk")
  expect(await fs.readFile(p, "utf8")).toBe("v2\n") // still edits, but warns
})

test("str_replace: partial read via view_range → partial-read warning", async () => {
  const s = sid(); const ctx = ctxFor(s)
  const p = await tmpFile("L1\nL2\nL3\nL4\nL5\n")
  await T.view.execute({ description: "d", path: p, view_range: [1, 2] }, ctx) // partial read
  const r = await T.str_replace.execute({ description: "d", old_str: "L4", new_str: "FOUR", path: p }, ctx)
  expect(out(r)).toContain("[warning:")
  expect(out(r)).toContain("only read PART")
  expect(await fs.readFile(p, "utf8")).toBe("L1\nL2\nL3\nFOUR\nL5\n")
})

test("str_replace: auto-truncated view (body>16k, no view_range) → partial-read warning", async () => {
  const s = sid(); const ctx = ctxFor(s)
  // build a file whose numbered-line body exceeds 16000 chars so view() auto-truncates and flags partial
  const lines = Array.from({ length: 2000 }, (_, i) => `content line number ${i} with some padding text here`)
  lines[1500] = "EDIT_THIS_UNIQUE_MARKER"
  const p = await tmpFile(lines.join("\n"), "trunc")
  const v = await T.view.execute({ description: "d", path: p }, ctx) // no view_range → auto-truncate path
  expect(out(v)).toContain("middle truncated")
  const r = await T.str_replace.execute({ description: "d", old_str: "EDIT_THIS_UNIQUE_MARKER", new_str: "DONE", path: p }, ctx)
  expect(out(r)).toContain("[warning:")
  expect(out(r)).toContain("only read PART") // truncated read flagged partial
  expect((await fs.readFile(p, "utf8")).includes("DONE")).toBe(true)
})

test("str_replace: byte-readback success path (normal write persists)", async () => {
  const ctx = ctxFor(sid())
  const p = await tmpFile("persist check\n")
  const r = await T.str_replace.execute({ description: "d", old_str: "persist", new_str: "persisted", path: p }, ctx)
  // no read-back mismatch error
  expect(out(r)).not.toContain("did not persist")
  expect(out(r)).toContain("1 replacement")
  expect(await fs.readFile(p, "utf8")).toBe("persisted check\n")
})

test("str_replace: second edit after our own write needs no re-read (noteWrite) → no never-read warning", async () => {
  const s = sid(); const ctx = ctxFor(s)
  const p = await tmpFile("aaa bbb ccc")
  await T.str_replace.execute({ description: "d", old_str: "aaa", new_str: "AAA", path: p }, ctx) // first edit -> noteWrite
  const r = await T.str_replace.execute({ description: "d", old_str: "bbb", new_str: "BBB", path: p }, ctx)
  expect(out(r)).not.toContain("[warning:") // noteWrite marked it fresh+full
  expect(await fs.readFile(p, "utf8")).toBe("AAA BBB ccc")
})

test("str_replace: no-op edit (new_str === old_str) succeeds, bytes identical", async () => {
  const ctx = ctxFor(sid())
  const before = "unchanged target line\n"
  const p = await tmpFile(before)
  const r = await T.str_replace.execute({ description: "d", old_str: "target", new_str: "target", path: p }, ctx)
  expect(out(r)).toContain("1 replacement")
  expect(await fs.readFile(p, "utf8")).toBe(before) // byte-identical, readback still passes
})

test("str_replace: ambiguous-through-fuzzy (collapse_ws, 2 matches) → refuse, file UNCHANGED", async () => {
  const ctx = ctxFor(sid())
  // both lines collapse to "a b" but neither contains the exact substring "a b"
  const before = "a  b\nzzz\na   b\n"
  const p = await tmpFile(before)
  const r = await T.str_replace.execute({ description: "d", old_str: "a b", new_str: "Z", path: p }, ctx)
  expect(out(r)).toContain("must be unique")
  expect(out(r)).toContain("(collapse_ws)")
  expect(await fs.readFile(p, "utf8")).toBe(before) // NO WRITE
})

test("str_replace: empty file → not found, file stays empty", async () => {
  const ctx = ctxFor(sid())
  const p = await tmpFile("")
  const r = await T.str_replace.execute({ description: "d", old_str: "anything", new_str: "x", path: p }, ctx)
  expect(out(r)).toContain("not found")
  expect(await fs.readFile(p, "utf8")).toBe("")
})

test("str_replace: empty old_str → refuse (not-found path; findMatch rejects empty needle)", async () => {
  const ctx = ctxFor(sid())
  const before = "some content\n"
  const p = await tmpFile(before)
  const r = await T.str_replace.execute({ description: "d", old_str: "", new_str: "INSERTED", path: p }, ctx)
  // empty needle is never matched (findMatch returns ok:false, count:0) → "not found", no blind insert
  expect(out(r)).toContain("not found")
  expect(await fs.readFile(p, "utf8")).toBe(before)
})

// ── path handling: relative, ~, absolute, symlink ──

test("str_replace: relative path resolves against ctx.directory", async () => {
  const s = sid(); const ctx = ctxFor(s)
  const rel = `relpath-${process.pid}-${++counter}.txt`
  const abs = path.join(DIR, rel)
  await fs.writeFile(abs, "rel content")
  const r = await T.str_replace.execute({ description: "d", old_str: "rel", new_str: "REL", path: rel }, ctx)
  expect(out(r)).toContain("1 replacement")
  expect(await fs.readFile(abs, "utf8")).toBe("REL content")
})

test("str_replace: symlink target is followed and edited", async () => {
  const ctx = ctxFor(sid())
  const real = await tmpFile("symlinked body\n", "real")
  const link = path.join(DIR, `link-${process.pid}-${++counter}.txt`)
  await fs.symlink(real, link)
  const r = await T.str_replace.execute({ description: "d", old_str: "symlinked", new_str: "SYMLINKED", path: link }, ctx)
  expect(out(r)).toContain("1 replacement")
  expect(await fs.readFile(real, "utf8")).toBe("SYMLINKED body\n") // underlying file changed
})

// ── special chars / escaping in old_str & new_str ──

test("str_replace: regex-special chars in old_str are literal (indexOf, not regex)", async () => {
  const ctx = ctxFor(sid())
  const before = "value = a.b[0]+c*(d)$\n"
  const p = await tmpFile(before)
  const r = await T.str_replace.execute({ description: "d", old_str: "a.b[0]+c*(d)$", new_str: "REPL", path: p }, ctx)
  expect(out(r)).toContain("1 replacement")
  expect(await fs.readFile(p, "utf8")).toBe("value = REPL\n")
})

test("str_replace: new_str containing $& / $1 (regex replacement tokens) inserted literally", async () => {
  const ctx = ctxFor(sid())
  const p = await tmpFile("token here")
  const r = await T.str_replace.execute({ description: "d", old_str: "token", new_str: "$& and $1 literal", path: p }, ctx)
  expect(out(r)).toContain("1 replacement")
  expect(await fs.readFile(p, "utf8")).toBe("$& and $1 literal here") // not interpreted
})

test("str_replace: a single literal \\n in new_str (below drift threshold) inserted as-is", async () => {
  const ctx = ctxFor(sid())
  const p = await tmpFile("X")
  const r = await T.str_replace.execute({ description: "d", old_str: "X", new_str: "a\\nb", path: p }, ctx)
  // one literal \n is below the >=2 threshold -> NOT drift -> inserted verbatim
  expect(out(r)).toContain("1 replacement")
  expect(await fs.readFile(p, "utf8")).toBe("a\\nb")
})

// ── concurrency: two edits to the same file targeting different spans ──

test("str_replace: concurrent edits to different spans (one may lose) — file stays valid", async () => {
  const ctx = ctxFor(sid())
  const before = "AAA-MID-BBB"
  const p = await tmpFile(before)
  const [r1, r2] = await Promise.allSettled([
    T.str_replace.execute({ description: "d", old_str: "AAA", new_str: "111", path: p }, ctx),
    T.str_replace.execute({ description: "d", old_str: "BBB", new_str: "222", path: p }, ctx),
  ])
  // Each call independently reads then writes the whole file; last writer wins. We assert the file
  // is one of the two single-edit outcomes (NOT corrupted / NOT both — read-modify-write race).
  const after = await fs.readFile(p, "utf8")
  const possible = ["111-MID-BBB", "AAA-MID-222", "111-MID-222"]
  expect(possible).toContain(after)
  // at least one resolved without throwing
  expect([r1.status, r2.status]).toContain("fulfilled")
})
