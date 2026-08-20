// The compaction trigger must measure the CONVERSATION, not the fixed prompt.
//
// Every number below is MEASURED, from session ses_feb7b41c3ffe… on 2026-08-18 — the run where a
// "review this book" task produced no review in 43 minutes. Sources: LM Studio's own server log
// (`Prompt cache: using 0/47779 tokens`), the engine log (`service=session.compaction budget=7408`),
// and the message rows in fabula.db. Nothing here is an invented fixture.
//
// THE DEFECT: the window was 69,632 and the irreducible prefix — system prompt plus every tool schema,
// re-sent verbatim on every request — was 47,779 tokens, while `usable()` is 69,632 − 20,000 output
// − 20,000 summary = 29,632. The prefix exceeded the entire input budget by 61%, so `count >= usable`
// held on the FIRST turn of the session and never stopped holding. Compaction rewrites the
// conversation; it cannot shrink a prefix, so each firing recovered nothing and the next turn tripped
// the same threshold. Measured consequence: 5 summarizer runs in 30 minutes, 0 chapters read, and —
// because a rewritten conversation shares no prefix with the cached one — every agent turn then paid a
// full ~49,000-token prefill (`using 0/49413`) instead of a cache hit. Prefill collapsed 455 → 12.6
// tok/s as the machine went into swap and the final request needed 770s.
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { conversationRoom, effectiveUsable, isOverflow, preserveRecentBudget, pressureLevel, usable } from "../../src/session/overflow"
import { baselineFor, observeBaseline, resetBaselines, rescaleAboveBaseline } from "../../src/session/prompt-baseline"
import type { Provider } from "../../src/provider"

const WINDOW = 69_632
const PREFIX = 47_779 // first turn of the retry, from LM Studio's cache line
const PREFIX_RUN1 = 47_616 // first turn of the earlier run — the two runs differ by 163 tokens
/** Real `tokens.total` of every agent turn in the failing run, in order. */
const AGENT_TURNS = [48_027, 52_671, 51_944, 49_782, 49_753]

function cfg(opts?: { auto?: boolean; reserved?: number; preserve?: number }) {
  return {
    compaction: { auto: opts?.auto ?? true, reserved: opts?.reserved, preserve_recent_tokens: opts?.preserve },
  } as any
}

