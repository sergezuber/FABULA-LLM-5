import { getFilename } from "@mimo-ai/shared/util/path"
import { type Session } from "@mimo-ai/sdk/v2/client"

type SessionStore = {
  session?: Session[]
  path: { directory: string }
}

export const workspaceKey = (directory: string) => {
  const value = directory.replaceAll("\\", "/")
  const drive = value.match(/^([A-Za-z]:)\/+$/)
  if (drive) return `${drive[1]}/`
  if (/^\/+$/i.test(value)) return "/"
  return value.replace(/\/+$/, "")
}

function sortSessions(now: number) {
  const oneMinuteAgo = now - 60 * 1000
  return (a: Session, b: Session) => {
    const aUpdated = a.time.updated ?? a.time.created
    const bUpdated = b.time.updated ?? b.time.created
    const aRecent = aUpdated > oneMinuteAgo
    const bRecent = bUpdated > oneMinuteAgo
    if (aRecent && bRecent) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    if (aRecent && !bRecent) return -1
    if (!aRecent && bRecent) return 1
    return bUpdated - aUpdated
  }
}

const isRootVisibleSession = (session: Session, directory: string) =>
  workspaceKey(session.directory) === workspaceKey(directory) && !session.parentID && !session.time?.archived

export const roots = (store: SessionStore) =>
  (store.session ?? []).filter((session) => isRootVisibleSession(session, store.path.directory))

export const sortedRootSessions = (store: SessionStore, now: number) => roots(store).sort(sortSessions(now))

// FABULA: group an already-sorted session list into date buckets (Today / Yesterday / Mon D),
// localized via Intl so no new i18n keys are needed. Pinned ids float to a "Pinned" bucket on top.
//
// Internal maintenance sessions (memory consolidation / workflow packaging — the engine's own
// `Auto Dream` / `Auto Distill` and manual `/dream` / `/distill` runs) are routed to a dedicated
// `internal` group rendered LAST and collapsed by default. They are never deleted or hidden from
// search — just de-emphasized so the day-to-day chat list stays clean. A user who wants them expands
// the group; the sessions are first-class rows once expanded. Detection is title-based because the
// engine stamps these sessions with fixed titles (AUTO_DREAM_TITLE / AUTO_DISTILL_TITLE, plus the
// shared "dream"/"distill" stem of manual runs) — see opencode/src/session/auto-dream.ts.
export type SessionGroup = {
  label: string
  pinned?: boolean
  internal?: boolean
  sessions: Session[]
}

// The engine's own maintenance sessions are identified by the EXACT fixed title it stamps on them —
// never by a loose substring. The engine creates the background memory-consolidation / workflow-packaging
// runs with a literal title (AUTO_DREAM_TITLE / AUTO_DISTILL_TITLE in opencode/src/session/auto-dream.ts),
// so an exact (case/space-insensitive) title match catches every one of them. It must stay exact because
// ordinary chats get auto-generated titles: a real chat like "Distill the meeting notes" or
// "Fix the dream-journal UI" must NEVER be swept out of the list. (The dream/distill SUBAGENT type would
// be a more direct signal, but the client-side Session object does not carry it — title is what we have.)
const INTERNAL_TITLES = new Set(["auto dream", "auto distill"])

export function isInternalSession(session: Session): boolean {
  return INTERNAL_TITLES.has((session.title || "").trim().toLowerCase())
}

const dayNumber = (ts: number) => {
  const d = new Date(ts)
  return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate()
}

export const groupSessions = (
  sessions: Session[],
  now: number,
  pinnedIds: Set<string>,
  timeOf: (s: Session) => number = (s) => s.time.updated ?? s.time.created,
): SessionGroup[] => {
  // Match the UI language (the engine sets <html lang>), falling back to the browser locale.
  const locale =
    (typeof document !== "undefined" && document.documentElement.lang) ||
    (typeof navigator !== "undefined" ? navigator.language : undefined) ||
    undefined
  const rel = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  const md = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" })
  const today = dayNumber(now)
  const yesterday = dayNumber(now - 86_400_000)
  const labelFor = (ts: number) => {
    const dn = dayNumber(ts)
    if (dn >= today) return rel.format(0, "day")
    if (dn === yesterday) return rel.format(-1, "day")
    return md.format(new Date(ts))
  }
  const groups: SessionGroup[] = []
  const pinned = sessions.filter((s) => pinnedIds.has(s.id))
  if (pinned.length)
    groups.push({ label: locale?.startsWith("ru") ? "Закреплённые" : "Pinned", pinned: true, sessions: pinned })
  // Internal maintenance sessions (dream/distill) go to their own group, last, collapsed by default.
  // Pinned internals stay pinned (the user explicitly asked to keep one visible).
  const internal: Session[] = []
  for (const session of sessions) {
    if (pinnedIds.has(session.id)) continue
    if (isInternalSession(session)) {
      internal.push(session)
      continue
    }
    const label = labelFor(timeOf(session))
    const last = groups[groups.length - 1]
    if (last && !last.pinned && last.label === label) last.sessions.push(session)
    else groups.push({ label, sessions: [session] })
  }
  if (internal.length)
    groups.push({
      label: locale?.startsWith("ru") ? "Обслуживание" : "Maintenance",
      internal: true,
      sessions: internal,
    })
  return groups
}

export const latestRootSession = (stores: SessionStore[], now: number) =>
  stores.flatMap(roots).sort(sortSessions(now))[0]

export function hasProjectPermissions<T>(
  request: Record<string, T[] | undefined> | undefined,
  include: (item: T) => boolean = () => true,
) {
  return Object.values(request ?? {}).some((list) => list?.some(include))
}

export const childSessionOnPath = (sessions: Session[] | undefined, rootID: string, activeID?: string) => {
  if (!activeID || activeID === rootID) return
  const map = new Map((sessions ?? []).map((session) => [session.id, session]))
  let id = activeID

  while (id) {
    const session = map.get(id)
    if (!session?.parentID) return
    if (session.parentID === rootID) return session
    id = session.parentID
  }
}

export const displayName = (project: { name?: string; worktree: string }) =>
  project.name || getFilename(project.worktree)

export const errorMessage = (err: unknown, fallback: string) => {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return fallback
}

export const effectiveWorkspaceOrder = (local: string, dirs: string[], persisted?: string[]) => {
  const root = workspaceKey(local)
  const live = new Map<string, string>()

  for (const dir of dirs) {
    const key = workspaceKey(dir)
    if (key === root) continue
    if (!live.has(key)) live.set(key, dir)
  }

  if (!persisted?.length) return [local, ...live.values()]

  const result = [local]
  for (const dir of persisted) {
    const key = workspaceKey(dir)
    if (key === root) continue
    const match = live.get(key)
    if (!match) continue
    result.push(match)
    live.delete(key)
  }

  return [...result, ...live.values()]
}
