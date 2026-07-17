// Guards the dependency-installer against the "prose install string executed as a shell command"
// bug class: a human instruction like `Install LM Studio (https://lmstudio.ai)…` crashes
// `/bin/bash -c` on the unbalanced paren. Rule: `install` is EITHER a runnable command OR, when
// `manual: true`, guidance the installer only prints. This test asserts both halves.
import { test, expect } from "bun:test"
import { execFileSync } from "node:child_process"
import { allDeps } from "./manifest"
import { installDep } from "./manage"

const deps = allDeps()

test("manifest actually exercises this invariant (has both manual and runnable install deps)", () => {
  expect(deps.some((d) => d.manual && d.install)).toBe(true)
  expect(deps.some((d) => !d.manual && d.install)).toBe(true)
})

test("every NON-manual install string is valid bash (would not crash /bin/bash -c)", () => {
  for (const d of deps) {
    if (!d.install || d.manual) continue
    // `bash -n` parses without executing — exits non-zero on a syntax error (throws here).
    expect(() => execFileSync("/bin/bash", ["-nc", d.install!], { stdio: "pipe" })).not.toThrow()
  }
})

test("installDep never executes a manual dep (prints guidance instead)", async () => {
  // A prose install string with a paren would crash bash if run; installDep must skip it.
  const r = await installDep({ kind: "service", name: "test-manual", required: false, purpose: "test", install: "Install Foo (https://foo.example)", manual: true })
  expect(r.ok).toBe(false)
  expect(r.skipped).toBeTruthy()
  expect(r.out).toBe("")
})
