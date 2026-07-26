// The model in the socket runs at the widest window it and this machine can hold — worked out, not typed.
//
// The trigger is the moment the model CHANGES. That covers every way it can happen: the picker in the
// app, an edit to the config, a fresh start of the day where nothing is loaded yet and the serving
// runtime would otherwise bring the model up at its own small default. One hook, one place that acts.
//
// It fires at the START of a turn, before the request leaves — so a load that takes a minute delays that
// first turn and nothing else. It never fires twice for the same model, and never in the middle of a
// conversation already running on it, because a reload discards the whole prefix cache and every live
// turn would pay a full re-prefill for it.
//
// The decision itself lives in lib/windowplan.ts (how wide), lib/kvcost.ts (what a token of window costs
// on this machine, learned) and lib/modelload.ts (talking to the serving runtime). Nothing here knows a
// number.

import { gate } from "./lib/manage"
import { ensureLoadedAtPlannedWindow, syncEngineLimit } from "./lib/modelload"

export const FabulaWindow = async () =>
  gate("window", {
    "chat.params": async (input: any) => {
      try {
        if (process.env.FABULA_AUTO_WINDOW === "0") return
        const id = String(input?.model?.id ?? input?.model?.modelID ?? "")
        if (!id) return
        // Only a local model has a window we can set; a cloud endpoint has none to plan.
        const provider = String(input?.provider?.id ?? input?.model?.providerID ?? "")
        if (provider && !/lmstudio|local/i.test(provider)) return
        if (seen.has(id)) return
        seen.add(id)
        const r = await ensureLoadedAtPlannedWindow(id)
        // The engine log is the channel a maintainer reads; the reader of the chat never sees this.
        console.error(`[fabula-window] ${id}: ${r.acted ? "LOADED" : "no action"} — ${r.reason}`)
        // The engine keeps its OWN idea of the window in the launch config and prunes against it. That
        // figure is typed too, and measured on this machine it was wrong by half — 131072 written down
        // while the model served 262144, so the engine was discarding conversation at the midpoint of a
        // window it actually had. Nothing warns about that: both numbers look reasonable alone.
        const cfg = process.env.MIMOCODE_CONFIG
        if (cfg && r.window > 0) {
          const sync = syncEngineLimit(cfg, id, r.window)
          if (sync.changed) console.error(`[fabula-window] ${sync.reason}; applies from the next engine start`)
        }
      } catch (e) {
        console.error(`[fabula-window] skipped: ${String(e)}`)
      }
    },
  })

/** Models already handled in this process. A window is set once per model, not once per turn. */
const seen = new Set<string>()
