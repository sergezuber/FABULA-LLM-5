// FABULA: the engine DB is shared with CLI runs and external importers. The /global/fabula/*
// routes exclude imported sessions server-side, but the generic session.list (used to fill the
// per-project session stores and the in-project palette) does not. This module fetches the set of
// imported session ids ONCE and exposes a synchronous predicate the readers filter through, so no
// externally-imported session ever surfaces in a FABULA-only surface.
let ids = new Set<string>()
let loaded = false

async function refresh() {
  try {
    const res = await fetch("/global/fabula/imported-ids")
    if (!res.ok) return
    const body = (await res.json()) as { ids?: string[] }
    if (Array.isArray(body.ids)) {
      ids = new Set(body.ids)
      loaded = true
    }
  } catch {
    /* keep the last good set */
  }
}

export function ensureImportedIds() {
  if (!loaded) void refresh()
  return ids
}

// True when the session was pulled in by an external importer (not created in FABULA).
export function isImportedSession(id: string | undefined): boolean {
  if (!id) return false
  return ensureImportedIds().has(id)
}
