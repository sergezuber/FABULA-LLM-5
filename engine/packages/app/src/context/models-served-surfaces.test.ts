import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "fs"
import nodePath from "path"

// Every surface that SHOWS the model list must re-ask as it opens.
//
// This exists because the fix was written four times before it landed. The list is offered by FIVE
// components in two directories, and the one being edited was never the one on screen: a live check
// kept showing a stopped runtime's model in the menu while the route correctly answered "hidden".
// Nothing failed — the route was right, the filter was right, and the surface being measured was a
// different file each time. So the guard is not about behaviour, it is about the ENUMERATION: a
// sixth surface must not be able to join quietly.
//
// It reads source text, which is a weak instrument and is chosen deliberately: the alternative is
// mounting the real components, which needs a router, a dialog host and a live engine — a rig whose
// failures would say nothing about this rule.

const ROOT = nodePath.join(import.meta.dir, "..")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = nodePath.join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

/**
 * A file READS the model list. Deliberately the widest honest rule and with no exceptions: the
 * first version tried to separate "renders" from "counts" and matched three of the six real
 * surfaces, because half of them wrap the call across a line break. A rule with exceptions is a
 * rule that rots; a screen that merely counts the models is showing the same list, and that number
 * has to be true when it is shown too.
 */
function readsTheList(text: string): boolean {
  return /\bmodels?\s*\.\s*list\b/s.test(text.replace(/\s*\n\s*/g, ""))
}

// SURFACES only. `components/` and `pages/` are what a person looks at; `context/` is plumbing that
// passes the list along without showing it, and asking IT to re-fetch would say nothing about
// whether the menu on screen is true. The split is structural, so a new surface lands in it by
// existing rather than by being remembered.
const surfaces = sourceFiles(ROOT)
  .filter((file) => /\/(components|pages)\//.test(file))
  .map((file) => ({ file: nodePath.relative(ROOT, file), text: readFileSync(file, "utf8") }))
  .filter((f) => readsTheList(f.text))

describe("every surface that shows the model list re-asks as it opens", () => {
  test("the enumeration is not empty — a matcher that finds nothing would pass vacuously", () => {
    expect(surfaces.length).toBeGreaterThanOrEqual(6)
  })

  test("each one calls refresh", () => {
    const missing = surfaces.filter((f) => !/\.refresh\(\)/.test(f.text)).map((f) => f.file)
    expect(missing).toEqual([])
  })

  test("the context really offers refresh — the call sites would otherwise be pointing at nothing", () => {
    const context = readFileSync(nodePath.join(ROOT, "context/models.tsx"), "utf8")
    expect(context).toContain("refresh:")
    expect(context).toContain("refetchServed()")
  })
})
