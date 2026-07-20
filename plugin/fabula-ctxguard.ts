// FABULA-LLM-5 — context-budget guard (active plugin, RULE #9 / #14).
//
// A "read all chapters / every file / the whole book" task loads the entire corpus into ONE context. Any
// model in the socket, on any backend, has a finite window AND a finite device KV-cache budget; past a
// point the serving process runs out of memory and dies mid-generation — surfacing to the user as an
// abrupt red "the model has crashed … Exit code: null". Capping the serving window removes the crash; this
// hook is the complementary half — it keeps the CONVERSATION from wanting more than the window.
//
// The mechanism fires ITSELF on every relevant turn (not a nudge the model may skip): an
// experimental.chat.messages.transform hook estimates the accumulated context and, at the boundary,
// plants a directive on the current user turn — the channel this project has repeatedly measured the
// model to act on. It is INERT below the high-water mark, so ordinary turns are byte-identical and the
// static prefix stays cache-warm (efficiency contract, asserted by the wiring test).
//
// Pure decision core in lib/ctxguard.ts. Kill-switch: FABULA_CTX_GUARD=0 (or disable the plugin).

import type { Plugin } from "@mimo-ai/plugin"
import { isEnabled } from "./lib/manage"
import {
  decide,
  consolidationDirective,
  boundedReadDirective,
  CONSOLIDATE_MARKER,
  BOUNDED_MARKER,
} from "./lib/ctxguard"

export const FabulaCtxGuard: Plugin = async () => {
  if (!isEnabled("ctxguard")) return {}
  return {
    "experimental.chat.messages.transform": async (_i: any, output: any) => {
      try {
        if (process.env.FABULA_CTX_GUARD === "0") return
        const messages = output?.messages
        if (!Array.isArray(messages) || !messages.length) return
        // the last USER message is the current ask; we append our directive to it
        const last = [...messages].reverse().find((m: any) => (m?.info?.role ?? m?.role) === "user")
        const parts = last?.parts
        if (!Array.isArray(parts)) return
        const textPart = [...parts].reverse().find((p: any) => typeof p?.text === "string")
        if (!textPart) return
        const t = String(textPart.text)
        if (t.includes(CONSOLIDATE_MARKER) || t.includes(BOUNDED_MARKER)) return // already steered this turn
        const d = decide(messages, t.toLowerCase())
        if (d.action === "consolidate") textPart.text += consolidationDirective(d.pct)
        else if (d.action === "bounded") textPart.text += boundedReadDirective()
      } catch {
        /* never break a turn over the context guard */
      }
    },
  }
}
