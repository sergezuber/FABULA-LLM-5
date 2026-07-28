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
import { ensureLoadedAtPlannedWindow, syncEngineLimit, anyModelBusy } from "./lib/modelload"
import { probeWindow } from "./lib/ctxguard"

export const FabulaWindow = async () =>
  gate("window", {
    "chat.params": async (input: any) => {
      try {
        const id = String(input?.model?.id ?? input?.model?.modelID ?? "")
        if (!id) return
        // Only a local model has a window we can set; a cloud endpoint has none to plan.
        const provider = String(input?.provider?.id ?? input?.model?.providerID ?? "")
        if (provider && !/lmstudio|local/i.test(provider)) return
        // CORRECT THE ENGINE'S ARITHMETIC BEFORE IT IS USED. Everything the engine decides about size —
        // when to prune, when to compact, how much it may send — is computed by overflow.ts `usable()`
        // from `model.limit.context`, and that number comes from a config file somebody typed. When it
        // disagrees with what the runtime actually loaded, the engine reasons confidently about a machine
        // that does not exist: measured 2026-07-28, requests of 188 841 and 271 525 units went to a model
        // holding 65 536, and the serving process died allocating cache for them ("the model has crashed").
        //
        // The model object arrives here BY REFERENCE, so a measured figure put in it is the figure every
        // later decision uses — no restart, no second copy of the number, nothing written down. Silent
        // when the probe cannot answer: an unmeasured limit is left exactly as the config had it.
        const measured = await probeWindow().catch(() => 0)
        const lim = (input as any)?.model?.limit
        if (measured > 0 && lim && Number(lim.context) !== measured) {
          const from = Number(lim.context) || 0
          lim.context = measured
          console.error(`[fabula-window] engine context limit ${from} -> ${measured} (measured from the runtime)`)
          // WRITE THE CONFIG HERE, at the correction itself — not only after a successful load. The sync
          // used to live behind `r.window > 0`, and on this machine the loader answers "no action" (the
          // model is already resident), so the correction never reached the file: every part of the engine
          // that reads the CONFIG'S limit — the prune thresholds above all — kept computing with the typed
          // number. Measured 2026-07-28: kat served 135168 while the config said 65536, so a 45k-token
          // first step read as 69% of the window and auto-compaction fired inside an 84-second turn; the
          // summariser then hijacked twice and the turn died churning. The by-reference correction fixes
          // the REQUEST; the config write fixes every other reader from the next start.
          const cfgPath = process.env.MIMOCODE_CONFIG
          if (cfgPath) {
            const sync = syncEngineLimit(cfgPath, id, measured)
            if (sync.changed) console.error(`[fabula-window] ${sync.reason}; applies from the next engine start`)
          }
        }

        // FABULA_AUTO_WINDOW governs LOADING a model, which is the risky half. Correcting a number the
        // engine is about to compute with is neither risky nor optional — a kill switch that silences it
        // leaves the engine sizing requests against a machine that does not exist.
        if (process.env.FABULA_AUTO_WINDOW === "0") return
        if (seen.has(id)) return
        seen.add(id)
        // NEVER act while a turn is running. A reload unloads the model, and a model that is BUSY cannot
        // be unloaded — the failure was swallowed and a SECOND copy was loaded on top, which took the
        // machine into swap and killed the run that was in flight. The hook fires as a turn STARTS, so
        // "quiet" here means: nothing was already generating when we arrived.
        const r = await ensureLoadedAtPlannedWindow(id, { quiet: async () => !(await anyModelBusy()) })
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
