import { describe, expect, test } from "bun:test"
import nodeFs from "fs"
import nodePath from "path"

// MEASURED 2026-08-01, end to end: the /global/fabula/plugins route derived a plugin's id from its
// FILENAME (`fabula-toolrouter.ts` → `toolrouter`) while the plugin gates itself on `tool-router`. The
// panel POSTs {id: row.id} and the handler writes it verbatim, so switching the tool router off wrote
// `disabled:["toolrouter"]` — a name nothing reads — and the next GET then computed `enabled` from the
// same wrong name and rendered the switch OFF while the plugin was still running. One of 40 plugins,
// which is exactly why the derivation looked right.
//
// This asserts the INVARIANT rather than the one case: whatever the manifest declares is what a consumer
// must key on, so a plugin added tomorrow with a hyphenated id cannot reintroduce the same defect.
const REPO = nodePath.resolve(import.meta.dir, "../../../../..")
const PLUGIN_DIR = nodePath.join(REPO, "plugin")

function manifestEntries(): { id: string; file: string; name: string }[] {
  const src = nodeFs.readFileSync(nodePath.join(PLUGIN_DIR, "lib", "manifest.ts"), "utf8")
  return [...src.matchAll(/id:\s*"([a-z0-9-]+)",\s*file:\s*"([^"]+)",\s*name:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => ({
    id: m[1]!,
    file: m[2]!,
    name: m[3]!,
  }))
}

describe("a plugin's id is what the manifest says, not what its filename suggests", () => {
  test("the manifest is readable and describes every plugin file on disk", () => {
    const entries = manifestEntries()
    expect(entries.length).toBeGreaterThan(30)
    const files = nodeFs.readdirSync(PLUGIN_DIR).filter((f) => /^fabula-.*\.ts$/.test(f) && !f.endsWith(".d.ts"))
    const declared = new Set(entries.map((e) => e.file))
    expect(files.filter((f) => !declared.has(f))).toEqual([])
  })

  test("the id a plugin GATES on is the id the manifest declares for its file", () => {
    const mismatches: string[] = []
    for (const e of manifestEntries()) {
      const src = nodeFs.readFileSync(nodePath.join(PLUGIN_DIR, e.file), "utf8")
      const gated = [...src.matchAll(/\b(?:gate|isEnabled)\(\s*"([a-z0-9-]+)"/g)].map((m) => m[1]!)
      if (gated.length && !gated.includes(e.id)) mismatches.push(`${e.file}: gates on ${gated.join("/")}, manifest says ${e.id}`)
    }
    expect(mismatches).toEqual([])
  })

  test("at least one id genuinely differs from its filename — otherwise this test proves nothing", () => {
    // The control. If every id happened to equal its filename derivation, the check above would pass
    // against the broken code too, and the whole file would be decoration.
    const derived = (file: string) => file.replace(/\.ts$/, "").replace(/^fabula-/, "")
    expect(manifestEntries().filter((e) => e.id !== derived(e.file)).length).toBeGreaterThan(0)
  })

  test("every plugin has a human name to show — the panel had one for 1 of 40", () => {
    for (const e of manifestEntries()) {
      expect(`${e.file}:${e.name.length > 0}`).toBe(`${e.file}:true`)
    }
  })
})
