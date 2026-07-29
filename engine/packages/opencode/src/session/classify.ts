import { MessageV2 } from "./message-v2"

/**
 * Outcome of classifying a single assistant step. Pure data — `runLoop` decides
 * what side effect (nudge / retry / error / break) each category triggers.
 *
 * T00 establishes the categories; downstream tasks (T01–T05) attach distinct
 * behavior to `filtered` / `think-only` / `invalid` / `failed`. Until then
 * `runLoop` collapses every non-`continue` result to the existing break.
 */
export type StepClassification =
  | { type: "final"; degraded?: boolean }
  | { type: "continue" }
  | { type: "text-tool-call" }
  | { type: "filtered" }
  | { type: "think-only" }
  | { type: "invalid"; reason: string }
  | { type: "failed"; reason: string }

/**
 * Single source of truth for "is this assistant step terminal, or should the
 * loop keep going?". Called from all three classification sites in `runLoop`
 * (existing-assistant top break, fork json_schema gate, main json_schema gate)
 * so a fix lands in one place instead of three.
 *
 * Pure: no Effect, no I/O, no mutation.
 *
 * Core guarantee (all downstream tasks depend on it): any finish reason plus a
 * pending non-`providerExecuted` client tool part ⇒ `continue`, with higher
 * priority than final/refusal text or any other category.
 */
export function classifyAssistantStep(input: {
  lastUser: MessageV2.User
  assistant: MessageV2.Assistant
  parts: MessageV2.Part[]
  phase: "existing-assistant" | "after-process"
  // Reserved for T01–T05 (stop/overflow control flow stays in runLoop for T00).
  processResult?: "continue" | "stop" | "overflow" | "text-repeat"
}): StepClassification {
  const assistant = input.assistant

  // 1. Core guarantee — beats everything: a pending client tool call must
  // re-loop so its observation is fed back to the model. EXCLUDE error-state
  // tool parts: cleanup after SSE timeout / abort marks pending tool parts
  // as state.status === "error". Those are NOT pending observation — they're
  // terminal failures. Without this guard, classify mis-routes errored steps
  // to "continue", runLoop re-enters and gets stranded on permission.ask
  // from the in-flight tool that won't ever resolve. See Spec ③.
  if (
    input.parts.some(
      (part) =>
        part.type === "tool" &&
        !part.metadata?.providerExecuted &&
        part.state.status !== "error",
    )
  )
    return { type: "continue" }

  // 2. Nothing finalized yet.
  if (!assistant.finish) return { type: "continue" }

  // 3a. Text-form tool call: the model serialized a tool call as PROSE TEXT
  // instead of emitting a structured tool_use. Signature: finish "tool-calls"
  // but NO structured tool part (a real tool part would have re-looped at #1)
  // and text carrying tool-call markup. Must precede the unconditional
  // tool-calls continue below, which would otherwise swallow this state.
  // Guards: skip if this turn was already discarded (assistant.error set — let
  // it fall through to `failed` at #5), and skip a stale/resumed turn the
  // conversation already moved past (mirrors the #4 staleness guard) so a
  // degraded turn left in history can't re-fire across turns/resumes.
  // A TOOL CALL WRITTEN AS PROSE IS THE SAME DEFECT WHATEVER ITS DIALECT AND WHATEVER THE FINISH REASON
  // SAYS. Measured live 2026-07-28, twice: the model emitted `<tool_call><function=read>…` as text and
  // this branch never fired once. Both halves of the old test were the same mistake — matching a
  // SPELLING rather than the thing. The finish reason was "stop", because a provider that did not parse
  // a tool call has no reason to report one, so requiring "tool-calls" made the branch unreachable in
  // exactly the case it exists for; and the dialect was `<tool_call>` / `<function=`, absent from the
  // alternation. Six steps, six "continue", thirty-three messages on one question.
  //
  // The substance is: markup describing a tool invocation, with no tool part actually produced. A
  // cut-off step ("length") is excluded — its markup may be merely unfinished rather than un-parsed.
  if (
    !assistant.error &&
    assistant.finish !== "length" &&
    input.lastUser.id < assistant.id &&
    !input.parts.some((part) => part.type === "tool") &&
    input.parts.some(
      (part) => part.type === "text" && !part.synthetic && !part.ignored && looksLikeWrittenToolCall(part.text),
    )
  )
    return { type: "text-tool-call" }

  // 3. Provider-executed-only tool step (no client tool part left, see #1).
  if (assistant.finish === "tool-calls") return { type: "continue" }

  // 4. Stale assistant predating the current user turn — don't terminate on it.
  if (input.phase === "existing-assistant" && !(input.lastUser.id < assistant.id))
    return { type: "continue" }

  // 5. Errored step — checked before content so an errored message that also
  // carries text isn't misjudged `final`.
  if (assistant.error) return { type: "failed", reason: assistant.error.name }

  // 6. Already-resolved structured output / summary — terminal, never nudge-able.
  if (assistant.structured !== undefined) return { type: "final" }
  if (assistant.summary) return { type: "final" }

  // 7. Safety / error finish reasons.
  if (assistant.finish === "content-filter") return { type: "filtered" }
  if (assistant.finish === "error") return { type: "failed", reason: "model error finish" }

  // 8. stop / length / other → inspect produced content. An "other" finish that
  // still produced usable text is a usable-but-abnormal completion: surface it as
  // `degraded` so runLoop can record it instead of silently treating it as clean.
  if (
    input.parts.some(
      (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.trim().length > 0,
    )
  )
    return assistant.finish === "other" ? { type: "final", degraded: true } : { type: "final" }
  if (input.parts.some((part) => part.type === "reasoning" && part.text.trim().length > 0))
    return { type: "think-only" }
  return { type: "invalid", reason: "empty output" }
}

/**
 * Does this text DESCRIBE a tool invocation instead of being one? Dialect-agnostic by construction.
 *
 * Every serving stack spells this differently — `<tool_call>`, `<invoke name=…>`, `<function=read>`,
 * `<function_calls>` — and a list of spellings is stale the day a new model ships. What they share is
 * an XML-ish opening tag whose NAME says "call a tool/function", so the name is what is matched.
 *
 * Deliberately narrow in one respect: a tag alone is not enough when it could be ordinary prose about
 * markup. The pairing that makes it an invocation — a call tag together with a named function or
 * parameter — is required, which is why documentation mentioning `<tool_call>` in passing does not
 * classify as one.
 */
export function looksLikeWrittenToolCall(text: string): boolean {
  if (typeof text !== "string" || !text) return false
  const callTag = /<\/?[a-z_]*(tool_?call|function_?calls?|invoke)[a-z_]*[\s>=]/i.test(text)
  if (!callTag) return false
  const names = /<(function|invoke|tool)[\s]*[=:]|<(function|invoke|tool)\s+name\s*=|<parameter[\s]*[=:]|<parameter\s+name\s*=/i.test(text)
  return names
}
