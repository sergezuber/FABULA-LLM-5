// The compaction trigger only measures the CONVERSATION when the caller NAMES the session — with no
// `sessionID` both `isOverflow` and `pressureLevel` fall back, by design, to the absolute threshold
// the prompt alone already exceeds. So every production call site has to pass one, and NOTHING held
// that: with all four call sites stripped of `sessionID`, `bun test test/session/` reported
// `952 pass, 0 fail` — byte-identical to the unmutated tree. Pure core green, wiring dead, which is
// the defect class this repository keeps paying for.
//
// This reads the SOURCE rather than driving the run loop because the alternative — standing up a real
// engine turn per call site — is minutes of test for a property that is one grep away, and because a
// source rule also refuses a NEW call site somebody adds later. Comments and strings are blanked
// first: a literal grep cannot tell code from the note beside it (test/task/gate-reentry-invariant
// was bitten from both directions).
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const SRC = path.join(import.meta.dir, "../../src")
/** The module under test defines these; every OTHER caller must name a session. */
const DEFINING_FILE = path.join(SRC, "session/overflow.ts")

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = path.join(dir, e)
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith(".ts") ? [full] : []
  })
}

/** Replace every comment and string literal with spaces, preserving offsets. */
function blankNonCode(src: string): string {
  const out = src.split("")
  let i = 0
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " "
  }
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (two === "//") {
      const end = src.indexOf("\n", i)
      blank(i, end === -1 ? src.length : end)
      i = end === -1 ? src.length : end
      continue
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2)
      blank(i, end === -1 ? src.length : end + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    const c = src[i]!
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1
      blank(i + 1, j)
      i = j + 1
      continue
    }
    i++
  }
  return out.join("")
}

/** The local names a file imports from ./overflow, e.g. `isOverflow as overflowCheck` -> overflowCheck. */
function importedNames(code: string): string[] {
  const m = code.match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*\/overflow["']/)
  if (!m) return []
  return m[1]!
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^(isOverflow|pressureLevel)\b/.test(s))
    .map((s) => (s.includes(" as ") ? s.split(" as ")[1]!.trim() : s))
}

/** Every call to `name(` in `code`, returned as {line, args} with balanced parentheses. */
function callsTo(code: string, name: string) {
  const out: { line: number; args: string }[] = []
  const re = new RegExp(`(^|[^.\\w])${name}\\s*\\(`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1
    let depth = 0
    let end = open
    for (; end < code.length; end++) {
      if (code[end] === "(") depth++
      else if (code[end] === ")" && --depth === 0) break
    }
    out.push({ line: code.slice(0, open).split("\n").length, args: code.slice(open + 1, end) })
    re.lastIndex = end
  }
  return out
}

const callers = walk(SRC)
  .filter((f) => f !== DEFINING_FILE)
  // `importedNames` reads the RAW source and `callsTo` the blanked one, deliberately: blanking string
  // bodies also blanks the module specifier `"./overflow"`, so asking the blanked text which module a
  // file imports finds nothing — and a scan that finds nothing passes every assertion below it. That
  // is exactly how the first version of this file reported four green tests over zero call sites.
  .map((f) => ({ file: f, raw: readFileSync(f, "utf8") }))
  .flatMap(({ file, raw }) =>
    importedNames(raw).flatMap((name) =>
      callsTo(blankNonCode(raw), name).map((c) => ({ file, name, ...c })),
    ),
  )

describe("every production caller of the compaction trigger names its session", () => {
  test("the scan finds the call sites at all — it must not pass by finding nothing", () => {
    // Without this the whole file is satisfied by a broken parser.
    expect(callers.length).toBeGreaterThanOrEqual(4)
    const files = new Set(callers.map((c) => path.basename(c.file)))
    expect([...files].sort()).toEqual(["compaction.ts", "processor.ts", "prompt.ts", "prune.ts"])
  })

  test("no call site omits sessionID", () => {
    const missing = callers
      .filter((c) => !/\bsessionID\b/.test(c.args))
      .map((c) => `${path.relative(SRC, c.file)}:${c.line} ${c.name}(${c.args.replace(/\s+/g, " ").trim()})`)
    expect(missing).toEqual([])
  })
})

describe("the comment blanker does not eat the code it is scanning", () => {
  test("code survives, comments and string bodies do not", () => {
    const blanked = blankNonCode(`const a = 1 // isOverflow({ model })\nconst b = "isOverflow(x)"\nisOverflow({ sessionID })`)
    expect(callsTo(blanked, "isOverflow")).toHaveLength(1)
    expect(callsTo(blanked, "isOverflow")[0]!.args).toContain("sessionID")
  })

  test("a member call on another object is not mistaken for the imported one", () => {
    expect(callsTo(blankNonCode("svc.isOverflow(input)"), "isOverflow")).toHaveLength(0)
  })
})

describe("the quantity the baseline is measured in has one definition", () => {
  // `prune.ts` and `overflow.ts` both feed the SAME baseline registry, and each carried its own
  // byte-identical copy of the token-total formula. Two definitions of one rule is this repository's
  // most-repeated defect, and here it would have been silent: a divergence makes the baseline the
  // minimum of two different quantities, which no assertion about either one alone could see.
  test("the token-total formula appears exactly once in src/", () => {
    const sites = walk(SRC)
      .map((f) => ({ file: f, code: blankNonCode(readFileSync(f, "utf8")) }))
      .filter(({ code }) => /\.total\s*\|\|/.test(code))
      .map(({ file }) => path.relative(SRC, file))
    expect(sites).toEqual(["session/overflow.ts"])
  })
})
