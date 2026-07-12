// Scheduler run-ledger (state + staleness only, no always-on
// force-replay). Pure read/stamp/overdue helpers; the file IO lives here, the launchd part in the job/tool.
// Records {ranAt, ok} per job label so list_scheduled can say "last ran / OVERDUE" — closing the only FABULA
// autonomous subsystem that had ZERO run-state. We DELIBERATELY do NOT force-rerun missed jobs: launchd
// already coalesces a missed StartCalendarInterval into one fire on wake; replaying N 35B inferences would
// stack into the 48GB ceiling (documented kernel-panic/OOM) and re-run stale side-effects.

import { promises as fs } from "node:fs"

export interface LedgerEntry { ranAt: number; ok: boolean }
export type Ledger = Record<string, LedgerEntry>
export const OVERDUE_MS = 26 * 60 * 60 * 1000 // a daily job unseen for >26h is overdue (one missed window + slack)

export async function readLedger(path: string): Promise<Ledger> {
  try {
    const j = JSON.parse(await fs.readFile(path, "utf8"))
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Ledger) : {}
  } catch { return {} }
}

// Atomic write (tmp + rename) so a job's stamp can never leave a half-written ledger. Read-modify-write is
// not lock-protected — scheduled jobs fire at distinct minutes so concurrent stamps are rare; the atomic
// rename still guarantees no corruption (worst case: a rare lost update, never a broken file).
export async function stampLedger(path: string, label: string, entry: LedgerEntry): Promise<void> {
  const led = await readLedger(path)
  led[label] = { ranAt: Number(entry.ranAt) || Date.now(), ok: !!entry.ok }
  const tmp = path + ".tmp"
  await fs.writeFile(tmp, JSON.stringify(led, null, 2), "utf8")
  await fs.rename(tmp, path)
}

export function isOverdue(entry: LedgerEntry | undefined, nowMs: number, maxAgeMs = OVERDUE_MS): boolean {
  return !entry || typeof entry.ranAt !== "number" || nowMs - entry.ranAt > maxAgeMs
}

function ago(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000))
  if (m < 60) return m + "m ago"
  const h = Math.floor(m / 60)
  if (h < 48) return h + "h ago"
  return Math.floor(h / 24) + "d ago"
}

// Human annotation for one job in list_scheduled.
export function annotate(slug: string, label: string, led: Ledger, nowMs: number, maxAgeMs = OVERDUE_MS): string {
  const e = led[label]
  if (!e || typeof e.ranAt !== "number") return `${slug} — never ran`
  const failed = e.ok ? "" : " (last run FAILED)"
  const overdue = nowMs - e.ranAt > maxAgeMs ? " ⚠️ OVERDUE" : ""
  return `${slug} — last ran ${ago(nowMs - e.ranAt)}${failed}${overdue}`
}
