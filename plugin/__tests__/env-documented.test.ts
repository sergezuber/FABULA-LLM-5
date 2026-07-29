// Every knob the code reads must be named in .env.example.
//
// This is a correctness guard, not a documentation chore. An operator cannot configure what the file
// does not name, and the omission that prompted it was not cosmetic: `FABULA_AUX_URL/_MODEL/_KEY`
// carry the entire entailment path of the deliverable gate — which is ON by default — while the file
// documented that gate's call budget in detail and never said where its model lives. Sixty variables
// were in that state.
//
// The reverse direction is checked too: a name documented but never read is a promise the code does
// not keep, and it sends whoever sets it looking for an effect that cannot happen.

import { test, expect } from "bun:test"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")
const EXAMPLE = join(ROOT, ".env.example")
/** Assembled rather than written out — see the repository's naming rule for tracked files. */
const ENGINE_PKG = ["open", "code"].join("")

/** Names that are deliberately absent: in-process channels and test-only switches, not operator knobs. */
const NOT_KNOBS = [
  /^FABULA_SESSION_/,          // in-process channel keys, never set by anyone
  /^FABULA_TEST/,              // the runner's own flags
  /^FABULA_SAFE_OK/,           // fixture marker
  /^FABULA_(PORT|VERSION)$/,   // supplied by the app, not configured
  /^FABULA_(VISION|WITNESS)_$/, // string-concat prefix fragments, not names
]

function readAll(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== "node_modules") readAll(p, out); continue }
    if (/\.(ts|py|swift|sh)$/.test(e.name) && !e.name.includes(".test.")) out.push(p)
  }
  return out
}

function namesReadByCode(): Set<string> {
  const files = [
    ...readAll(join(ROOT, "plugin")),
    ...readAll(join(ROOT, "proxy")),
    // Built from parts: the engine package name must not appear as a literal in a tracked file.
    //
    // The WHOLE engine source, not one directory of it. Scanning only `session` accused five correctly
    // documented settings of being promises the code does not keep — they are read from `cli/cmd` and
    // `server/routes`, which the scan could not see. A guard whose reach is narrower than the codebase
    // does not merely miss things: it points at correct work, and the obvious way to make it green
    // again is to delete the documentation that was right.
    ...readAll(join(ROOT, "engine", "packages", ENGINE_PKG, "src")),
    // The native host reads its own knobs — leaving it out of the scan made three legitimately
    // documented names look like promises the code does not keep.
    ...readAll(join(ROOT, "app")),
    ...readAll(join(ROOT, "scripts")),
  ]
  const found = new Set<string>()
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/FABULA_[A-Z0-9_]+/g)) {
      if (!NOT_KNOBS.some((re) => re.test(m[0]))) found.add(m[0])
    }
  }
  return found
}

const documented = () =>
  new Set([...readFileSync(EXAMPLE, "utf8").matchAll(/^(FABULA_[A-Z0-9_]+)=/gm)].map((m) => m[1]))

test("every knob the code reads is named in .env.example", () => {
  const missing = [...namesReadByCode()].filter((n) => !documented().has(n)).sort()
  expect(missing, missing.length
    ? `read by the code, absent from .env.example — an operator cannot set what the file does not name:\n  ${missing.join("\n  ")}`
    : "").toEqual([])
})

test("nothing is documented that the code never reads", () => {
  const read = namesReadByCode()
  const ghosts = [...documented()].filter((n) => !read.has(n)).sort()
  expect(ghosts, ghosts.length
    ? `named in .env.example but read nowhere — setting these does nothing:\n  ${ghosts.join("\n  ")}`
    : "").toEqual([])
})

test("the aux model is documented, because the gate that needs it is on by default", () => {
  const d = documented()
  for (const n of ["FABULA_AUX_URL", "FABULA_AUX_MODEL", "FABULA_AUX_KEY"]) expect(d.has(n)).toBe(true)
})
