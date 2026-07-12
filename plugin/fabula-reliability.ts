// FABULA-LLM-5 — reliability layer (separate plugin file per the one-plugin-per-file rule).
// Wires the PURE controllers in lib/ to the engine's plugin hooks. Hook capabilities relied on:
//   tool.execute.after  CAN append to the result the model sees  → loop-steer + output cap
//   tool.execute.before CAN modify args (reach execute)          → arg-repair / strip
//   tool.definition     CAN modify the schema/description for LLM → actor schema clarify
//   chat.message        fires per user turn                       → reset loop counters
//
//   circuit-breaker / loop-steer  (lib/loopguard.ts)
//   arg-repair / strip extra keys (lib/argrepair.ts) + tool.definition clarify
//   cache-stable compaction hint  + oversized tool-output pre-pruning
//   tool-heavy sampling (OPT-IN via env, off by default — protects creativity)

import type { Plugin } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import { tool } from "@mimo-ai/plugin"
import { LoopGuard, eofNotice } from "./lib/loopguard"
import { newExploreState, observeExplore, type ExploreState } from "./lib/explorebudget"
import { repairArgs, STRICT_TOOL_KEYS, normalizeActorArgs } from "./lib/argrepair"
import { sanitizeAssistantTokens } from "./lib/sanitize-tokens"
import { postNtfy } from "./lib/notify"
import { rolePreamble, soulsEnabled } from "./lib/souls"

const guard = new LoopGuard()

// Outbound event pings. Turns the agent's OWN failure signals into a phone push
// at 0 model-token cost, reusing the ntfy transport (lib/notify.ts): loopguard HARD-ABORT (stuck),
// session.error (run errored), session.idle (run finished — gated by FABULA_NTFY_ON_IDLE, default on). Gated on
// FABULA_NTFY_TOPIC (no topic → silent no-op); per-(session,kind,message) dedup so one event never double-pings;
// postNtfy never throws + 3s self-timeout, so this can NEVER break a hook. Awaited so a one-shot `fabula run`
// flushes the POST before the process exits.
const PING_DEDUP_MS = 15_000
const pingedAt = new Map<string, number>()
function pingTarget(args: any): string {
  try {
    const t = args?.file_path || args?.path || args?.filePath || args?.pattern || args?.query || ""
    return String(t).split("/").slice(-1)[0].slice(0, 60)
  } catch { return "" }
}
async function emitPing(sid: string, kind: "blocked" | "error" | "idle", message: string, tags: string): Promise<void> {
  try {
    const topic = process.env.FABULA_NTFY_TOPIC
    if (!topic) return
    const key = `${sid || "?"}:${kind}:${message}`
    const now = Date.now()
    const last = pingedAt.get(key)
    if (last && now - last < PING_DEDUP_MS) return
    pingedAt.set(key, now)
    if (pingedAt.size > 500) for (const [k, t] of pingedAt) if (now - t > PING_DEDUP_MS) pingedAt.delete(k)
    await postNtfy({ topic, server: process.env.FABULA_NTFY_URL, title: "FABULA", message, tags, priority: kind === "idle" ? "default" : "high" })
  } catch {}
}

// Proactive END-OF-FILE hint for paginated reads. When the model paginates a file (offset>0) and
// the page comes back SHORT (fewer lines than `limit`, or just a few lines), it has hit EOF. Weak local
// models otherwise re-read that same last page forever ("read the chapters… let me do this" ×N). Telling
// them plainly there is no more content — on the FIRST short page — stops the loop before it starts.
// Computed on the raw output BEFORE any guidance is appended (so loop-detection still hashes real content).

// Hard cap on a single tool result before it enters history (KV-panic / context-bloat guard).
// Generous default (~30k tokens); env-tunable. 0 disables.
const OUTPUT_CAP = (() => {
  const v = parseInt(process.env.FABULA_TOOL_OUTPUT_CAP || "", 10)
  return Number.isFinite(v) && v >= 0 ? v : 120_000
})()