function model(context = WINDOW, output = 32_768): Provider.Model {
  return {
    id: "qwen3.8-27b-mlx",
    providerID: "lmstudio",
    name: "Test",
    limit: { context, output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai-compatible" },
    options: {},
  } as Provider.Model
}

const tok = (total: number) => ({ input: total, output: 0, total, cache: { read: 0, write: 0 } }) as any

let saved: string | undefined
beforeEach(() => {
  saved = process.env["FABULA_OVERFLOW_BASELINE"]
  delete process.env["FABULA_OVERFLOW_BASELINE"]
  resetBaselines()
})
afterEach(() => {
  if (saved === undefined) delete process.env["FABULA_OVERFLOW_BASELINE"]
  else process.env["FABULA_OVERFLOW_BASELINE"] = saved
  resetBaselines()
})

describe("the measured defect", () => {
  test("the prompt alone exceeds the whole input budget — the state that produced the loop", () => {
    expect(usable({ cfg: cfg(), model: model() })).toBe(29_632)
    expect(PREFIX).toBeGreaterThan(usable({ cfg: cfg(), model: model() }))
  })

  test("WITHOUT a session to measure, every real turn still fires — today's behaviour is preserved", () => {
    // This is the control: the same five turns, judged the old way, all overflow. A change that
    // silently altered the no-session path would be caught here.
    for (const total of AGENT_TURNS) {
      expect(isOverflow({ cfg: cfg(), tokens: tok(total), model: model() })).toBe(true)
    }
  })

  test("WITH the session measured, not one of the five real turns fires", () => {
    const sessionID = "ses_measured"
    for (const total of AGENT_TURNS) {
      expect(isOverflow({ cfg: cfg(), tokens: tok(total), model: model(), sessionID })).toBe(false)
    }
  })

  test("the threshold it is judged against is the room above the prefix", () => {
    const sessionID = "ses_limit"
    observeBaseline(sessionID, PREFIX)
    const limit = effectiveUsable({ cfg: cfg(), model: model(), sessionID })
    // usable mapped into the room: 47,779 + (29,632/69,632) × (69,632 − 47,779)
    expect(limit).toBe(57_079)
    expect(limit).toBeGreaterThan(PREFIX)
    expect(limit).toBeLessThan(WINDOW)
  })
})

describe("it still fires when the conversation is genuinely the thing filling the window", () => {
  test("a conversation that grows past the room does overflow", () => {
    const sessionID = "ses_grow"
    isOverflow({ cfg: cfg(), tokens: tok(PREFIX), model: model(), sessionID })
    expect(isOverflow({ cfg: cfg(), tokens: tok(57_079), model: model(), sessionID })).toBe(true)
    expect(isOverflow({ cfg: cfg(), tokens: tok(65_000), model: model(), sessionID })).toBe(true)
  })

  test("when it fires there is more conversation than compaction would preserve — so it can help", () => {
    const sessionID = "ses_help"
    observeBaseline(sessionID, PREFIX)
    const budget = preserveRecentBudget({ cfg: cfg(), model: model() })
    expect(budget).toBe(7_408) // the engine log's own `budget=7408`
    const fires = effectiveUsable({ cfg: cfg(), model: model(), sessionID })
    expect(fires - PREFIX).toBeGreaterThan(budget)
  })

  test("a wide window fires later but still safely inside it", () => {
    // The healthy configuration: 131,072 window, 40,291 prefix (measured for the checkpoint work).
    const sessionID = "ses_wide"
    const m = model(131_072)
    observeBaseline(sessionID, 40_291)
    const limit = effectiveUsable({ cfg: cfg(), model: m, sessionID })
    expect(limit).toBeGreaterThan(usable({ cfg: cfg(), model: m }))
    expect(limit).toBeLessThan(131_072)
  })
})

describe("compaction that cannot recover anything does not fire", () => {
  test("a conversation no larger than the preserved tail is left alone", () => {
    // The band this guard covers NARROWED when the preserved tail became a quarter of the ROOM: while
    // the quarter dominates, compaction always frees something (a quarter kept out of the ~43% that
    // triggers). What is left is the floor — `MIN_PRESERVE_RECENT_TOKENS` = 2,000 — which on a very
    // small room is larger than the whole conversation at firing. That is the regime here: room 4,000,
    // conversation at firing ~1,700, preserved 2,000. Firing returns the same size and loops.
    const sessionID = "ses_norecover"
    const huge = WINDOW - 4_000
    observeBaseline(sessionID, huge)
    const limit = effectiveUsable({ cfg: cfg(), model: model(), sessionID })
    const budget = preserveRecentBudget({ cfg: cfg(), model: model() })
    expect(limit - huge).toBeLessThan(budget) // firing could not recover
    expect(isOverflow({ cfg: cfg(), tokens: tok(limit + 10), model: model(), sessionID })).toBe(false)
  })

  test("but it never suppresses a conversation that no longer fits the window", () => {
    // Suppression is a bet that not firing beats firing, and that bet is only on the table while the
    // request can still be sent. `preserve_recent_tokens` is a NonNegativeInt with no upper bound, so a
    // configured 60,000 on this 69,632 window left 70,000 / 90,000 / 110,000-token conversations
    // permanently uncompacted — a guaranteed provider rejection every turn, not an avoided loop.
    const sessionID = "ses_past_window"
    const big = cfg({ preserve: 60_000 })
    observeBaseline(sessionID, 50_000)
    expect(preserveRecentBudget({ cfg: big, model: model() })).toBe(60_000)
    for (const count of [70_000, 90_000, 110_000]) {
      expect(isOverflow({ cfg: big, tokens: tok(count), model: model(), sessionID })).toBe(true)
    }
    // and BELOW the window the guard is untouched — it still declines what it cannot recover
    expect(isOverflow({ cfg: big, tokens: tok(60_000), model: model(), sessionID })).toBe(false)
  })

  test("but a conversation larger than the preserved tail still fires", () => {
    const sessionID = "ses_recover"
    observeBaseline(sessionID, 40_000)
    const limit = effectiveUsable({ cfg: cfg(), model: model(), sessionID })
    const budget = preserveRecentBudget({ cfg: cfg(), model: model() })
    // At this window the room above a 40,000 prefix is large enough that reaching the threshold
    // already means more conversation than compaction would preserve — so the guard must NOT block it.
    expect(limit - 40_000).toBeGreaterThan(budget)
    expect(isOverflow({ cfg: cfg(), tokens: tok(limit + 10), model: model(), sessionID })).toBe(true)
  })
})

describe("the window it maps into is the one usable() is a fraction of", () => {
  // REGRESSION, measured. `usable()` reads `limit.input` when the provider declares one — and
  // `{context, input, output}` is a legal, user-writable provider shape (config/provider.ts:42-44).
  // Rescaling against `limit.context` regardless put the threshold PAST the model's real input cap,
  // so a conversation that genuinely no longer fits stopped compacting and went to the provider to be
  // rejected. This is the same "lands past the window" trap the rescale exists to avoid, entered
  // through the other door.
  const narrow = () => {
    const m = model(200_000, 8_000) as any
    m.limit.input = 32_000
    return m as Provider.Model
  }

  test("the threshold never lands past limit.input, for any prefix", () => {
    for (const prefix of [5_000, 10_000, 20_000, 25_000, 28_000, 31_000]) {
      resetBaselines()
      observeBaseline("ses_narrow", prefix)
      const limit = effectiveUsable({ cfg: cfg(), model: narrow(), sessionID: "ses_narrow" })
      expect(limit).toBeLessThanOrEqual(32_000)
    }
  })

  test("a conversation past the real input cap still compacts", () => {
    const sessionID = "ses_narrow_fire"
    observeBaseline(sessionID, 25_000)
    expect(usable({ cfg: cfg(), model: narrow() })).toBe(24_000)
    // 46,000 was the old answer — 14,000 above a 32,000 cap.
    expect(effectiveUsable({ cfg: cfg(), model: narrow(), sessionID })).toBeLessThan(32_000)
    for (const count of [34_000, 40_000, 60_000]) {
      expect(isOverflow({ cfg: cfg(), tokens: tok(count), model: narrow(), sessionID })).toBe(true)
    }
  })

  test("a model without limit.input is judged exactly as before", () => {
    // The control: the correction must move nothing on the shape the fix was measured on.
    const sessionID = "ses_wide_ctl"
    observeBaseline(sessionID, PREFIX)
    expect(effectiveUsable({ cfg: cfg(), model: model(), sessionID })).toBe(57_079)
  })
})

describe("degrades honestly rather than to nonsense", () => {
  test("the kill-switch restores the previous behaviour exactly", () => {
    process.env["FABULA_OVERFLOW_BASELINE"] = "0"
    const sessionID = "ses_off"
    for (const total of AGENT_TURNS) {
      expect(isOverflow({ cfg: cfg(), tokens: tok(total), model: model(), sessionID })).toBe(true)
    }
    expect(effectiveUsable({ cfg: cfg(), model: model(), sessionID, observed: PREFIX })).toBe(29_632)
  })

  test("a baseline at or above the window is not usable — absolute thresholds stand", () => {
    const sessionID = "ses_degenerate"
    observeBaseline(sessionID, WINDOW + 5_000)
    expect(effectiveUsable({ cfg: cfg(), model: model(), sessionID })).toBe(29_632)
    expect(isOverflow({ cfg: cfg(), tokens: tok(70_000), model: model(), sessionID })).toBe(true)
  })

  test("compaction disabled still wins over everything", () => {
    const sessionID = "ses_disabled"
    expect(isOverflow({ cfg: cfg({ auto: false }), tokens: tok(90_000), model: model(), sessionID })).toBe(false)
  })

  test("a zero context window is never an overflow", () => {
    expect(isOverflow({ cfg: cfg(), tokens: tok(10), model: model(0), sessionID: "ses_zero" })).toBe(false)
  })
})

describe("the baseline is measured and self-correcting", () => {
  test("it is the smallest total ever seen, so a late first observation repairs itself", () => {
    const sessionID = "ses_min"
    expect(observeBaseline(sessionID, 60_000)).toBe(60_000)
    expect(observeBaseline(sessionID, PREFIX)).toBe(PREFIX)
    expect(observeBaseline(sessionID, 65_000)).toBe(PREFIX) // a larger later total never raises it
  })

  test("the two runs of the failing session measured different prefixes — it is read, not assumed", () => {
    // NOT `expect(PREFIX).not.toBe(PREFIX_RUN1)`: that compares two literals in this file and is true
    // whatever the product does — decoration in a test whose title claims a measurement.
    const a = "ses_a"
    const b = "ses_b"
    observeBaseline(a, PREFIX)
    observeBaseline(b, PREFIX_RUN1)
    expect(effectiveUsable({ cfg: cfg(), model: model(), sessionID: a })).not.toBe(
      effectiveUsable({ cfg: cfg(), model: model(), sessionID: b }),
    )
  })

  test("nonsense observations are ignored", () => {
    const sessionID = "ses_junk"
    observeBaseline(sessionID, PREFIX)
    expect(observeBaseline(sessionID, 0)).toBe(PREFIX)
    expect(observeBaseline(sessionID, Number.NaN)).toBe(PREFIX)
    expect(observeBaseline(sessionID, -5)).toBe(PREFIX)
  })

  test("the store is bounded, and an in-use session keeps its measurement", () => {
    // The assertion has to be something eviction would DESTROY. Re-observing the same value proves
    // nothing: an evicted session re-observed with that value looks identical to one that survived.
    // So the hot session is only ever touched with a LARGER total afterwards — if its memory survived,
    // the minimum still reads the original; if it was evicted, the larger total became the baseline.
    const kept = "ses_hot"
    observeBaseline(kept, PREFIX)
    for (let i = 0; i < 600; i++) {
      observeBaseline(`ses_cold_${i}`, 30_000)
      observeBaseline(kept, 65_000)
    }
    expect(observeBaseline(kept, 65_000)).toBe(PREFIX)
  })

  test("the store really is bounded — a session nobody touched again is forgotten", () => {
    // Without this the map grows for the life of the process. Eviction is observable: the forgotten
    // session reports no baseline at all, and its next turn simply re-measures one.
    observeBaseline("ses_first", 30_000)
    for (let i = 0; i < 600; i++) observeBaseline(`ses_fill_${i}`, 31_000)
    expect(baselineFor("ses_first")).toBe(0)
  })

  test("READING a baseline also counts as using it", () => {
    // `baselineFor` is the read path; a reader that does not refresh the entry lets an actively-read
    // session be evicted underneath it.
    const kept = "ses_read"
    observeBaseline(kept, PREFIX)
    for (let i = 0; i < 600; i++) {
      observeBaseline(`ses_other_${i}`, 30_000)
      baselineFor(kept)
    }
    expect(observeBaseline(kept, 65_000)).toBe(PREFIX)
  })
})

describe("pressure agrees with the trigger", () => {
  test("pressure is measured against the same rescaled limit", () => {
    const sessionID = "ses_pressure"
    observeBaseline(sessionID, PREFIX)
    // The prefix alone used to read as maximum pressure (47,779 / 29,632 = 161%).
    expect(pressureLevel({ cfg: cfg(), tokens: tok(PREFIX), model: model() })).toBe(3)
    expect(pressureLevel({ cfg: cfg(), tokens: tok(PREFIX), model: model(), sessionID })).toBeLessThan(3)
  })
})

describe("the rescale keeps the property naive subtraction destroys", () => {
  test("the threshold never lands past the window, for any prefix", () => {
    for (const prefix of [1_000, 20_000, PREFIX, 60_000, 69_000]) {
      const scaled = rescaleAboveBaseline([29_632], WINDOW, prefix)[0]!
      expect(scaled).toBeLessThan(WINDOW)
      expect(scaled).toBeGreaterThanOrEqual(prefix)
    }
  })
})

describe("the baseline belongs to the SLICE, not the session", () => {
  // Subagents share the parent's sessionID (processor.ts:211) and their prompt+belt is smaller, so
  // their totals are smaller — and the baseline is a MINIMUM. Keyed by session alone, one background
  // pass pulls the main conversation's baseline down and re-arms the loop this file exists to remove.
  const S = "ses_shared"

  test("a subagent turn does not move the main conversation's threshold", () => {
    const before = (() => {
      isOverflow({ cfg: cfg(), tokens: tok(48_027), model: model(), sessionID: S, agentID: "main" })
      return effectiveUsable({ cfg: cfg(), model: model(), sessionID: S, agentID: "main" })
    })()
    isOverflow({ cfg: cfg(), tokens: tok(6_000), model: model(), sessionID: S, agentID: "explore" })
    isOverflow({ cfg: cfg(), tokens: tok(5_200), model: model(), sessionID: S, agentID: "checkpoint-writer" })
    expect(effectiveUsable({ cfg: cfg(), model: model(), sessionID: S, agentID: "main" })).toBe(before)
    expect(isOverflow({ cfg: cfg(), tokens: tok(48_027), model: model(), sessionID: S, agentID: "main" })).toBe(false)
  })

  test("CONTROL: without the slice the same sequence poisons the baseline", () => {
    // Proves the assertion above is not vacuous — this is the measured defect, reproduced.
    resetBaselines()
    expect(observeBaseline(S, 48_027)).toBe(48_027)
    expect(observeBaseline(S, 6_000)).toBe(6_000)
    expect(isOverflow({ cfg: cfg(), tokens: tok(48_027), model: model(), sessionID: S })).toBe(true)
  })

  test("an unnamed slice is the main one", () => {
    resetBaselines()
    observeBaseline(S, 48_027, "main")
    expect(observeBaseline(S, 99_999)).toBe(48_027)
  })

  test("two slices keep separate measurements", () => {
    resetBaselines()
    observeBaseline(S, 48_027, "main")
    observeBaseline(S, 6_000, "explore")
    expect(observeBaseline(S, 99_999, "main")).toBe(48_027)
    expect(observeBaseline(S, 99_999, "explore")).toBe(6_000)
  })
})

describe("what compaction PRESERVES is a fraction of the conversation, not of the prompt", () => {
  // The same disease one level down. `preserveRecentBudget` took its quarter from `usable()`, which
  // the fixed prompt already dominates: on the failing configuration it preserved 7,408 tokens of a
  // conversation that only reached 9,194 before the threshold — 386 tokens of headroom before the
  // NEXT firing, i.e. a full model call bought one short turn. Measured from the room the conversation
  // actually has, the same quarter leaves 2,393.
  const S = "ses_head"
  const BASELINE = 48_027

  test("the headroom between two firings is not one turn", () => {
    resetBaselines()
    observeBaseline(S, BASELINE, "main")
    const preserve = preserveRecentBudget({ cfg: cfg(), model: model(), sessionID: S, agentID: "main" })
    const threshold = effectiveUsable({ cfg: cfg(), model: model(), sessionID: S, agentID: "main" })
    const headroom = threshold - (BASELINE + preserve)
    expect(preserve).toBeLessThan(7_408) // what the old base gave
    expect(headroom).toBeGreaterThan(2_000)
  })

  test("with no baseline the budget is byte-for-byte what it was", () => {
    resetBaselines()
    expect(preserveRecentBudget({ cfg: cfg(), model: model() })).toBe(7_408)
    expect(preserveRecentBudget({ cfg: cfg(), model: model(), sessionID: "ses_unknown", agentID: "main" })).toBe(7_408)
  })

  test("an explicit configuration still wins", () => {
    resetBaselines()
    observeBaseline(S, BASELINE, "main")
    expect(preserveRecentBudget({ cfg: cfg({ preserve: 1_234 }), model: model(), sessionID: S, agentID: "main" })).toBe(1_234)
  })

  test("the room is per-slice and zero when unmeasured", () => {
    resetBaselines()
    expect(conversationRoom({ cfg: cfg(), model: model(), sessionID: S, agentID: "main" })).toBe(0)
    observeBaseline(S, BASELINE, "main")
    expect(conversationRoom({ cfg: cfg(), model: model(), sessionID: S, agentID: "main" })).toBe(69_632 - BASELINE)
    expect(conversationRoom({ cfg: cfg(), model: model(), sessionID: S, agentID: "explore" })).toBe(0)
  })
})
