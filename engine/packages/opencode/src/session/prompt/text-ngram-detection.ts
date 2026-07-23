import { Flag } from "@/flag/flag"

// Recovery attempts before the FINAL wrap-up stage (env-tunable: a long agentic run on a local
// reasoning model may deserve more replans than an interactive chat). After `max` normal recoveries
// one LAST re-entry (WRAPUP below) routes the model to verify/stop instead of killing the session —
// a repetition spiral late in a run used to terminate the whole session, discarding all completed
// work past every finish gate (no verify, no receipt, half-captured patch).
const envMax = Number(process.env.FABULA_NGRAM_MAX_RECOVERY)
export const TEXT_NGRAM_MAX_RECOVERY = Number.isFinite(envMax) && envMax >= 1 ? Math.floor(envMax) : 2

export function tokenizeForNgram(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
}

export function detectRepeatedNgram(tokens: readonly string[], n: number, threshold: number): boolean {
  if (tokens.length < n || threshold < 2) return false
  const counts = new Map<string, number>()
  for (let i = 0; i <= tokens.length - n; i++) {
    const gram = tokens.slice(i, i + n).join("\0")
    const next = (counts.get(gram) ?? 0) + 1
    if (next >= threshold) return true
    counts.set(gram, next)
  }
  return false
}

const CHAR_SHINGLE_LENGTH = 8
const CHAR_SHINGLE_THRESHOLD = 8
const CHAR_SHINGLE_WINDOW = 1024
const CHAR_RUN_MIN_LENGTH = 256
const TEXT_BUFFER_MAX_CHARACTERS = 65536
const CHAR_RUN_CHARACTER = /[\p{L}\p{N}_]/u

class CharShingleMonitor {
  private run = ""
  private runLength = 0
  private shingles: string[] = []
  private oldest = 0
  private counts = new Map<string, number>()

  append(text: string): boolean {
    for (const char of text) {
      if (!CHAR_RUN_CHARACTER.test(char)) {
        this.resetRun()
        continue
      }
      this.runLength += 1
      this.run = (this.run + char).slice(-CHAR_SHINGLE_LENGTH)
      if (this.run.length < CHAR_SHINGLE_LENGTH) continue
      if (this.record(this.run) && this.runLength >= CHAR_RUN_MIN_LENGTH) return true
    }
    return false
  }

  reset() {
    this.resetRun()
  }

  private record(shingle: string): boolean {
    const next = (this.counts.get(shingle) ?? 0) + 1
    this.counts.set(shingle, next)
    this.shingles.push(shingle)
    if (this.shingles.length - this.oldest > CHAR_SHINGLE_WINDOW) this.removeOldest()
    return next >= CHAR_SHINGLE_THRESHOLD
  }

  private removeOldest() {
    const shingle = this.shingles[this.oldest]
    const count = this.counts.get(shingle)
    if (count === 1) this.counts.delete(shingle)
    if (count && count > 1) this.counts.set(shingle, count - 1)
    this.oldest += 1
    if (this.oldest < CHAR_SHINGLE_WINDOW) return
    this.shingles = this.shingles.slice(this.oldest)
    this.oldest = 0
  }

  private resetRun() {
    this.run = ""
    this.runLength = 0
    this.shingles = []
    this.oldest = 0
    this.counts.clear()
  }
}

export function detectRepeatedCharShingle(text: string): boolean {
  return new CharShingleMonitor().append(text)
}

export class TextNgramMonitor {
  private buffer = ""
  private tokens: string[] = []
  private charShingles = new CharShingleMonitor()

  constructor(
    private readonly n: number,
    private readonly threshold: number,
    private readonly windowTokens: number,
  ) {}

  append(text: string): boolean {
    if (!text) return false
    this.buffer = (this.buffer + text).slice(-TEXT_BUFFER_MAX_CHARACTERS)
    const all = tokenizeForNgram(this.buffer)
    this.tokens = all.length > this.windowTokens ? all.slice(-this.windowTokens) : all
    if (all.length > this.windowTokens * 2) this.buffer = this.tokens.join(" ")
    return detectRepeatedNgram(this.tokens, this.n, this.threshold) || this.charShingles.append(text)
  }

  reset() {
    this.buffer = ""
    this.tokens = []
    this.charShingles.reset()
  }
}

export function createTextNgramMonitor() {
  return new TextNgramMonitor(
    Flag.MIMOCODE_TEXT_NGRAM_N,
    Flag.MIMOCODE_TEXT_REPEAT_THRESHOLD,
    Flag.MIMOCODE_TEXT_WINDOW_TOKENS,
  )
}

export function textNgramRepeat() {
  return { _tag: "TextNgramRepeat" as const }
}

export function isTextNgramRepeat(value: unknown): value is { _tag: "TextNgramRepeat" } {
  return typeof value === "object" && value !== null && "_tag" in value && value._tag === "TextNgramRepeat"
}

export const TEXT_NGRAM_RECOVERY_REMIND = `<system-reminder>
REPETITION DETECTED: Your recent output contains repeated phrases (sliding n-gram match within your last ${Flag.MIMOCODE_TEXT_WINDOW_TOKENS} tokens).

STOP repeating yourself and retry with a different approach:
- Vary your wording and reasoning — do not reuse the same phrases
- If you were about to call a tool, try a different tool or different arguments
- If you are blocked, explain what is blocking you instead of looping

Do NOT output the same phrases again.
</system-reminder>`

export const TEXT_NGRAM_RECOVERY_REPLAN = `<system-reminder>
CRITICAL REPETITION: You are STILL repeating phrases after a recovery attempt.

You MUST completely replan before continuing:
1. Abandon your current approach entirely — it is stuck in repetition
2. Write out a NEW plan with different steps and a different strategy
3. State what you were trying to do, why it failed, and how your new plan differs

Do NOT continue the same line of reasoning or reuse the same wording.
</system-reminder>`

// The LAST chance before termination: stop all prose and route straight to the finish contract —
// verify what exists, or stop cleanly. Ending the turn through the normal gates preserves the work
// already done (verify/receipt/patch state); terminating the session discards it.
export const TEXT_NGRAM_RECOVERY_WRAPUP = `<system-reminder>
FINAL WARNING — REPETITION LIMIT REACHED. The very next repetition terminates this session and all
work in it is lost. Do NOT write any further analysis or prose.

Do exactly this, nothing else:
1. If you edited source files: call the \`verify_done\` tool NOW (one call, no commentary).
2. Otherwise: reply with one short sentence stating where you stopped, and end your turn.
</system-reminder>`

/** Pick the recovery action for the Nth repetition hit (pure; prompt.ts wires it):
 *  0 → REMIND, 1..max-1 → REPLAN, max → WRAPUP (final directed finish), > max → terminate. */
export function ngramRecoveryStage(attempts: number, max: number = TEXT_NGRAM_MAX_RECOVERY):
  "remind" | "replan" | "wrapup" | "terminate" {
  if (attempts > max) return "terminate"
  if (attempts === 0) return "remind"
  if (attempts < max) return "replan"
  return "wrapup"
}
