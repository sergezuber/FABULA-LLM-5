import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import * as Session from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "../provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util"
import { Log } from "../util"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config"
import { NotFoundError } from "@/storage"
import { ModelID, ProviderID } from "@/provider/schema"
import { detectRepeatedCharShingle } from "./prompt/text-ngram-detection"
import { Effect, Layer, Context } from "effect"
import { InstanceState } from "@/effect"
import { isOverflow as overflow, usable } from "./overflow"
import { mechanicalSummary } from "./compaction-fallback"
import { planFold, foldContinuation } from "./compaction-fold"
import { makeRuntime } from "@/effect/run-service"
import { fn } from "@/util/fn"
import { trace } from "./trace"

const log = Log.create({ service: "session.compaction" })

/**
 * Did the summarizer CONTINUE THE TASK instead of summarizing? Deterministic check, no model.
 *
 * Two hijack shapes, both measured live:
 *  1. Tool-call markup: a transcript ending in chapter reads produced a "summary" of
 *     "Продолжаю чтение глав 7-12:" + <tool_call> blocks; a list_plugins-saturated transcript produced
 *     a bare <tool_call><function=list_plugins> block. Both ended the session SILENTLY with the garbage
 *     recorded as its summary.
 *  2. Degenerative runaway (2026-07-23): the summarizer emitted hundreds of spaceless "глава_10aглава_10b…"
 *     lines — no tool markup, so check #1 missed it; the processor did not classify it as text-repeat
 *     (no inter-word spaces → word-n-gram blind), so it was accepted as a "summary" and the run continued
 *     with a poisoned context, re-triggering the runaway for hours. The char-shingle detector (the same
 *     one that guards the engine's stream monitor and the adapter transport) catches this shape: a summary
 *     that degenerated into a repeating skeleton is a continuation wearing a summary's flag, every time.
 */
export function summaryLooksHijacked(text: string): boolean {
  if (typeof text !== "string" || !text.trim()) return false
  return text.includes("<tool_call") || text.includes("<function=") || detectRepeatedCharShingle(text)
}

