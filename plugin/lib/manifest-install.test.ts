// Guards the dependency-installer against the "prose install string executed as a shell command"
// bug class: a human instruction like `Install LM Studio (https://lmstudio.ai)…` crashes
// `/bin/bash -c` on the unbalanced paren. Rule: `install` is EITHER a runnable command OR, when
// `manual: true`, guidance the installer only prints. This test asserts both halves.
import { test, expect } from "bun:test"
import { shellBinAbsolute } from "./platform/shell"
import { execFileSync } from "node:child_process"
import { allDeps } from "./manifest"
import { installDep } from "./manage"

const deps = allDeps()

test("manifest actually exercises this invariant (has both manual and runnable install deps)", () => {
  expect(deps.some((d) => d.manual && d.install)).toBe(true)
  expect(deps.some((d) => !d.manual && d.install)).toBe(true)
})

test("every NON-manual install string is valid bash (would not crash the shell that runs it)", () => {
  // The shell is RESOLVED, not spelled `/bin/bash`. The installer runs these through the seam's shell,
  // and on a platform where that is the Git-shipped POSIX shell somewhere else entirely, naming the
  // POSIX location asserted a fact about a different machine — the strings were fine and the check
  // could not start the parser. Asking the same program the installer will ask keeps the claim honest.
  const shell = shellBinAbsolute()
  for (const d of deps) {
    if (!d.install || d.manual) continue
    // `-n` parses without executing — a non-zero exit means a syntax error, which throws here.
    expect(() => execFileSync(shell, ["-nc", d.install!], { stdio: "pipe" })).not.toThrow()
  }
})

test("installDep never executes a manual dep (prints guidance instead)", async () => {
  // A prose install string with a paren would crash bash if run; installDep must skip it.
  const r = await installDep({ kind: "service", name: "test-manual", required: false, purpose: "test", install: "Install Foo (https://foo.example)", manual: true })
  expect(r.ok).toBe(false)
  expect(r.skipped).toBeTruthy()
  expect(r.out).toBe("")
})
