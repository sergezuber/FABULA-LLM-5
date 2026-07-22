/**
 * Integration tests for T01: a `finish=stop` step with no usable output
 * (think-only = reasoning only, or empty = nothing at all) must not silently
 * break into an empty assistant. The loop nudges the model to produce a final
 * answer; once the shared continuation counter is exhausted it writes an
 * InvalidOutputError terminal instead of looping forever.
 *
 * Driven through a real Session.prompt(...) against the scripted HTTP LLM stub.
 */

import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Flag } from "../../src/flag/flag"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import {
  startScriptedLLMServer,
  textStopResponse,
  emptyStopResponse,
  reasoningStopResponse,
  toolCallResponse,
} from "../lib/scripted-llm-server"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

function writeConfig(dir: string, origin: string) {
  return Bun.write(
    path.join(dir, "mimocode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["alibaba"],
      provider: {
        alibaba: { options: { apiKey: "test-key", baseURL: `${origin}/v1` } },
      },
      agent: { build: { model: "alibaba/qwen-plus" } },
    }),
  )
}

describe("invalid-output continuation — integration", () => {
  test("empty stop step is nudged, second call produces a non-empty final assistant", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: emptyStopResponse() }, { lines: textStopResponse("final answer") }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-empty" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              // First empty stop => nudge + continue; second call => final text.
              expect(stub.captures.length).toBe(2)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("think-only (reasoning only) stop step is nudged, second call produces a final assistant", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: reasoningStopResponse("let me think about this...") },
      { lines: textStopResponse("final answer") },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-think-only" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              expect(stub.captures.length).toBe(2)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("repeated empty output exhausts the shared limit and writes InvalidOutputError", async () => {
    await using tmp = await tmpdir({ git: true })
    // Server repeats the last entry, so every call returns an empty stop.
    const stub = startScriptedLLMServer([{ lines: emptyStopResponse() }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-exhaust" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              // limit nudges + 1 final attempt that trips the terminal error.
              expect(stub.captures.length).toBe(Flag.MIMOCODE_INVALID_OUTPUT_CONTINUATION_LIMIT + 1)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                expect(result.info.error?.name).toBe("InvalidOutputError")
              }
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  // Progress-aware bound (session/invalid-output.ts), the measured book-analysis defect. These two drive
  // the WIRING end-to-end (the pure core is unit-tested separately) — each kills a distinct mutation the
  // pure tests cannot: neutralizing the productive-step RESET, and forcing progressed=false at the wire.

  test("KILLER (reset): think-only turns SEPARATED BY REAL TOOL WORK do not accumulate to the terminal error", async () => {
    await using tmp = await tmpdir({ git: true })
    const readmePath = path.join(tmp.path, "README.md")
    await Bun.write(readmePath, "# Hello\n")
    // Same reasoning "A" every think-only turn (NOT progress), with a real `read` tool call between each.
    // Without the productive-step reset the identical-A stalls accumulate across the run and trip the
    // soft limit at the 4th think-only; with it, each tool step clears the streak and the run reaches the
    // final answer. Four A-turns + four tool calls + the final answer.
    const read = () => ({
      lines: toolCallResponse({ id: "call_r", name: "read", args: JSON.stringify({ file_path: readmePath }) }),
    })
    const stub = startScriptedLLMServer([
      { lines: reasoningStopResponse("stuck on the same thought A") },
      read(),
      { lines: reasoningStopResponse("stuck on the same thought A") },
      read(),
      { lines: reasoningStopResponse("stuck on the same thought A") },
      read(),
      { lines: reasoningStopResponse("stuck on the same thought A") },
      read(),
      { lines: textStopResponse("final answer") },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-reset" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Do the multi-step task." }],
              })
              if (result.info.role === "assistant") expect(result.info.error?.name).not.toBe("InvalidOutputError")
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("KILLER (progress-leniency): a run of DISTINCT reasoning survives past the soft stall limit", async () => {
    await using tmp = await tmpdir({ git: true })
    // Four think-only turns whose reasoning KEEPS CHANGING, no tool work between them. A changing
    // reasoning is progress and must not spend the stall budget, so the run survives past the soft limit
    // of 2 and reaches the final answer. If progressed were false (the mutation), the 3rd think-only
    // would trip the terminal error before the answer.
    const stub = startScriptedLLMServer([
      { lines: reasoningStopResponse("first distinct thought about the plan") },
      { lines: reasoningStopResponse("second and different consideration entirely") },
      { lines: reasoningStopResponse("a third, wholly separate line of thinking") },
      { lines: reasoningStopResponse("fourth unique reflection before answering") },
      { lines: textStopResponse("final answer") },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-progress" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Think it through, then answer." }],
              })
              if (result.info.role === "assistant") expect(result.info.error?.name).not.toBe("InvalidOutputError")
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(true)
              // proof it went PAST the old cap of 2: at least the 4 think-only nudges + the answer.
              expect(stub.captures.length).toBeGreaterThanOrEqual(5)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })
})