export const Event = {
  Compacted: BusEvent.define(
    "session.compacted",
    z.object({
      sessionID: SessionID.zod,
    }),
  ),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
type Turn = {
  start: number
  end: number
  id: MessageID
}

function preserveRecentBudget(input: { cfg: Config.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: MessageV2.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: MessageV2.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID; agentID?: string }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
    agentID?: string
  }) => Effect.Effect<"continue" | "stop" | "text-repeat">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderID; modelID: ModelID }
    auto: boolean
    overflow?: boolean
    agentID?: string
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Bus.Service
  | Config.Service
  | Session.Service
  | Agent.Service
  | Plugin.Service
  | SessionProcessor.Service
  | Provider.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: MessageV2.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({ cfg: yield* config.get(), tokens: input.tokens, model: input.model })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: MessageV2.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: MessageV2.WithParts[]
      cfg: Config.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )
      if (sizes.at(-1)! > budget) {
        log.info("tail fallback", { budget, size: sizes.at(-1) })
        return { head: input.messages, tail_start_id: undefined }
      }

      let total = 0
      let keep: Turn | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const size = sizes[i]
        if (total + size > budget) break
        total += size
        keep = recent[i]
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space.
    // Scoped to (sessionID, agentID): only inspects messages belonging to the
    // given actor — main-agent messages stay untouched when agentID is set.
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: {
      sessionID: SessionID
      agentID?: string
    }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      log.info("pruning", { agentID: input.agentID ?? "main" })

      const msgs = yield* MessageV2.filterCompactedEffect(input.sessionID, { agentID: input.agentID }).pipe(
        Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)),
      )
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: MessageV2.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type === "tool")
            if (part.state.status === "completed") {
              if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
              if (part.state.time.compacted) break loop
              const estimate = Token.estimate(part.state.output)
              total += estimate
              if (total > PRUNE_PROTECT) {
                pruned += estimate
                toPrune.push(part)
              }
            }
        }
      }

      log.info("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        log.info("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: MessageV2.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
      agentID?: string
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is MessageV2.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: MessageV2.User
            parts: MessageV2.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const selected = yield* select({
        messages: history,
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const defaultPrompt = `When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`

      const prompt = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
      const msgs = structuredClone(selected.head)
      // The summarizer build is NOT a task turn, and the hooks must know it. Measured live: a plugin
      // steer appended to the last user message ("read in batches, continue") turned the summarizer
      // back into a task executor — it emitted <tool_call> markup as text instead of a summary, the
      // processor classified that as text-repeat, compaction returned "stop", and the session ended
      // with a garbage summary and no continuation. The input flag lets steer-hooks stand down while
      // redaction-style transforms keep working.
      yield* plugin.trigger("experimental.chat.messages.transform", { compaction: true }, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, { stripMedia: true })
      const ctx = yield* InstanceState.context
      const createSummaryMessage = (): MessageV2.Assistant => ({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        agentID: input.agentID ?? undefined,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      })
      const processSummary = (message: MessageV2.Assistant, instruction: string, send = modelMessages) =>
        Effect.gen(function* () {
          const processor = yield* processors.create({
            assistantMessage: message,
            sessionID: input.sessionID,
            model,
          })
          const result = yield* processor.process({
            user: userMessage,
            agent,
            sessionID: input.sessionID,
            tools: {},
            system: [],
            messages: [
              ...modelMessages,
              {
                role: "user",
                content: [{ type: "text", text: instruction }],
              },
            ],
            model,
          })
          return { processor, result }
        })
      const abortOverflow = (processor: SessionProcessor.Handle) =>
        Effect.gen(function* () {
          processor.message.error = new MessageV2.ContextOverflowError({
            message: replay
              ? "Conversation history too large to compact - exceeds model context limit"
              : "Session too large to compact - context exceeds model limit even after stripping media",
          }).toObject()
          processor.message.finish = "error"
          yield* session.updateMessage(processor.message)
        })
      let msg = createSummaryMessage()
      yield* session.updateMessage(msg)
      const summaryText = (messageID: MessageID) =>
        MessageV2.page({ sessionID: input.sessionID, limit: 10 })
          .items.filter((m) => m.info.id === messageID)
          .flatMap((m) => m.parts)
          .filter((p): p is MessageV2.TextPart => p.type === "text")
          .map((p) => p.text)
          .join("\n")

      // FOLD THE HEAD IF IT DOES NOT FIT. Measured 2026-07-28: six chapters of a book made this call
      // 188 870 units against a model holding 135 168, and the serving process died allocating cache for
      // it — "the model has crashed", "compaction did not finish", and every chapter already read was
      // lost. Knowing the right limit does not help on its own: the limit was correct on that very run
      // and nothing consulted it before deciding how much to send.
      //
      // Older slices are summarised first and carried forward, so every call is bounded while the whole
      // is not. The LAST pass goes through exactly the path it always did, which is why the retry and
      // hijack handling below needs no change at all. A head that already fits takes one call, as before.
      const fold = planFold(modelMessages as any, usable({ cfg, model }))
      let carried = ""
      if (fold.slices.length > 1) {
        log.info("compaction folding oversized head", { sessionID: input.sessionID, reason: fold.reason })
        for (let i = 0; i < fold.slices.length - 1; i++) {
          const passMsg = createSummaryMessage()
          yield* session.updateMessage(passMsg)
          const pass = yield* processSummary(
            passMsg,
            i === 0 ? prompt : foldContinuation(carried, i, fold.slices.length),
            fold.slices[i] as any,
          )
          if (pass.result === "overflow") {
            yield* abortOverflow(pass.processor)
            return "stop"
          }
          carried = summaryText(passMsg.id).trim() || carried
        }
      }
      
      let attempt = yield* processSummary(
        msg,
        fold.slices.length > 1 ? foldContinuation(carried, fold.slices.length - 1, fold.slices.length) : prompt,
        fold.slices.length > 1 ? (fold.slices[fold.slices.length - 1] as any) : modelMessages,
      )

      if (attempt.result === "overflow") {
        yield* abortOverflow(attempt.processor)
        return "stop"
      }

      // A hijacked or looping summary must not end the run SILENTLY. Read what the summarizer actually
      // wrote; if it continued the task (tool-call markup) — or the processor cut it as a text loop —
      // retry ONCE with a corrective appended to the instruction (the steer channel measured to work on
      // this project). A clean retry proceeds like any summary; a failed retry sets a VISIBLE error so
      // the session shows red instead of a fake-done ending on a garbage summary.
      let hijacked = attempt.result === "text-repeat" || summaryLooksHijacked(summaryText(msg.id))
      trace("compaction.summary", {
        sid: input.sessionID,
        result: attempt.result,
        hijacked,
        auto: input.auto === true,
      })
      if (hijacked) {
        log.warn("summary hijacked by task continuation — retrying once with corrective", {
          sessionID: input.sessionID,
        })
        yield* session.removeMessage({ sessionID: input.sessionID, messageID: msg.id })
        msg = createSummaryMessage()
        yield* session.updateMessage(msg)
        attempt = yield* processSummary(
          msg,
          prompt +
            "\n\nIMPORTANT: your previous attempt CONTINUED the conversation (it emitted tool calls) " +
            "instead of summarizing it. Do NOT call tools, do NOT continue the task. Output ONLY the " +
            "summary in the requested structure, as plain prose.",
        )
        if (attempt.result === "overflow") {
          yield* abortOverflow(attempt.processor)
          return "stop"
        }
        hijacked = attempt.result === "text-repeat" || summaryLooksHijacked(summaryText(msg.id))
        trace("compaction.retry", { sid: input.sessionID, hijacked })
        if (hijacked) {
          // MECHANICAL FALLBACK, not a dead stop. Measured 2026-07-28 (twice in one 84-second turn):
          // erroring out here inserted the deterministic rebuild boundary, the model lost its progress,
          // re-explored from zero, crossed the threshold again, and the summarizer hijacked again — a
          // churn loop with a bare markup tail as the visible "answer". A summary assembled from what
          // the conversation VERIFIABLY contains is worse prose than a model's but loses nothing, ends
          // the loop, and — since summary messages are no longer rendered (2026-07-28) — is INTERNAL:
          // the reader can never see it, which is the sin the first version of this fallback committed.
          const assembled = mechanicalSummary(modelMessages as never)
          log.warn("summary hijacked twice — mechanical fallback summary used", { sessionID: input.sessionID })
          yield* session.removeMessage({ sessionID: input.sessionID, messageID: msg.id })
          msg = createSummaryMessage()
          msg.time.completed = Date.now()
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: input.sessionID,
            type: "text",
            text: assembled,
            time: { start: Date.now(), end: Date.now() },
          })
          trace("compaction.fallback", { sid: input.sessionID, mechanical: true })
          // Steer the existing downstream: a fallback summary continues the turn exactly as a clean one.
          attempt.result = "continue"
        }
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (attempt.result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            agentID: input.agentID ?? undefined,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              agentID: input.agentID ?? undefined,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            // This note is FOR THE MODEL, and the model treats it as a script. The previous wording told it
            // to "explain that the attachments were too large" — so it opened its visible answer by explaining
            // exactly that, in this note's English, to a reader who asked in Russian and never asked about the
            // machinery (measured live 2026-07-28, two sessions). An instruction here must demand the opposite:
            // the machinery stays invisible, and the answer stays in the reader's language.
            const text =
              (input.overflow
                ? "Some oversized material was dropped from the conversation to fit the context. The FILES THEMSELVES ARE STILL ON DISK — re-read whatever you need with your tools and continue the task. NEVER ask the user to restate the task, NEVER report lost context or memory, NEVER mention attachments being dropped: from the reader's side nothing was lost, their request is above and the files are in the folder.\n\n"
                : "") +
              "Continue the task if you have next steps, or stop and ask for clarification if you are unsure how to proceed. " +
              "Write in the language the user has been writing in. Do not mention compaction, context limits, attachment handling, or this note — the user must see only the answer to what they asked."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (attempt.processor.message.error) return "stop"
      if (attempt.result !== "continue") return "stop"
      yield* bus.publish(Event.Compacted, { sessionID: input.sessionID })
      return "continue"
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderID; modelID: ModelID }
      auto: boolean
      overflow?: boolean
      agentID?: string
    }) {
      // Tag the synthetic boundary message with agent_id so per-actor
      // filterCompactedEffect lookups stop at this row when scoping by the
      // same agent_id (subagent compaction stays inside its own scope).
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agentID: input.agentID ?? undefined,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
  ),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
  return runPromise((svc) => svc.isOverflow(input))
}

export async function prune(input: { sessionID: SessionID; agentID?: string }) {
  return runPromise((svc) => svc.prune(input))
}

export const create = fn(
  z.object({
    sessionID: SessionID.zod,
    agent: z.string(),
    model: z.object({ providerID: ProviderID.zod, modelID: ModelID.zod }),
    auto: z.boolean(),
    overflow: z.boolean().optional(),
    agentID: z.string().optional(),
  }),
  (input) => runPromise((svc) => svc.create(input)),
)

export * as SessionCompaction from "./compaction"
