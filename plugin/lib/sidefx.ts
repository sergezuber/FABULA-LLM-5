// Side-effect ledger for auto-rewind (W2). ACRFence (arXiv:2603.20625): checkpoint-restore reverts FILES
// only — non-idempotent side effects performed during the failed streak (package installs, DB migrations,
// network mutations, VCS pushes, container/service starts) survive the file revert and DOUBLE-FIRE on the
// retry, invisibly. This PURE detector flags them from the bash/tool call so the rewind steer warns the
// model to account for them. Deliberately conservative: a false positive only adds a harmless caution line.

export interface SideEffect { kind: string; detail: string }

const RULES: [string, RegExp][] = [
  ["package-install", /\b(pip3?|uv|poetry|conda)\s+(install|add)\b|\bnpm\s+(install|i|add|ci)\b|\byarn\s+add\b|\bpnpm\s+(install|add|i)\b|\bapt(-get)?\s+install\b|\bbrew\s+install\b|\bcargo\s+(install|add)\b|\bgo\s+get\b|\bgem\s+install\b/i],
  ["db-migration", /\balembic\b|\bflyway\b|\bliquibase\b|\b(prisma|knex|sequelize|typeorm)\b[^\n]*\bmigrat/i, ],
  ["db-migration", /\b(rails|django-admin|(python\s+)?manage\.py|artisan|dotnet\s+ef)\b[^\n]*\bmigrat/i],
  ["network-mutation", /\bcurl\b[^|;&]*\s-X\s*(POST|PUT|DELETE|PATCH)\b|\bcurl\b[^|;&]*(--data|--json|-d\s)\b|\bwget\b[^|;&]*--post|\bhttp(ie)?\b[^|;&]*\b(POST|PUT|DELETE)\b/i],
  ["vcs-push", /\bgit\s+push\b|\bgh\s+(pr|release|repo)\s+create\b|\bgit\s+remote\s+add\b/i],
  ["service-start", /\bdocker\s+(run|start)\b|\bdocker[- ]compose\s+up\b|\bkubectl\s+apply\b|\bsystemctl\s+(start|enable)\b|\bnohup\b/i],
]

/** The non-idempotent effect of a tool call, or null when it is safe to replay (pure file edits, reads,
 *  idempotent commands). Only bash-family tools carry these effects. */
export function nonIdempotentEffect(tool: string, args: any): SideEffect | null {
  if (tool !== "bash" && tool !== "bash_tool") return null
  const cmd = args?.command ?? args?.cmd ?? args?.script
  if (typeof cmd !== "string" || !cmd) return null
  for (const [kind, re] of RULES) if (re.test(cmd)) return { kind, detail: cmd.trim().replace(/\s+/g, " ").slice(0, 120) }
  return null
}

/** The ledger line for the rewind steer. Empty when nothing non-idempotent happened (honest — no warning).
 *  Uses the vocabulary the model must act on: the revert did NOT undo these; they may double-apply. */
export function renderLedger(effects: SideEffect[]): string {
  if (!effects.length) return ""
  const lines = effects.map((e, i) => `(${i + 1}) [${e.kind}] \`${e.detail}\``)
  return ` ⚠️ SIDE-EFFECT LEDGER — the file revert did NOT undo these external effects from the reverted attempt(s): ${lines.join("; ")}.` +
    ` They are non-idempotent and may DOUBLE-APPLY on retry (the checkpoint restored files only) — make the retry idempotent or undo them yourself before re-running.`
}
