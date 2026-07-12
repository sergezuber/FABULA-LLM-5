// Real-time half of the "no trace of deleted chats" guarantee.
// When a session is deleted, immediately remove its per-session checkpoint memory
// from disk. The heavy database scrub (orphan rows + FTS index + freed-page zeroing
// via VACUUM) requires the DB to be closed, so it runs from app-quit / `fabula-purge.sh`.

import type { Plugin } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { removeHandoffsForSession } from "./lib/handoff"

// The engine's XDG data dir follows its app id ("fabula"): ~/.local/share/fabula, where per-session
// checkpoint memory (memory/sessions/<id>) actually lives. Pointing at the legacy "mimocode" dir made
// this real-time purge no-op on the live data — deleted-chat memory survived (privacy). Matches fabula-purge.sh.
const DATA = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "fabula")

export const FabulaPurgeHook: Plugin = async () => gate("purge-hook", ({
  async event({ event }: any) {
    if (event?.type !== "session.deleted") return
    const p = event.properties || {}
    const id = p.sessionID || p.info?.id || p.id || p.session?.id
    if (!id || typeof id !== "string") return
    await fs.rm(path.join(DATA, "memory", "sessions", id), { recursive: true, force: true }).catch(() => {})
    // Also remove durable handoff artifacts created by this (now deleted) session (orphan cleanup).
    await removeHandoffsForSession(id).catch(() => {})
  },
}))
