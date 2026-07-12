// FABULA: a global "all chats across every project" store. The engine's sidebar is per-project, but
// FABULA surfaces one flat, date-grouped chat list (like the reference client). Uses the DB-backed
// /global/fabula/sessions route, which ALREADY excludes externally-imported sessions (claude-import
// etc.) server-side — so this list is inherently FABULA-engine-only. "FABULA's own projects" are the
// distinct directories of those sessions; imported-only project dirs never appear because they have
// no non-imported sessions.
//
// The list is a reconcile()-keyed store, NOT a wholesale-replaced signal: a busy turn refetches every
// ~300ms and the safety poll every 30s, so replacing the array with freshly-parsed objects would give
// every row a new identity and remount the ENTIRE list (closing open ⋮ menus, killing an in-progress
// inline rename, restarting spinners). reconcile by id keeps unchanged rows stable.
import { createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { makePersisted } from "@solid-primitives/storage"
import type { Session } from "@mimo-ai/sdk/v2/client"

const [store, setStore] = createStore<{ list: Session[] }>({ list: [] })
// `loaded` distinguishes "genuinely empty" from "not fetched yet" so the sidebar never flashes the
// "No chats yet" empty state on cold launch before the first fetch resolves.
const [loaded, setLoaded] = createSignal(false)
let started = false

// Directories the user chose to hide from FABULA (menu -> "Hide project from FABULA"). Persisted; the
// sessions stay in the DB, they are just filtered out of the list and stats.
const [hidden, setHidden] = makePersisted(createSignal<string[]>([]), { name: "fabula.hiddenChatDirs" })
export const hiddenChatDirs = () => new Set(hidden())
export const hideChatDir = (dir: string) => setHidden((prev) => (prev.includes(dir) ? prev : [...prev, dir]))
export const unhideChatDir = (dir: string) => setHidden((prev) => prev.filter((d) => d !== dir))

const refresh = async () => {
  try {
    const res = await fetch("/global/fabula/sessions")
    if (!res.ok) return
    const data = await res.json()
    if (Array.isArray(data)) {
      setStore("list", reconcile(data as Session[], { key: "id", merge: true }))
      setLoaded(true)
    }
  } catch {
    /* offline / transient — keep the last good list */
  }
}

export const refreshAllSessions = refresh

// Coalesce event bursts (a busy turn emits many session.updated) into one fetch.
let debounce: ReturnType<typeof setTimeout> | undefined
export const scheduleAllSessionsRefresh = () => {
  if (debounce) return
  debounce = setTimeout(() => {
    debounce = undefined
    void refresh()
  }, 300)
}

export const allSessionsLoaded = () => loaded()

export const allSessions = () => {
  if (!started) {
    started = true
    void refresh()
    setInterval(refresh, 30_000)
  }
  return store.list
}

// The canonical "FABULA project directories": distinct dirs of the (imported-excluded) session list,
// minus the ones the user hid. Every FABULA-only surface (Home recent/gate, workspace chip, usage
// stats, project palette) scopes to this so foreign/imported projects never appear.
export const fabulaProjectDirs = (): string[] => {
  const h = hiddenChatDirs()
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of store.list) {
    if (s.parentID) continue
    if (h.has(s.directory)) continue
    if (seen.has(s.directory)) continue
    seen.add(s.directory)
    out.push(s.directory)
  }
  return out
}
