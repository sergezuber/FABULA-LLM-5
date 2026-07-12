// MLX/local-backend special-token sanitizer (pure, unit-testable).
//
// PROBLEM (FABULA's MLX setup): some local backends (LM Studio MLX,
// oMLX, Gemma) LEAK their end-of-turn special token (e.g. `<|im_end|>`, `<eos>`, `<end_of_turn>`) into the
// assistant `content` delta. The engine persists `content:"…<|im_end|>"` into history; that poisoned turn then
// deterministically makes the NEXT turn finish with `finish_reason:"stop"` and NO tool call → the agent
// halts after one tool round, or cuts a reply off mid-output. Some local models (e.g. Qwen3-family MLX builds) do this.
//
// FIX: before sending history to the model (`experimental.chat.messages.transform`), STRIP these tokens
// from ASSISTANT/TOOL text parts only — never from user/system content (a user may legitimately paste
// `<|im_end|>` while discussing tokenizers; the leak only ever occurs in the model's own output).

/** End-of-turn / control tokens that backends leak into assistant content. NOT `<think>` (handled elsewhere). */
export const SPECIAL_TOKENS = [
  "<|im_end|>", "<|im_start|>", "<|endoftext|>", "<|eot_id|>", "<|end|>", "<|end_of_text|>",
  "<eos>", "<|eos|>", "<end_of_turn>", "<|end_of_turn|>", "<bos>", "<|bos|>",
  "</s>", "<s>", "<｜end▁of▁sentence｜>", "<｜begin▁of▁sentence｜>",
] as const

/** Remove every known special token from a string (anywhere it appears). Safe no-op if none present. */
export function stripSpecialTokens(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text
  let out = text
  for (const t of SPECIAL_TOKENS) {
    if (out.indexOf(t) !== -1) out = out.split(t).join("")
  }
  return out
}

/**
 * In-place sanitize: strip leaked special tokens from ASSISTANT/TOOL text parts of a messages array.
 * Trailing whitespace left by a stripped trailing token is trimmed (a `"answer\n<|im_end|>"` → `"answer"`).
 * Returns counts for logging. User/system messages are never touched.
 */
export function sanitizeAssistantTokens(messages: any[]): { stripped: number } {
  let stripped = 0
  if (!Array.isArray(messages)) return { stripped }
  for (const m of messages) {
    const role = m?.role
    if (role !== "assistant" && role !== "tool") continue
    const parts = m?.parts
    if (!Array.isArray(parts)) continue
    for (const p of parts) {
      if (p && p.type === "text" && typeof p.text === "string") {
        const cleaned = stripSpecialTokens(p.text).replace(/[ \t\r\n]+$/g, "")
        if (cleaned !== p.text) { p.text = cleaned; stripped++ }
      }
    }
  }
  return { stripped }
}
