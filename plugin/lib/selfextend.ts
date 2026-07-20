// Self-extension core (pure, unit-testable): scaffold a NEW fabula plugin from a spec and validate it
// against the one-plugin-per-file contract BEFORE it is written. This is the RULE #9 way to let the
// supervised model grow its own supervised tool belt: the harness scaffolds + enforces the contract
// deterministically, so a malformed self-written plugin can never break loading. The plugin file it
// produces is a valid `Fabula*` factory exporting exactly one tool; the model supplies the execute body.

export function slug(name: string): string {
  const s = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
  return s || "custom"
}

export function pluginFileName(name: string): string {
  return `fabula-${slug(name)}.ts`
}

export function factoryName(name: string): string {
  const pascal = slug(name).split("-").filter(Boolean).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("")
  return `Fabula${pascal || "Custom"}`
}

export interface ScaffoldSpec {
  name: string          // plugin name, e.g. "csv tools"
  toolName: string      // tool id the model will call, e.g. "csv_stats"
  toolDescription: string
  argDescription?: string
  body: string          // the execute() body the model supplies; must `return` a string or {output}
}

const IDENT = /^[a-z_][a-z0-9_]*$/i

export function scaffoldPlugin(spec: ScaffoldSpec): string {
  const factory = factoryName(spec.name)
  const tn = spec.toolName
  const desc = JSON.stringify(spec.toolDescription || tn)
  const argDesc = JSON.stringify(spec.argDescription || "input for this tool")
  return `// FABULA self-authored plugin: ${slug(spec.name)}. One Fabula* factory, one tool (one-plugin-per-file rule).
import { tool } from "@mimo-ai/plugin"
import type { Plugin } from "@mimo-ai/plugin"
import { z } from "zod"

export const ${factory}: Plugin = async () => ({
  tool: {
    ${tn}: tool({
      description: ${desc},
      args: { input: z.string().describe(${argDesc}) },
      async execute(args: { input: string }, ctx: any) {
${spec.body.split("\n").map((l) => "        " + l).join("\n")}
      },
    }),
  },
})
`
}

export interface Validation { ok: boolean; errors: string[] }

/** Enforce the one-plugin-per-file contract on a plugin source string. */
/**
 * Capabilities a SELF-AUTHORED plugin may not reach for.
 *
 * The shape check below (one `Fabula*` export) protects plugin LOADING; it says nothing about what the
 * body does. A self-written plugin is executed from the next engine start with full plugin privileges —
 * before any gate, guard or approval can see it — so a body that shells out, spawns a process, reads
 * credentials or fetches and evaluates remote code would be running with more authority than any tool
 * call the guards actually inspect. Refusing at WRITE time is the only point where this is cheap.
 *
 * Each entry is a capability, not a spelling, so an alternative import path for the same power is still
 * caught. This is a deny-list and therefore not a sandbox: it stops the obvious escalations, and the
 * honest limit is stated in the tool's own docs rather than implied away.
 */