// Optional lower sampling on tool-capable turns (off unless FABULA_TOOL_SAMPLING=1).
const TOOL_SAMPLING = process.env.FABULA_TOOL_SAMPLING === "1"

function capOutput(s: string): string {
  if (!OUTPUT_CAP || typeof s !== "string" || s.length <= OUTPUT_CAP) return s
  const omitted = s.length - OUTPUT_CAP
  return s.slice(0, OUTPUT_CAP) +
    `\n\n[FABULA: tool output truncated — ${omitted} characters omitted to protect context. ` +
    `If you need the rest, narrow the query/range or read a specific section.]`
}

// Apply repaired args so they REACH validation/execute. The installed engine
// binary captures the ORIGINAL args object reference BEFORE `tool.execute.before` and validates THAT — a
// REPLACED `output.args` (new object) is silently discarded (before-hook produced a valid operation, yet the
// model's raw args still hit the strict schema → "operation: expected object, received undefined"). So MUTATE
// the SAME object in place (clear its keys + Object.assign the fixed shape); that change is visible through the
// captured reference and reaches the strict parse. Falls back to replace when output.args isn't a plain object.
function applyArgs(output: any, fixed: any) {
  if (output?.args && typeof output.args === "object" && !Array.isArray(output.args)) {
    for (const k of Object.keys(output.args)) delete output.args[k]
    Object.assign(output.args, fixed)
  } else output.args = fixed
}

// Exploration-budget steer (lib/explorebudget.ts): counts successive read-only calls since the last
// edit/verify; past FABULA_EXPLORE_BUDGET it appends an "implement NOW" steer to the tool result.
// Off unless the env is a positive integer (bench runner sets it; any long-task user can too).
const EXPLORE_BUDGET = parseInt(process.env.FABULA_EXPLORE_BUDGET || "0", 10) || 0
const exploreStates = new Map<string, ExploreState>()
function exploreStateFor(sid: string): ExploreState {
  let s = exploreStates.get(sid)
  if (!s) { s = newExploreState(); exploreStates.set(sid, s) }
  return s
}

