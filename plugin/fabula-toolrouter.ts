// FABULA-LLM-5 — Context OS Phase 1: the deterministic per-task tool router (design
// Context OS design §4/§7). On every REAL user message (a task boundary — the
// only cache-safe re-selection point besides compaction, §3) it classifies the task into a
// PROFILE ID from a closed registry and stamps the per-ROOT-SESSION belt entry that the
// engine's resolveTools reads (session-keyed — concurrent sessions never clobber each other;
// the old process-global env stays a static floor).
//
// chat.message fires BEFORE resolveTools builds the step's schemas, so the FIRST step of a
// task already runs with the selected belt (design K5). RULE #9: the harness routes — nothing
// relies on the model asking for a profile. Masked tools remain ATTEMPT-dispatchable through
// the engine shadow map, so a router miss degrades to one extra tool-result roundtrip, never a
// blocked task.
//
// Off by default: FABULA_TOOL_ROUTER=1 enables (plus the plugin toggle id "tool-router").
// All logic lives in lib/beltwire.ts + lib/toolrouter.ts + lib/toolcards.ts (one-export rule).

import { tool } from "@mimo-ai/plugin"
import { z } from "zod"
import { gate } from "./lib/manage"
import { beltChannel, setBeltEntry, decideBelt, routerOn, shadowNamesFor, shadowToolFor, taskTextFrom } from "./lib/beltwire"

// Debug tap (FABULA_ROUTER_DEBUG=1): raw stderr writes bypass any console redirection in the
// engine's plugin sandbox — the channel that made the silent-hook class debuggable.
const dbg = (msg: string) => {
  if (process.env.FABULA_ROUTER_DEBUG === "1") process.stderr.write(`[fabula-toolrouter:dbg] ${msg}\n`)
}

export const FabulaToolRouter = async () => {
  dbg(`factory: routerOn=${routerOn()} state=${process.env.XDG_CONFIG_HOME ?? "~"}`)
  return gate("tool-router", {
    tool: {
      // The escape-hatch dispatcher (design §4.4/§7 — GATE_REQUIRED, never masked, tiny schema).
      // Executes a belt-hidden tool through its REAL shadow executor (all security/permission
      // hooks intact) WITHOUT ever putting the hidden tool's schema into the prefix. The engine
      // also REWRITES direct by-name attempts at hidden tools into this tool (llm.ts repair),
      // so both attempt paths land here. Each call is a missed-tool calibration signal.
      expand_tools: tool({
        description:
          "Use a tool that is hidden by the active tool belt (see [FABULA TOOL CATALOG] in context). " +
          'Pass {"tool":"<name>","args":{...}} to EXECUTE it, or {"tool":"<name>"} alone to get its input schema. ' +
          "Only works for tools listed in the catalog.",
        args: {
          tool: z.string().describe("Exact name of the hidden tool from the catalog."),
          args: z.record(z.string(), z.any()).optional().describe("Arguments for the tool. Omit to get the tool's schema instead of executing."),
        },
        async execute(a: { tool: string; args?: Record<string, unknown> }, ctx: any) {
          const sessionID = String(ctx?.sessionID ?? "")
          const shadow = shadowToolFor(sessionID, a.tool)
          if (!shadow) {
            const names = shadowNamesFor(sessionID)
            return names.length
              ? `Tool "${a.tool}" is not in this session's hidden set. Hidden tools available here: ${names.join(", ")}. Visible tools are already in your schema list — call those directly.`
              : `No tools are hidden in this session — "${a.tool}" either doesn't exist or is already visible in your schema list.`
          }
          console.log(`[fabula-toolrouter] expand_tools dispatch (missed-tool): ${a.tool} session=${sessionID.slice(0, 8)}`)
          if (!a.args) {
            const schema = (shadow.inputSchema as { jsonSchema?: unknown } | undefined)?.jsonSchema
            return [
              `Schema for hidden tool "${a.tool}":`,
              shadow.description ? `description: ${shadow.description}` : "",
              "input schema (JSON Schema):",
              JSON.stringify(schema ?? {}, null, 1),
              `Call expand_tools again with {"tool":"${a.tool}","args":{...}} to execute it.`,
            ].filter(Boolean).join("\n")
          }
          const result: any = await shadow.execute(a.args, {
            toolCallId: String(ctx?.callID ?? "expand-" + Date.now().toString(36)),
            messages: [],
            abortSignal: ctx?.abort,
          })
          if (typeof result === "string") return result
          if (result && typeof result.output === "string") return result.output
          return JSON.stringify(result ?? null)
        },
      }),
    },
    // Fires once per user message, BEFORE the runLoop resolves tools (engine prompt.ts) —
    // the correct pre-resolveTools seam per the design (system.transform is one turn late).
    "chat.message": async (input: any, output: any) => {
      try {
        dbg(`hook: agent=${JSON.stringify(input?.agent)} session=${String(input?.sessionID).slice(0, 12)} parts=${Array.isArray(output?.parts) ? output.parts.length : "?"}`)
        if (!routerOn()) return
        if (input?.agent && input.agent !== "main" && input.agent !== "build") return // main-agent scope
        const sessionID = input?.sessionID
        if (!sessionID) return
        const text = taskTextFrom(output?.parts)
        if (!text) return // synthetic continuations / steering replays never re-route (§3)
        const current = beltChannel().get(sessionID)?.profileId
        const { entry, reason } = decideBelt(text, current)
        if (current === entry.profileId) return // same profile → no-op, prefix bytes unchanged
        setBeltEntry(sessionID, { ...entry, watermark: input?.messageID })
        console.log(
          `[fabula-toolrouter] session=${String(sessionID).slice(0, 8)} profile=${entry.profileId} (${reason}; hide=${entry.hide.length}+${entry.hideGlobs.length}g)`,
        )
      } catch (e) {
        // The router must never break a turn (no belt entry = full visibility) — but a
        // swallowed error is a debugging dead end (this exact silence hid a loader
        // incompatibility once). Log loudly, still don't throw.
        console.error("[fabula-toolrouter] route error (turn continues unrouted):", e)
      }
    },
  })
}
