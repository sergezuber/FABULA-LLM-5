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

const FORBIDDEN = [/claude/i, /anthropic/i, /opencode/i, /discord/i, /\bmimo\b/]

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
      const onlyClaude = /claude/i.test(line) && !/anthropic|opencode|discord|\bmimo\b/i.test(line)
      if (onlyClaude && isModelListContext(line)) return
      violations.push(`${rel}:${i + 1}\t${line.trim().slice(0, 140)}`)
    })
  }
  if (violations.length) {
    console.error("Naming-policy leaks (scrub or add a documented contract to the allowlist):\n" + violations.join("\n"))
  }
  expect(violations).toEqual([])
})
