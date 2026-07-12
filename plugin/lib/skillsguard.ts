// skills_guard. Vets a skill (downloaded or auto-generated) BEFORE it is loaded/run.
// Pure + unit-testable. Consumer = the skill loader (not wired yet — no skills feature exists).
// Reuses the command + threat scanners so policy stays in one place.

import { checkCommand } from "./cmdguard"
import { scanThreats } from "./threatscan"
import { containsHardSecret } from "./redact"

export interface SkillVerdict {
  blocked: boolean
  reasons: string[]
  trusted: boolean
}

// Skill-specific danger patterns beyond the shell blocklist.
const SKILL_PATTERNS: Array<[RegExp, string]> = [
  [/\bcurl\b[^\n]*\|\s*(ba)?sh\b/i, "pipe_curl_to_shell"],
  [/\b(base64\s+(-d|--decode)|xxd\s+-r)\b[^\n]*\|\s*(ba|z)?sh\b/i, "decode_pipe_shell"],
  [/\b(eval|exec)\s*\(\s*(base64|atob|decode|fromCharCode)/i, "eval_decoded"],
  [/\bnc\b\s+-[a-z]*e|\b(bash|sh)\s+-i\s+>&\s*\/dev\/tcp\//i, "reverse_shell"],
  [/\/dev\/tcp\/\d/i, "raw_socket_exec"],
  [/~\/\.(ssh|aws|config\/gcloud)\b|\.env\b|id_rsa\b/i, "credential_path_access"],
  [/\bcrontab\b|LaunchAgents|LaunchDaemons|\.bashrc|\.zshrc|\.profile\b/i, "persistence_target"],
  [/\b(pip|npm|pnpm|yarn|gem|cargo)\s+install\b/i, "installs_packages"],
]

/**
 * Assess a skill's text. `trusted` = authored locally by the user (skip soft checks). Untrusted
 * (downloaded/auto-generated) skills are blocked on ANY hard signal.
 */
export function assessSkill(name: string, content: string, opts: { trusted?: boolean } = {}): SkillVerdict {
  const reasons: string[] = []
  const trusted = !!opts.trusted
  const text = typeof content === "string" ? content : ""

  // 1. shell blocklist on fenced code blocks (and the whole text as a fallback)
  const blocks = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/gi)].map((m) => m[1])
  for (const b of blocks.length ? blocks : [text]) {
    const v = checkCommand(b.replace(/\n/g, " ; "))
    if (v.blocked) reasons.push(`shell:${v.code}`)
  }
  // 2. skill-specific patterns
  for (const [re, code] of SKILL_PATTERNS) if (re.test(text)) reasons.push(code)
  // 3. prompt-injection / invisible unicode
  const scan = scanThreats(text)
  if (scan.injection) reasons.push(...scan.markers.map((m) => `threat:${m}`))
  // 4. embedded secrets (a skill shipping a key is suspicious)
  if (containsHardSecret(text)) reasons.push("embedded_secret")

  // Trusted skills: report reasons but don't block (user owns them). Untrusted: block on any signal.
  const blocked = !trusted && reasons.length > 0
  return { blocked, reasons: [...new Set(reasons)], trusted }
}

export function skillBlockedMessage(name: string, v: SkillVerdict): string {
  return `[BLOCKED by FABULA skills_guard] Skill "${name}" was refused (untrusted source, danger signals: ` +
    `${v.reasons.join(", ")}). Review it manually before enabling.`
}
