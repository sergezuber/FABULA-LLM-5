// Naming-policy gate (confirmed[18]). The public repo must not present FABULA as a Claude/Anthropic
// derivative or leak the engine's internal brand into user-facing source/docs: the words
// Claude/Anthropic and Claude model strings must not appear in TRACKED files, and user-facing prose
// says FABULA / the engine / `fabula` — never mimo/OpenCode. This test greps the FABULA-AUTHORED
// surface (the vendored upstream `engine/` tree and the permitted attribution files are exempt) and
// fails on any brand/model/authorship leak outside the explicit allowlist of KEPT contracts.
//
// This is the automated guard the audit asked for: it caught nothing by luck — the leaks it was
// written against (claude-sonnet test fixtures, an "Anthropic" comment, a `mimo run` in a public
// receipt) were scrubbed in the same pass; the gate exists so they can't silently regress.
import { test, expect } from "bun:test"
import { execSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"

const REPO = path.resolve(__dirname, "..", "..")

// Trees/files that legitimately carry upstream names and are EXEMPT wholesale:
//  - engine/ is the vendored upstream harness (its own source keeps its own names);
//  - the attribution files are where the naming policy explicitly PERMITS crediting the upstream;
//  - build/ignore/notes carry the upstream license header or raw external citations.
const EXEMPT_PREFIXES = [
  "engine/", "bin/", "node_modules/", "dist/",
  "docs/CREDITS.md", "SECURITY.md", "docs/research/", "build.sh", ".gitignore",
  // this gate itself: the policy-definition file necessarily NAMES the forbidden words in order to
  // forbid them and to list the kept contracts (same reason CLAUDE.md is gitignored).
  "plugin/__tests__/naming-policy.gate.test.ts",
]

// Substrings that make a line OK anywhere: the naming policy's KEPT contracts — renaming them would
// break the engine, wipe user data, or break external plugin bundles. Each is a real, documented contract.
const CONTRACT_TOKENS = [
  // engine config / npm package / env contracts
  "mimocode", "@mimo-ai", "MIMOCODE",
  // real engine binary + process names (setup.sh installs a `fabula` shim that execs `mimo`)
  "bin/mimo", "-v mimo", "mimo web", "mimo serve", "mimo run", "mimo --version", '"mimo"', "'mimo'", "mimo-named",
  // engine source PATHS referenced from docs (the tree is literally packages/opencode)
  "packages/opencode", "/opencode/src",
  // OpenCode contracts kept inert (localStorage keys / build envs / deep-link scheme) + the source scrubber
  "opencode.global.dat", "VITE_OPENCODE", "opencode://", "/OpenCode/g", "indexOf('OpenCode')",
  // The client-identity VALUE the adapter puts on the wire, and the runtime symbol that reads it.
  // Not a brand claim and not renameable: a serving runtime fingerprints this exact literal to
  // enable its unconditional cross-session prefix restore, and any other string silently selects
  // the weak branch (measured 2026-08-16: ~2.2 misses per task at ~48s each). Narrow on purpose —
  // the QUOTED literal and the symbol name only, so ordinary prose is still caught.
  '"opencode"', "_opencode_compact_tool_history_policy", "FABULA_CLIENT_HINT",
  // external plugin-bundle format (its own on-disk path + env-var names)
  ".claude-plugin", ".codex-plugin", "CLAUDE_PLUGIN_ROOT",
  // engine's own claude-import data markers (foreign sessions), not FABULA authorship
  "claude-import", "external_import", "DISABLE_CLAUDE_IMPORT", "claudeMd",
  // the gitignored contributor guide's filename
  "CLAUDE.md",
  // functional cloud-provider FAMILY classifier (anthropic is a peer of openai/google here, not a brand claim)
  "openai|anthropic|google",
  // permitted inline attribution mark (the acknowledgement link)
  "MiMoCode", "MiMo-Code",
]

// `discord` is bounded like `mimo` already is. Unbounded, it matched "DISCORDANT" — the exact statistical
// term for McNemar's test — and reported a paired-test module as a foreign-brand leak. A hygiene gate that
// fires on correct English teaches people to route around it, and a gate people route around protects
// nothing. The brand is a word, so match a word.
const FORBIDDEN = [/claude/i, /anthropic/i, /opencode/i, /\bdiscord\b/i, /\bmimo\b/]

// The naming policy's ONE allowed use of "Claude": naming it as a MODEL in a model list / provider
// options (never as authorship). Encode that exception — a `claude` hit is OK when the same line
// enumerates other model families (e.g. the "ANY LLM · Qwen · Llama · GPT · Claude" diagram caption).
const OTHER_MODEL_FAMILIES = /\b(qwen|llama|gpt|gemini|mistral|deepseek|kimi|grok)\b/i
function isModelListContext(line: string): boolean {
  return OTHER_MODEL_FAMILIES.test(line)
}

function trackedFiles(): string[] {
  return execSync("git ls-files", { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean)
}

/**
 * A tracked path containing a backslash makes the repository impossible to check out on Windows.
 *
 * Not "awkward" — impossible, and for the WHOLE tree: `git checkout` answers
 * `error: invalid path '…'` and exits 128, so nothing lands and every job on that machine dies before
 * it starts. MEASURED here: eighty-seven such files reached the repository from a run that simulated
 * one platform on another, and the Windows side of the matrix went red at checkout, which reads as the
 * tests failing rather than as the tree being unfetchable.
 *
 * The rule needs no exceptions. A backslash is a legal character in a POSIX filename and is used by
 * nothing in this project on purpose, so the honest rule is the absolute one — which also means the
 * gate cannot be argued with later, one convenient path at a time.
 */
test("no tracked path contains a backslash — Windows cannot check out such a tree at all", () => {
  const offenders = trackedFiles().filter((p) => p.includes("\\"))
  expect(offenders.slice(0, 10)).toEqual([])
  expect(offenders.length).toBe(0)
})

/**
 * No tracked file carries the home directory of the machine it was authored on.
 *
 * MEASURED, and it is why this gate exists: `proxy/adapter.err.log.old` and
 * `adapter.err.log.pre25` — two hand-made copies illustrating log rotation — were tracked for 194
 * commits, each carrying one stack-trace line with the author's real home path, and both reached a
 * public repository. Nothing could have caught it: `.gitignore` said `*.log`, which does not match a
 * name whose suffix lands AFTER the extension, and no check looked for personal paths at all.
 *
 * The rule is written against THIS machine's home directory, read at runtime, and that is the whole
 * design. A username cannot be written down here — spelling one out would BE the leak this gate
 * exists to prevent — and reading it from the environment makes the rule true for every contributor
 * on every machine without naming any of them. A fictional path in a fixture (`/Users/dev`,
 * `/Users/kelvin`) is deliberately fine and stays fine: it belongs to nobody.
 */
test("no tracked file contains this machine's home directory", () => {
  const home = homedir()
  // A home of "/" or "" would match everything; refuse to run rather than pass vacuously.
  expect(home.length).toBeGreaterThan(4)

  const offenders = trackedFiles().flatMap((rel) => {
    const abs = path.join(REPO, rel)
    if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) return []
    const text = readFileSync(abs, "latin1")
    if (!text.includes(home)) return []
    const line = text.slice(0, text.indexOf(home)).split("\n").length
    return [`${rel}:${line}`]
  })

  expect(offenders).toEqual([])
})

test("naming policy: no Claude/Anthropic/mimo/OpenCode leaks in FABULA-authored tracked files", () => {
  const violations: string[] = []
  for (const rel of trackedFiles()) {
    if (EXEMPT_PREFIXES.some((p) => rel === p || rel.startsWith(p))) continue
    const abs = path.join(REPO, rel)
    let txt = ""
    try {
      if (statSync(abs).size > 2_000_000) continue // skip anything huge/binary-ish
      txt = readFileSync(abs, "utf8")
    } catch { continue }
    txt.split("\n").forEach((line, i) => {
      if (!FORBIDDEN.some((r) => r.test(line))) return
      if (CONTRACT_TOKENS.some((t) => line.includes(t))) return // a kept contract — allowed
      // "Claude" in a model list is the policy's one permitted use (naming a model, not authorship).
      const onlyClaude = /claude/i.test(line) && !/anthropic|opencode|\bdiscord\b|\bmimo\b/i.test(line)
      if (onlyClaude && isModelListContext(line)) return
      violations.push(`${rel}:${i + 1}\t${line.trim().slice(0, 140)}`)
    })
  }
  if (violations.length) {
    console.error("Naming-policy leaks (scrub or add a documented contract to the allowlist):\n" + violations.join("\n"))
  }
  expect(violations).toEqual([])
})
