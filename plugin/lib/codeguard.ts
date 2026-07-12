// Guards for execute_code. Local execution is NOT a sandbox (use a
// Docker backend for untrusted/darkweb-triggered code). These are defense-in-depth, not a jail:
//   1. scanCode — block obvious catastrophic / RCE / exfil patterns (best-effort static scan).
//   2. scrubEnv — strip secrets from the child env so leaked code can't read API keys.
// Pure + unit-testable. Reuses the shell blocklist for embedded shell strings.

import { checkCommand } from "./cmdguard"

export interface CodeVerdict { blocked: boolean; reason: string; code: string }
const OK: CodeVerdict = { blocked: false, reason: "", code: "allow" }

// Catastrophic / exfil patterns across Python & Node.
const CODE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(os\.system|subprocess\.(run|call|Popen|check_output)|os\.popen)\s*\(/i, "shell_spawn"],     // → also run checkCommand on string args
  [/\bchild_process\b|\brequire\(\s*['"]child_process['"]\)|execSync|spawnSync/i, "node_shell_spawn"],
  [/\bshutil\.rmtree\s*\(\s*['"]?\/(?!tmp|var\/folders)/i, "rmtree_root"],                          // rmtree of a root-ish path
  [/\b(os\.remove|os\.unlink|fs\.(unlink|rm)Sync?)\s*\(\s*['"]\/(?:etc|bin|usr|System)\b/i, "delete_system"],
  [/169\.254\.169\.254|169\.254\.170\.2|100\.100\.100\.200|metadata\.google\.internal/i, "cloud_metadata"],
  [/\bsocket\.socket\b[\s\S]{0,200}\b(SOCK_STREAM)\b[\s\S]{0,200}\b(connect|bind)\b/i, "raw_socket"], // reverse-shell shape
  [/\/dev\/tcp\//i, "devtcp"],
  [/\b__import__\(\s*['"]os['"]\s*\)\s*\.\s*system/i, "obfuscated_os_system"],
  [/\b(eval|exec)\s*\(\s*(base64|atob|bytes\.fromhex|codecs\.decode|b64decode)/i, "eval_decoded"],
]

/** Best-effort danger scan. `lang` ∈ {python,node}. */
export function scanCode(lang: string, code: string): CodeVerdict {
  if (typeof code !== "string" || !code) return OK
  // embedded shell strings: pull quoted args of system/subprocess/exec calls and run the shell blocklist
  for (const m of code.matchAll(/(?:system|run|Popen|check_output|popen|execSync|spawnSync|exec)\s*\(\s*(?:\[?\s*)?["'`]([^"'`]{2,200})["'`]/gi)) {
    const v = checkCommand(m[1])
    if (v.blocked) return { blocked: true, code: "embedded_" + v.code, reason: `embedded shell command is dangerous: ${v.reason}` }
  }
  for (const [re, code2] of CODE_PATTERNS) {
    if (re.test(code)) {
      // shell_spawn/node_shell_spawn alone are not auto-blocked (legit uses exist); only block if a
      // catastrophic embedded command was found (handled above) or a hard pattern matches.
      if (code2 === "shell_spawn" || code2 === "node_shell_spawn") continue
      return { blocked: true, code: code2, reason: `code contains a ${code2} pattern (catastrophic/RCE/exfil).` }
    }
  }
  return OK
}

// env vars that must NOT be visible to executed code (secrets).
const SECRET_ENV = /(_API_KEY|_TOKEN|_SECRET|_KEY|PASSWORD|PASSWD|NVIDIA|ZHIPU|OPENAI|AWS_|GITHUB_TOKEN|HF_TOKEN|SLACK)/i
// allowlist of harmless vars to keep so tools still work.
const KEEP_ENV = /^(PATH|HOME|USER|LANG|LC_|TERM|TMPDIR|SHELL|PWD|NODE_|PYTHON|VIRTUAL_ENV)/

/** Produce a child env with secrets stripped (env-scrub). */
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (KEEP_ENV.test(k)) { out[k] = v; continue }
    if (SECRET_ENV.test(k)) continue           // drop secrets
    out[k] = v                                  // keep other non-secret vars
  }
  return out
}