const FORBIDDEN_CAPABILITIES: [RegExp, string][] = [
  // Process spawning, in every spelling the runtime offers — `Bun.$` is the idiomatic one here and the
  // first version missed it entirely, so the canonical way to run a shell command sailed through.
  [/\bchild_process\b|\bnode:child_process\b|\bBun\s*(\.\s*(spawn(Sync)?|\$)|\[)|\bexecSync\b|\bexecFile\b|\bspawnSync\b/, "spawns processes"],
  // Runtime evaluation, including the computed-member dodge `(globalThis)["ev"+"al"]`.
  [/\beval\b\s*[\(\[]|\bFunction\s*\(|\bnew\s+Function\b|\b(globalThis|window|self|global)\s*\[/, "evaluates code at runtime"],
  // Credential MATERIAL — paths and stores. Deliberately NOT `process.env.X`: reading one named env var
  // is what every ordinary plugin does, and the first version's `\.env\b` matched it, so effectively
  // every non-trivial plugin was refused with a reason that was not true of it.
  [/\.ssh\b|\.aws\b|\.gnupg\b|\bid_rsa\b|\bid_ed25519\b|\bnetrc\b|["'`][^"'`]*\/\.env["'`]|readFileSync\([^)]*\.env/, "reads credential material"],
  // Harvesting the environment wholesale, or reaching it through a computed key to dodge the check.
  [/\bprocess\s*\[|\bprocess\s*\.\s*env\s*\[|\bObject\s*\.\s*(keys|entries|assign)\s*\(\s*process\s*\.\s*env/, "harvests the environment"],
  [/fabula-permissions\.json|fabula-state\.json|\bAGENT_PROTECTED\b/, "edits the supervision layer's own state"],
  // Recursive/bulk deletion. A plugin cleaning up one temp file of its own is ordinary work, so a bare
  // `unlinkSync` is no longer refused — the first version blocked that too, with a misleading reason.
  [/\brmSync\s*\([^)]*recursive|\brm\s+-rf\b|\brmdirSync\s*\([^)]*recursive/, "deletes files recursively"],
  // Code fetched at runtime, including the `data:` URL form that carries a fetched body.
  [/\bimport\s*\(\s*[`'"](https?|data):/, "imports code from the network"],
]

/** Comments are prose, not behaviour: the word "credentials" in an explanation is not a capability, and
 *  refusing it taught nothing. Strings are KEPT — a credential path only ever appears as one. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
}

/**
 * Normalise away the syntax that carries no meaning but breaks naive matching.
 *
 * Chasing spellings with regexes is a losing game and this function is the admission of it: an
 * independent reviewer walked through `(globalThis as any)["ev"+"al"]`, `(0, eval)`, `const F = Function`
 * and `(Bun as any)["$"]` — every one a normal thing a TypeScript author would write, every one past the
 * first version. Type assertions, comma-operator wrappers and redundant parentheses are erased here so
 * the capability rules see the shape rather than the decoration, and an ALIAS of a dangerous global is
 * treated as the global itself, because binding it to a name changes nothing about what it can do.
 *
 * This is still a deny-list, not a sandbox — said plainly here and in the tool's own description.
 */
function normalizeCode(src: string): string {
  let t = codeOnly(src)
  t = t.replace(/\s+as\s+(unknown|any|never|[A-Za-z_$][\w$.<>\[\]]*)/g, " ") // ` as any`, ` as unknown as X`
  t = t.replace(/\(\s*0\s*,\s*([^)]+)\)/g, "$1") // (0, eval) → eval
  // ((x)) → x, but ONLY where the parenthesis is grouping rather than CALLING. The first version could
  // not tell the difference, so it rewrote `execSync(cmd)` to `execSynccmd` and `eval(s)` to `evals` —
  // destroying the word boundary the rules match on. Every dangerous call with a VARIABLE argument
  // therefore passed, while the literal-argument spelling of the same call was refused: the normaliser
  // written to close the dodges opened a wider one. A `(` preceded by an identifier, `)` or `]` is a call.
  for (let i = 0; i < 3; i++) t = t.replace(/(^|[^\w$)\]])\(\s*([A-Za-z_$][\w$.]*)\s*\)/g, "$1$2")
  // An alias IS the thing: `const g = globalThis; g["ev"+"al"]` and `const F = Function` both hand the
  // body the capability under a new name. Rewriting is ADDITIVE — an earlier version consumed the
  // declaration itself and, in doing so, hid `process["e"+"nv"]` from the very rule meant to catch it.
  const aliases = [...t.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(globalThis|Function|eval|Bun|process|require)\b/g)]
  for (const [, alias, real] of aliases) {
    t = t.replace(new RegExp(`\\b${alias}\\s*\\[`, "g"), `${real}[`)
    t = t.replace(new RegExp(`\\b${alias}\\s*\\(`, "g"), `${real}(`)
    t += `\n/* alias ${alias} -> ${real} */ ${real}`
  }
  return t
}

export function validatePluginSource(src: string): Validation {
  const errors: string[] = []
  const text = String(src)
  const exports = [...text.matchAll(/^export\s+(?:const|function|class)\s+(\w+)/gm)].map((m) => m[1])
  if (exports.length === 0) errors.push("no top-level export found — a plugin file must export one Fabula* factory")
  if (exports.length > 1) errors.push(`must export EXACTLY one symbol (mimo runs every export as a plugin); found ${exports.length}: ${exports.join(", ")}`)
  if (exports.length === 1 && !/^Fabula/.test(exports[0])) errors.push(`the single export must be named Fabula* (got "${exports[0]}")`)
  const code = normalizeCode(text)
  for (const [re, what] of FORBIDDEN_CAPABILITIES) {
    if (re.test(code)) {
      errors.push(
        `the body ${what}, which a self-authored plugin may not do — it would run with full plugin ` +
          `privileges from the next start, ahead of every guard. Ask the user to add this capability by hand.`,
      )
    }
  }
  return { ok: errors.length === 0, errors }
}

/** Validate a spec before scaffolding (identifiers, non-empty body). */
export function validateSpec(spec: ScaffoldSpec): Validation {
  const errors: string[] = []
  if (!spec.name || !slug(spec.name)) errors.push("name is required")
  if (!spec.toolName || !IDENT.test(spec.toolName)) errors.push("toolName must be a valid identifier (letters/digits/underscore)")
  if (!spec.body || !/\breturn\b/.test(spec.body)) errors.push("body must contain a `return` (a string or an {output} object)")
  return { ok: errors.length === 0, errors }
}
