// Verify-command detection for the done-gate. Pure: given a directory listing (+ parsed
// package.json scripts), decide how to verify the project. The tool runs the result; the model must
// call verify_done before claiming a coding task is finished, and only a green run counts as done.

export interface VerifyCmd { cmd: string; label: string }

/**
 * Decide the verify command. `files` = filenames present in the project root. `scripts` =
 * package.json "scripts" object (if any). Returns null if nothing recognizable.
 * Order: explicit test script → language-native test → build.
 */
export function detectVerifyCommand(files: string[], scripts?: Record<string, string> | null): VerifyCmd | null {
  const has = (f: string) => files.includes(f)
  const bun = has("bun.lockb") || has("bun.lock") || has("bunfig.toml")

  if (scripts && typeof scripts.test === "string" && scripts.test.trim() && !/no test specified/i.test(scripts.test))
    return { cmd: bun ? "bun test" : has("yarn.lock") ? "yarn test" : has("pnpm-lock.yaml") ? "pnpm test" : "npm test", label: "package test script" }

  if (scripts && typeof scripts.build === "string" && scripts.build.trim())
    return { cmd: bun ? "bun run build" : "npm run build", label: "package build script" }

  if (has("pyproject.toml") || has("pytest.ini") || has("setup.cfg") || has("tox.ini"))
    return { cmd: "python -m pytest -q", label: "pytest" }

  if (has("go.mod")) return { cmd: "go build ./... && go test ./...", label: "go build+test" }
  if (has("Cargo.toml")) return { cmd: "cargo test", label: "cargo test" }
  if (has("Makefile") || has("makefile")) return { cmd: "make test", label: "make test" }
  if (has("Gemfile") && has("Rakefile")) return { cmd: "bundle exec rake test", label: "rake test" }

  return null
}

/** Summarize a verify run for the model (pass/fail + a tail of the output). */
export function verifyReport(passed: boolean, label: string, cmd: string, output: string, tail = 4000): string {
  const head = passed
    ? `✅ VERIFIED DONE — \`${cmd}\` (${label}) passed.`
    : `❌ NOT DONE — \`${cmd}\` (${label}) FAILED. The task is NOT complete; fix the errors below and re-verify. Do not report success yet.`
  const body = output.length > tail ? output.slice(-tail) : output
  return `${head}\n\n--- ${label} output (tail) ---\n${body.trim() || "(no output)"}`
}