export const FabulaReliability: Plugin = async () => gate("reliability", ({
  // New user turn → clear per-turn loop counters for this session.
  "chat.message": async (input: any) => {
    if (input?.sessionID) guard.resetTurn(input.sessionID)
    if (input?.sessionID) { if (exploreStates.size > 500) exploreStates.clear(); exploreStates.set(input.sessionID, newExploreState()) }
  },

  // Un-poison MLX/local self-leaked end-of-turn tokens (`<|im_end|>`, `<eos>`, `<end_of_turn>`, …)
  // that backends bleed into ASSISTANT content. Left in history they deterministically make the NEXT turn
  // finish with no tool call → the agent halts after one tool round / cuts replies off mid-output (exactly
  // the Qwen3.6-MLX symptom). Strip them from assistant/tool text BEFORE sending; user/system never touched.
  "experimental.chat.messages.transform": async (_input: any, output: any) => {
    try { if (Array.isArray(output?.messages)) sanitizeAssistantTokens(output.messages) } catch {}
  },

  // Session lifecycle: drop in-memory loop state on delete (complements DB purge) + outbound pings on
  // the agent's OWN terminal signals (errored / finished-idle). The session.deleted path is unchanged.
  event: async ({ event }: any) => {
    const type = event?.type
    const p = event?.properties || {}
    const id = p.sessionID || p.info?.id || p.id || p.session?.id
    const sid = typeof id === "string" ? id : ""
    if (type === "session.deleted") {
      if (sid) guard.dropSession(sid)
      return
    }
    if (type === "session.error") {
      const msg = String(p.error?.message || p.error?.data?.message || p.message || "session error").slice(0, 140)
      await emitPing(sid, "error", `run errored: ${msg}`, "warning")
      return
    }
    if (type === "session.idle" && process.env.FABULA_NTFY_ON_IDLE !== "0") {
      await emitPing(sid, "idle", "run finished (idle)", "white_check_mark")
      return
    }
  },

  // HARD loop-break + arg-repair. The advisory note appended in `after` is ignored by weak
  // local models (e.g. Qwen3.6 MLX re-reading the same file forever). So if this EXACT (tool, args)
  // has already hit the no-progress / repeated-failure block threshold this turn, THROW to abort the
  // redundant call — physically stops the tool and hands the model an error that forces a
  // different next step. Signed on `input.args` to match the signature recorded by the after-hook.
  "tool.execute.before": async (input: any, output: any) => {
    const sid = input?.sessionID, tool = input?.tool, args = input?.args ?? output?.args
    // Search-thrash / degenerate-pattern guard. Catches the empty/catch-all grep death-spiral
    // (matches every line → dumps the tree → context bloat) that varies by path and so slips past the
    // signature-based peekBlock below. Reject before execution → no flood, model gets a corrective error.
    const searchBlock = guard.peekSearch(sid, tool, args)
    if (searchBlock) { await emitPing(sid, "blocked", `blocked: ${tool} search-thrash`, "octagonal_sign"); throw new Error(searchBlock.guidance) }
    const block = guard.peekBlock(sid, tool, args)
    if (block) { await emitPing(sid, "blocked", `blocked: ${tool} ${pingTarget(args)} (repeated)`, "octagonal_sign"); throw new Error(block.guidance) }
    if (!output) return
    // actor ONLY: reshape into a strict-VALID `{operation:{…}}`. The engine validates the model's args with the ORIGINAL
    // strict discriminatedUnion at tool.ts (AFTER this hook, inside execute), NOT the permissive schema it sent the
    // model. So a missing/flat/JSON-string/garbled operation must be rebuilt here or it fails validation.
    // normalizeActorArgs never returns raw → always a valid operation. Source args from wherever they live.
    // ⚠️ NOT `task` — the `task` tool is a DIFFERENT tool with a DIFFERENT operation schema (create:{summary},
    // get/start/done:{id}, … — NO subagent_type/prompt). Running actor-shaped normalization on it CORRUPTS the call
    // (drops summary/id, forces action:"run") → "task tool called with invalid arguments". task keeps its own
    // native schema + validation (it even has its own `recover: recoverTaskArgs` for shell-mode).
    if (tool === "actor") {
      try {
        applyArgs(output, normalizeActorArgs(output.args ?? input?.args ?? {}))
        // Prepend a terse role preamble (SOUL) to the isolated sub-agent's prompt. GATED (FABULA_SOULS=1,
        // default off). Idempotent (skip if already prefixed).
        if (soulsEnabled()) {
          const op = output.args?.operation
          const pre = rolePreamble(op?.subagent_type)
          if (op && pre && typeof op.prompt === "string" && !op.prompt.startsWith("ROLE:")) {
            op.prompt = pre + "\n\n" + op.prompt
          }
        }
      } catch {}
      return
    }
    if (output.args == null) return
    const r = repairArgs(input.tool, output.args)
    if (r.changed) applyArgs(output, r.args)
  },

  // Loop-steer + output cap. Order: cap first, then evaluate the loop on the capped text,
  // then append guidance (so guidance is never cut by the cap).
  "tool.execute.after": async (input: any, output: any) => {
    if (!output) return
    if (typeof output.output === "string") output.output = capOutput(output.output)
    const raw = typeof output.output === "string" ? output.output : ""
    const decision = guard.observe(input.sessionID, input.tool, input.args, raw, output.metadata)
    const eof = eofNotice(input.tool, input.args, raw) // on raw, before appending guidance
    let out = raw
    if (decision.action !== "allow") out = LoopGuard.apply(out, decision)
    if (eof) out += eof
    // Exploration-budget steer (env-gated): N successive read-only calls with no edit/verify →
    // append "implement NOW" to this result (the steer pattern local models act on).
    if (EXPLORE_BUDGET > 0 && input?.sessionID) {
      const es = observeExplore(exploreStateFor(input.sessionID), input.tool, EXPLORE_BUDGET, input?.args?.command)
      if (es) out += es
    }
    if (out !== raw && typeof output.output === "string") output.output = out
  },

  // Backstop for strict tools: make the schema's intent explicit to the LLM.
  "tool.definition": async (input: any, output: any) => {
   try {
    if (!output) return
    const id = input?.toolID
    // actor ONLY — NOT task. The `task` tool has a DIFFERENT operation schema (create/get/start/done with
    // summary/id, no subagent_type/prompt); giving it the permissive schema + the actor-shaped description below
    // mis-steers the model into actor-shaped task calls → "task tool called with invalid arguments". task keeps
    // its own real schema/description + native validation.
    if (id === "actor") {
      // The engine converts our Zod schema to **JSON Schema**
      // (`z.toJSONSchema(item.parameters)`, prompt.ts) and the AI SDK validates the model's tool-call args against
      // THAT JSON Schema — NOT the Zod schema. So a Zod `z.preprocess` (a runtime transform) is LOST in the
      // conversion and NEVER runs during validation (that's why the old preprocess fix was dead). The strict
      // discriminated `operation` union then rejects the model's malformed call (operation-as-string, extra keys
      // like `output_schema`/`model`) → endless "rewrite to satisfy the schema" repair loop (observed: 30+ cycles).
      // CURE: replace the schema with a PERMISSIVE one whose JSON form accepts ANY shape, so validation ALWAYS
      // passes (no repair loop). Our `tool.execute.before` `normalizeActorArgs` (Zod-free; runs BEFORE execute)
      // then reshapes whatever the model sent into a clean `{ operation: {…} }` for the real actor/task tool.
      try {
        const z: any = (tool as any)?.schema
        let permissive = z.object({ operation: z.any().optional() })
        if (typeof permissive.loose === "function") permissive = permissive.loose()
        else if (typeof permissive.passthrough === "function") permissive = permissive.passthrough()
        output.parameters = permissive
      } catch { /* if z is unavailable, leave the original schema untouched */ }
      // Still steer the model to the correct operation-nested shape (idempotent on the description).
      if (typeof output.description === "string" && !output.description.includes("operation-nested")) {
        output.description = output.description +
          ' Arguments are operation-nested: `{ "operation": { "action": "run"|"spawn", ' +
          '"subagent_type": "explore"|"general", "description": "<short label>", ' +
          '"prompt": "<self-contained task>" } }`. Prefer just `operation`; keep `prompt` short and pass ' +
          'code/long text by file PATH, not inline. (Extra top-level keys are now tolerated, not errors.)'
      }
      return
    }
    const wl = STRICT_TOOL_KEYS[id]
    if (wl && typeof output.description === "string" && !output.description.includes("STRICT SCHEMA")) {
      output.description = output.description +
        ` STRICT SCHEMA: provide ONLY these top-level keys — ${wl.map((k) => "`" + k + "`").join(", ")}. ` +
        "Do NOT add any other key (e.g. timeout_ms/timeout/model/options); extra keys cause unrecognized_keys errors."
    }
   } catch {}
  },

  // Bias compaction toward keeping what matters; append hints rather than replacing the
  // whole prompt (safer / cache-stable). Drop verbose tool spew, keep task state.
  "experimental.session.compacting": async (_input: any, output: any) => {
    if (!output || !Array.isArray(output.context)) return
    output.context.push(
      "When summarizing, PRESERVE: the user's goal/task, open files and absolute paths, key decisions and " +
      "their rationale, unresolved errors/blockers, and any pending TODOs. COMPRESS aggressively: verbose tool " +
      "outputs, file dumps, and search results — keep only conclusions and the paths needed to re-fetch them.",
    )
  },

  // Optional: steadier tool-args on agentic turns (opt-in; creativity tradeoff).
  "chat.params": async (_input: any, output: any) => {
    if (!TOOL_SAMPLING || !output) return
    if (typeof output.temperature === "number") output.temperature = Math.min(output.temperature, 0.3)
    if (typeof output.topP === "number") output.topP = Math.min(output.topP, 0.9)
  },
}))
