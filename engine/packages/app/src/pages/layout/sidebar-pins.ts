// FABULA: client-side pinned-session state (the engine has no server-side pin concept). Uses the
// codebase's own makePersisted (a fully-reactive localStorage-backed Solid signal) so the sidebar's
// Pinned section updates instantly when a chat is pinned/unpinned and survives reloads.
import { createSignal } from "solid-js"
import { makePersisted } from "@solid-primitives/storage"

const [pins, setPins] = makePersisted(createSignal<string[]>([]), { name: "fabula.pinnedSessions" })

export const pinnedIds = () => new Set(pins())
export const isPinned = (id: string) => pins().includes(id)
export const togglePin = (id: string) =>
  setPins((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [id, ...cur]))
