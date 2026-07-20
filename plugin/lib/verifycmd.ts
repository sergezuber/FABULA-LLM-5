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

/**
 * Does this shell command look like the project's test suite being run by hand?
 *
 * The gates in this harness are driven by `verify_done`, so a model that types `npm test` into `bash`
 * instead produces NO evidence at all: no red streak, no rewind, no escalation, no terminal verdict, no
 * ledger record — and the run simply looks healthy while nothing is watching. An independent verifier
 * called that the largest unaddressed risk in the escalation work, and it is: every improvement to the
 * decision's fidelity is confined to trajectories that happen to use the tool.
 *
 * Deliberately conservative. A false positive here would count someone's unrelated script as a
 * verification and could push a healthy run toward giving up, so this matches the shapes that are
 * unambiguously a test invocation and nothing else.
 */
export function looksLikeVerifyCommand(raw: string): boolean {
  const c = String(raw ?? "").trim().toLowerCase()
  if (!c) return false
  // strip a leading `cd … &&` so a command run from a subdirectory is still recognised
  let body = c.replace(/^cd\s+\S+\s*&&\s*/, "")
  // `bash -c "npm test"` is the same invocation wearing a coat.
  const wrapped = body.match(/^(?:ba|z|da|k|c)?sh\s+-c\s+["'](.+)["']$/)
  if (wrapped) body = wrapped[1].trim()
  // A watch/continuous runner never terminates and never produces a final verdict — treating it as a
  // verification would attach a conclusion to a command that has not concluded.
  if (/--watch\b|\bwatch\b|:watch\b|--ui\b/.test(body)) return false
  return (
    /^(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/.test(body) ||
    /^(npx\s+)?(jest|vitest|mocha|ava)\b/.test(body) ||
    /^(python3?\s+-m\s+)?pytest\b/.test(body) ||
    /^python3?\s+-m\s+unittest\b/.test(body) ||
    /^go\s+test\b/.test(body) ||
    /^cargo\s+test\b/.test(body) ||
    /^(make|just)\s+(test|check)\b/.test(body) ||
    /^(gradle|mvn)\s+test\b/.test(body) ||
    /^(rspec|phpunit|dotnet\s+test)\b/.test(body)
  )
}

/**
 * What can be concluded from a test command's OUTPUT alone.
 *
 * Only "red" and "unknown" — never "green". A green from a shell run is not inferable: the engine's bash
 * metadata carries no exit code, so text is all there is, and text lies in the dangerous direction. This
 * repository's own runner prints ` 1732 pass\n 3 fail` on a FAILING suite; an earlier version of this
 * function answered "green" to it, and a false green resets the red streak, clears the failure notes and
 * refunds the rewind budget — erasing the evidence of a run that is actually broken. A missed red costs
 * one observation; a false green destroys the record.
 *
 * A failure signature therefore wins over any success wording, and success wording alone concludes
 * nothing. `PASS` is matched case-SENSITIVELY: with `/i` it matched the lowercase `pass` in every
 * runner's own summary line.
 */
export function verdictFromTestOutput(output: string, exitCode?: number | null): "red" | "unknown" {
  if (typeof exitCode === "number") return exitCode === 0 ? "unknown" : "red"
  const t = String(output ?? "")
  if (/\b[1-9]\d*\s+(failed|failures|failing|errors)\b/i.test(t)) return "red"
  if (/^\s*[1-9]\d*\s+fail\b/m.test(t)) return "red"
  if (/\bFAILED\b|\bAssertionError\b|Traceback \(most recent call last\)|^---\s*FAIL|\bFAIL\b|segmentation fault|\btest failed\b/m.test(t)) return "red"
  return "unknown"
}
