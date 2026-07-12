// FABULA-LLM-5 — per-model distill gate (separate plugin per rule #4).
//
// The FABULA engine auto-runs a `distill` pass (~every 30 days) that reviews past chats and packages them into
// skills/agents/commands, using whatever model is active. Policy: NEVER let an UNCENSORED model do
// this autonomously; ALLOW it on other (aligned) models. The engine's `distill.auto` is a single global flag,
// so we gate per-model here: when a distill run lands on an uncensored model we strip its instructions
// and inject a hard no-op, so it studies nothing and creates nothing. On any other model we don't touch
// it — distill works normally. Detection is provider-agnostic (subagent name "distill" or the stable
// prompt signature) + an uncensored-model matcher overridable via FABULA_DISTILL_BLOCK_MODELS.

import type { Plugin } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import { messageModel, messageParts, messageRole } from "./lib/vision"
import { uncensoredPattern, shouldBlockDistill, DISTILL_SKIP_NOTICE } from "./lib/distillguard"

export const FabulaDistillGuard: Plugin = async () => gate("distill-guard", ({
  "experimental.chat.messages.transform": async (_a: any, b: any) => {
    try {
      const messages = b?.messages
      if (!Array.isArray(messages) || messages.length === 0) return
      // distill runs as a user-role prompt; act on the latest user turn.
      let user: any
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messageRole(messages[i]) === "user") { user = messages[i]; break }
      }
      if (!user) return
      const { modelID } = messageModel(user)
      const agent = user?.info?.agent
      const text = messageParts(user).filter((p: any) => p?.type === "text").map((p: any) => p?.text || "").join("\n")
      if (!shouldBlockDistill({ agent, text, modelID, pat: uncensoredPattern(process.env) })) return
      // Neutralize THIS run only: replace the distill instructions with a hard no-op.
      user.parts = [{ type: "text", text: DISTILL_SKIP_NOTICE }]
    } catch {}
  },
}))
