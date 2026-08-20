import type { Config } from "@/config"
import type { Provider } from "@/provider"
import { ProviderTransform } from "@/provider"
import type { MessageV2 } from "./message-v2"
import { baselineFor, observeBaseline, rescaleAboveBaseline } from "./prompt-baseline"

const COMPACTION_BUFFER = 20_000

// Cap the output reservation so models with large output windows (e.g. 32K, 64K)
// don't strangle the usable input window. 20K covers >99.99% of compaction
// summary outputs based on production telemetry of summary token counts.
const OUTPUT_CAP = 20_000

const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000

export function usable(input: { cfg: Config.Info; model: Provider.Model }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  const outputReserve = Math.min(ProviderTransform.maxOutputTokens(input.model), OUTPUT_CAP)

  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - outputReserve - reserved)
}

/**
 * How many tokens of the most recent conversation compaction keeps verbatim instead of summarising.
 *
 * Lives HERE rather than in `compaction.ts` because the overflow decision needs it too — a firing
 * that would preserve more than the conversation contains cannot recover anything, and that is the
 * difference between a compaction and a loop. `compaction.ts` imports it from here, so the two
 * cannot drift; putting it there and duplicating it here is the defect this file exists to remove.
 */
export function preserveRecentBudget(input: {
  cfg: Config.Info
  model: Provider.Model
  sessionID?: string
  agentID?: string
}) {
  if (input.cfg.compaction?.preserve_recent_tokens !== undefined) return input.cfg.compaction.preserve_recent_tokens
  // Measured on the failing configuration: taking the quarter from `usable()` — a quantity the fixed
  // prompt already dominates — preserved 7,408 tokens of a conversation that only reached 9,194 before
  // the threshold, leaving 386 tokens of headroom before the NEXT firing. That is the same loop one
  // level down: each compaction ran a full model call to buy one short turn. Taken from the room the
  // conversation actually has, the same quarter is 5,401 and the headroom is 2,393 — six times the
  // work between firings, from the same rule, applied to the right quantity.
  const base = conversationRoom(input) || usable(input)
  return Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(base * 0.25)))
}

/** Tokens the CONVERSATION has to grow into, or 0 when this slice has no measured baseline yet. */
export function conversationRoom(input: {
  cfg: Config.Info
  model: Provider.Model
  sessionID?: string
  agentID?: string
}) {
  if (!baselineEnabled() || !input.sessionID) return 0
  const baseline = baselineFor(input.sessionID, input.agentID)
  const window = baselineWindow(input.model)
  if (baseline <= 0 || baseline >= window) return 0
  return window - baseline
}

/**
 * The window a baseline is measured against: the SAME quantity `usable()` is a fraction of.
 *
 * `usable()` reads `limit.input` when the provider declares one (`{context, input, output}` is a
 * legal, user-writable shape — `config/provider.ts:42-44`), and only falls back to `limit.context`
 * when it does not. Rescaling against `limit.context` regardless is the "lands past the window" trap
 * this module's own doc warns about, wearing a different hat: MEASURED on a
 * `{context: 200_000, input: 32_000, output: 8_000}` model with a 25,000 baseline, the threshold came
 * out at 46,000 — 14,000 PAST the model's real input cap — so counts of 34,000 and 40,000, which the
 * previous code compacted, fired nothing and went to the provider to be rejected.
 */
export function baselineWindow(model: Provider.Model) {
  return model.limit.input || model.limit.context
}

/**
 * The quantity a baseline is measured in. Exported because `prune.ts` feeds the SAME registry and had
 * its own byte-identical copy of this formula: two definitions of one rule, and if they ever diverged
 * the baseline would silently be the minimum of two different quantities.
 */
export function tokenCount(tokens: MessageV2.Assistant["tokens"]) {
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

/** `FABULA_OVERFLOW_BASELINE=0` restores the pre-2026-08-18 absolute thresholds byte-for-byte. */
function baselineEnabled() {
  return process.env["FABULA_OVERFLOW_BASELINE"] !== "0"
}

/**
 * The threshold this count is really judged against: `usable()` mapped into the room ABOVE the
 * session's irreducible prompt cost, so it measures the CONVERSATION rather than the fixed prefix.
 *
 * Without a session to measure (or with the switch off) this is exactly `usable()`, i.e. every
 * caller that cannot name a session keeps the previous behaviour.
 */
export function effectiveUsable(input: {
  cfg: Config.Info
  model: Provider.Model
  sessionID?: string
  agentID?: string
  observed?: number
}) {
  const raw = usable(input)
  if (!baselineEnabled() || !input.sessionID || raw === 0) return raw
  const baseline = observeBaseline(input.sessionID, input.observed ?? 0, input.agentID)
  if (baseline <= 0) return raw
  return rescaleAboveBaseline([raw], baselineWindow(input.model), baseline)[0]!
}

export function isOverflow(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
  sessionID?: string
  agentID?: string
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count = tokenCount(input.tokens)
  if (count < effectiveUsable({ ...input, observed: count })) return false

  // Firing is warranted only if it can RECOVER something. Compaction replaces the conversation with a
  // summary while keeping the most recent `preserveRecentBudget` tokens verbatim, so a conversation no
  // larger than that budget comes back the same size: the next turn trips the same threshold and the
  // session loops, paying a full model run and a destroyed prefix cache per cycle. Measured: 5 firings
  // in 30 minutes, zero progress. Suppressing needs a baseline we actually trust, so the guard is
  // conditional on one — with no measurement, the previous behaviour stands.
  if (!baselineEnabled() || !input.sessionID) return true
  const baseline = observeBaseline(input.sessionID, count, input.agentID)
  const window = baselineWindow(input.model)
  if (baseline <= 0 || baseline >= window) return true
  // Suppression is a bet that NOT firing is cheaper than firing. That bet is only available while the
  // conversation still fits: once `count` reaches the window the request cannot be sent at all, so
  // declining to compact does not avoid a loop, it guarantees a provider rejection every turn instead.
  // MEASURED: `preserve_recent_tokens` is a `NonNegativeInt` with no upper bound (config.ts:263), and
  // at 60,000 on this 69,632 window a conversation of 70,000 / 90,000 / 110,000 tokens never fired.
  if (count >= window) return true
  return count - baseline > preserveRecentBudget(input)
}

export function pressureLevel(input: {
  cfg: Config.Info
  tokens: MessageV2.Assistant["tokens"]
  model: Provider.Model
  sessionID?: string
  agentID?: string
}): 0 | 1 | 2 | 3 {
  if (input.cfg.compaction?.auto === false) return 0
  if (input.model.limit.context === 0) return 0

  const count = tokenCount(input.tokens)
  const limit = effectiveUsable({ ...input, observed: count })
  if (limit === 0) return 0

  const ratio = count / limit
  if (ratio < 0.5) return 0
  if (ratio < 0.7) return 1
  if (ratio < 0.85) return 2
  return 3
}
