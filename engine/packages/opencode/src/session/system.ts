import { Context, Effect, Layer } from "effect"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export interface SessionPaths {
  directory: string
  worktree: string
  vcsGit: boolean
  projectMemoryFile: string
  sessionMemoryDir: string
  checkpointFile: string
}

/** Per-session values, formatted as ONE block destined for the very END of the system prompt.
 * Everything here differs between two sessions; everything ABOVE it is byte-identical for any two
 * sessions of the same engine+model+day, which is what a prefix cache matches on. Pure. */
export function sessionPathsBlock(p: SessionPaths): string {
  return [
    `<session-paths>`,
    `The current session's paths — the memory section above and the env block refer to them by these names:`,
    `  Working directory: ${p.directory}`,
    `  Workspace root folder: ${p.worktree}`,
    `  Is directory a git repo: ${p.vcsGit ? "yes" : "no"}`,
    `  PROJECT MEMORY: ${p.projectMemoryFile}`,
    `  SESSION MEMORY DIR: ${p.sessionMemoryDir}`,
    `  SESSION CHECKPOINT: ${p.checkpointFile}`,
    `</session-paths>`,
  ].join("\n")
}

export interface Interface {
  readonly environment: (model: Provider.Model, now: number) => string[]
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return Service.of({
      environment(model, now) {
        // CONSTANT FIRST, VARIABLE LAST. The working directory, workspace root and git-repo
        // lines used to live here — in the FIRST system block — so two sessions with different
        // directories (every bench task, every project switch) diverged within the first hundred
        // tokens and a prompt/prefix cache matched nothing after that: measured 2026-08-16, a new
        // session's first call re-prefilled ~11.2k tokens for 26-29s where the shared head should
        // have carried it (request-log-8000.jsonl, cache_miss_reason=prefix_divergence_at_token).
        // Those lines are per-SESSION values; they moved to the <session-paths> block that
        // session/llm.ts appends at the very END of the system prompt — same pattern the memory
        // section already follows for the session id. Only session-constant content stays here.
        return [
          [
            `You are the FABULA agent. You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.`,
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Platform: ${process.platform}`,
            // Anchored to the session's creation time (not request time) so this block
            // stays byte-identical across every turn of a session — including ones that
            // cross midnight — keeping it inside the Anthropic cached system prefix.
            // Both the runLoop and checkpoint prefix-capture paths pass the same value.
            `  Today's date: ${new Date(now).toDateString()}`,
            `</env>`,
          ].join("\n"),
          `IMPORTANT: Your response must ALWAYS strictly follow the same major language as the user.`,
        ]
      },

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
