// Token-lint: the injected Plugins panel must theme off named --fab-* tokens, never raw hex.
// Raw hex is allowed ONLY inside the :root token-definition block. Reads the real Swift source.
import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

const swift = readFileSync(path.join(import.meta.dir, "..", "..", "app", "FabulaApp.swift"), "utf8")

function panelJS(): string {
  const start = swift.indexOf('let pluginsPanelJS = """')
  expect(start).toBeGreaterThan(0)
  const end = swift.indexOf('\n        """', start)
  expect(end).toBeGreaterThan(start)
  return swift.slice(start, end)
}

test("the panel JS contains NO raw hex colors (all via var(--fab-*))", () => {
  const js = panelJS()
  const hex = js.match(/#[0-9a-fA-F]{6}\b/g) || []
  expect(hex).toEqual([]) // every colour is a token reference now
})

test("the panel JS actually references FABULA tokens", () => {
  const js = panelJS()
  for (const tok of ["var(--fab-surface)", "var(--fab-border)", "var(--fab-fg)", "var(--fab-fg-muted)", "var(--fab-switch-on)", "var(--fab-accent)"])
    expect(js).toContain(tok)
})

test("the :root token block defines the role + domain families", () => {
  // role
  for (const t of ["--fab-bg:", "--fab-surface:", "--fab-border:", "--fab-fg:", "--fab-fg-muted:", "--fab-fg-subtle:", "--fab-accent:"])
    expect(swift).toContain(t)
  // domain families (the ZCode taxonomy: git / diff / terminal / context)
  for (const t of ["--fab-git-added:", "--fab-diff-added:", "--fab-diff-removed:", "--fab-term-bg:", "--fab-ctx-1:", "--fab-ctx-7:"])
    expect(swift).toContain(t)
})

test("the accent is FABULA's own (not a sky-blue clone)", () => {
  const m = swift.match(/--fab-accent:(#[0-9a-fA-F]{6})/)
  expect(m).toBeTruthy()
  // our accent is a teal-green; assert it is NOT a blue (blue = B channel dominant over R and G)
  const hex = m![1]
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), bl = parseInt(hex.slice(5, 7), 16)
  expect(g).toBeGreaterThan(bl - 1) // green >= blue-ish → not a blue accent
  expect(bl).toBeLessThan(230)      // not a saturated blue
})

test("the permission-mode picker (Item 6 in the UI) is wired via the pmode bridge action", () => {
  expect(swift).toContain("case \"pmode\"")   // Swift bridge handles it
  expect(panelJS()).toContain("call('pmode'") // panel calls it
})
