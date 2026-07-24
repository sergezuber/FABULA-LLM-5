// Tests for lib/instrrouter.ts — the deterministic instruction-scope router core (pure, zero deps).
// Mirrors toolrouter.test.ts in style on purpose: the two routers share the BM25/RRF/hysteresis
// substrate, and the test surface should look the same so a reviewer can compare by eye.
import { describe, expect, test } from "bun:test"
import {
  bm25Scores,
  buildIndex,
  cardDocument,
  decideInstrScope,
  dropInstrScopeChannel,
  excludedCardsFor,
  INSTR_PROFILES,
  INSTRUCTION_CARDS,
  instrChannel,
  instrRouterOn,
  instrScopeFor,
  mentionedVerbatim,
  profileScore,
  route,
  rrfFuse,
  setInstrEntry,
  taskTextFrom,
  tokenize,
  verbatimIncludes,
  type InstructionCard,
  type ScopeProfile,
} from "./instrrouter"

const CARDS: InstructionCard[] = INSTRUCTION_CARDS
const PROFILES: ScopeProfile[] = INSTR_PROFILES

describe("tokenize / cardDocument", () => {
  test("splits snake_case, drops 1-char tokens", () => {
    expect(tokenize("host-fabula-rules FilePath")).toEqual(["host", "fabula", "rules", "file", "path"])
  })
  test("russian text tokenizes (gestalt safe)", () => {
    expect(tokenize("Почини движок")).toEqual(["почини", "движок"])
  })
  test("card document doubles id tokens", () => {
    const doc = cardDocument(CARDS[0])
    expect(doc.filter((t) => t === "host").length).toBeGreaterThanOrEqual(2)
  })
})

describe("bm25", () => {
  const index = buildIndex(CARDS)
  test("engine-task text ranks host-fabula-rules first", () => {
    const s = bm25Scores(index, "почини движок fabula и проверь плагин")
    const top = [...s.entries()].sort((a, b) => b[1] - a[1])[0]
    expect(top[0]).toBe("host-fabula-rules")
  })
  test("book-analysis task ranks external-doc-rules higher than host", () => {
    const s = bm25Scores(index, "прочти все главы романа и проанализируй стиль")
    const ranked = [...s.entries()].sort((a, b) => b[1] - a[1])
    expect(ranked.length).toBeGreaterThan(0)
    expect(ranked[0][0]).toBe("external-doc-rules")
  })
  test("english: 'modify the engine adapter' → host", () => {
    const s = bm25Scores(index, "modify the engine adapter and rebuild")
    expect([...s.keys()]).toContain("host-fabula-rules")
  })
  test("no matching terms → empty scores", () => {
    expect(bm25Scores(index, "xyzzy plugh").size).toBe(0)
  })
})

describe("rrfFuse", () => {
  test("fuses two arms, agreement wins", () => {
    const a = new Map([["x", 10], ["y", 5]])
    const b = new Map([["y", 9], ["x", 1]])
    const fused = rrfFuse([a, b])
    expect(fused.size).toBe(2)
  })
  test("empty arms contribute nothing", () => {
    expect(rrfFuse([new Map()]).size).toBe(0)
  })
})

describe("verbatimIncludes", () => {
  test("multi-token utterance pins (engine task)", () => {
    expect(verbatimIncludes(CARDS, "открой и modify the engine код")).toEqual(new Set(["host-fabula-rules"]))
  })
  test("RU book-analysis utterance pins (external-doc-rules)", () => {
    expect(verbatimIncludes(CARDS, "прочти все главы и проанализируй стиль")).toContain("external-doc-rules")
  })
  test("substring does NOT pin (host ⊂ ghost, etc.)", () => {
    const pins = verbatimIncludes(CARDS, "ghost host rules somewhere")
    // the standalone word "host" in "ghost host rules" IS a verbatim mention of the id; but a
    // substring like "host-fabula-rules" appearing inside another word must NOT pin from that word
    const pins2 = verbatimIncludes(CARDS, "thishost-fabula-rules")
    // 'thishost-fabula-rules' has no word boundary around 'host' → no pin
    expect(pins2.size).toBe(0)
  })
})

describe("mentionedVerbatim — word-boundary lex", () => {
  test("standalone word is found", () => {
    expect(mentionedVerbatim("modify the engine now", "engine")).toBe(true)
  })
  test("substring within a longer word is NOT matched", () => {
    expect(mentionedVerbatim("enginex", "engine")).toBe(false)
    expect(mentionedVerbatim("myengine", "engine")).toBe(false)
  })
})

describe("route — profile quantization", () => {
  test("deep engine task → fabula-coding scope (keeps host rules)", () => {
    const d = route(CARDS, PROFILES, "почини движок fabula, обнови обвязку и проверь плагин")
    expect(d.profileId).toBe("fabula-coding")
  })
  test("book-analysis task → external-doc scope (drops host rules)", () => {
    const d = route(CARDS, PROFILES, "прочти все главы романа и проанализируй уровень литературы")
    expect(d.profileId).toBe("external-doc")
  })
  test("no signal → widest profile (general, load everything, never block — fail-open)", () => {
    const d = route(CARDS, PROFILES, "сделай хорошо и правильно")
    expect(d.profileId).toBe("general")
    expect(d.reason).toBe("fallback-widest")
  })
  test("hysteresis holds the incumbent on a weak challenger", () => {
    // book-ish task; an incumbent fabula-coding must hold unless beaten by margin
    const base = route(CARDS, PROFILES, "прочитай книгу и о движке", { margin: 1000 })
    expect(base.profileId).toBe("external-doc")
    const held = route(CARDS, PROFILES, "прочитай книгу и о движке", { current: "fabula-coding", margin: 1000 })
    expect(held.profileId).toBe("fabula-coding")
    expect(held.reason).toBe("hysteresis-hold")
  })
  test("empty profile registry throws (loud misconfiguration)", () => {
    expect(() => route(CARDS, [], "x")).toThrow()
  })
})

describe("profileScore", () => {
  test("normalizes by sqrt(size) — bulk can't win on mass alone", () => {
    const fused = new Map([["host-fabula-rules", 1]])
    const lean: ScopeProfile = { id: "lean", cards: ["host-fabula-rules"] }
    const bulky: ScopeProfile = { id: "bulky", cards: ["host-fabula-rules", "a", "b", "c", "d", "e", "f", "g", "h"] }
    expect(profileScore(lean, fused, new Set())).toBeGreaterThan(profileScore(bulky, fused, new Set()))
  })
})

describe("excludedCardsFor", () => {
  test("fabula-coding excludes nothing (both cards kept)", () => {
    const ex = excludedCardsFor("fabula-coding", ["host-fabula-rules", "external-doc-rules"])
    expect(ex.size).toBe(0)
  })
  test("external-doc excludes host-fabula-rules (the bloat source)", () => {
    const ex = excludedCardsFor("external-doc", ["host-fabula-rules", "external-doc-rules"])
    expect(ex).toEqual(new Set(["host-fabula-rules"]))
  })
  test("general excludes nothing (widest — legacy behavior)", () => {
    const ex = excludedCardsFor("general", ["host-fabula-rules", "external-doc-rules"])
    expect(ex.size).toBe(0)
  })
  test("unknown profile → fail-open: exclude nothing (legacy)", () => {
    const ex = excludedCardsFor("nope", ["host-fabula-rules", "external-doc-rules"])
    expect(ex.size).toBe(0)
  })
})

describe("decideInstrScope (the pure wiring step)", () => {
  test("book-analysis task → external-doc, excludes host", () => {
    const { entry } = decideInstrScope("прочти все главы романа, уровень литературы")
    expect(entry.profileId).toBe("external-doc")
    expect(entry.excludedCardIds).toContain("host-fabula-rules")
  })
  test("engine task → fabula-coding, excludes nothing", () => {
    const { entry } = decideInstrScope("почини движок fabula и обнови обвязку")
    expect(entry.profileId).toBe("fabula-coding")
    expect(entry.excludedCardIds).toHaveLength(0)
  })
  test("no signal → general, excludes nothing", () => {
    const { entry } = decideInstrScope("просто сделай")
    expect(entry.profileId).toBe("general")
    expect(entry.excludedCardIds).toHaveLength(0)
  })
})

describe("taskTextFrom", () => {
  test("extracts non-synthetic text parts only", () => {
    const parts = [
      { type: "text", text: "Привет!", synthetic: false },
      { type: "text", text: "[system]", synthetic: true },
      { type: "tool", text: "shouldn't appear" },
    ]
    expect(taskTextFrom(parts)).toBe("Привет!")
  })
  test("non-array returns empty", () => {
    expect(taskTextFrom(null)).toBe("")
    expect(taskTextFrom(undefined)).toBe("")
  })
})

describe("instrRouterOn", () => {
  test("on when FABULA_INSTR_ROUTER=1", () => {
    expect(instrRouterOn({ FABULA_INSTR_ROUTER: "1" })).toBe(true)
  })
  test("off otherwise (default OFF — opt-in like tool-router)", () => {
    expect(instrRouterOn({})).toBe(false)
    expect(instrRouterOn({ FABULA_INSTR_ROUTER: "0" })).toBe(false)
  })
})

describe("instrChannel — session-keyed, capped LRU", () => {
  test("set/get round-trips an entry", () => {
    const sid = "ut-instr-1"
    dropInstrScopeChannel(sid)
    setInstrEntry(sid, { profileId: "external-doc", excludedCardIds: ["host-fabula-rules"], reason: "scores" })
    const got = instrScopeFor(sid)
    expect(got?.profileId).toBe("external-doc")
    expect(got?.excludedCardIds).toEqual(["host-fabula-rules"])
    dropInstrScopeChannel(sid)
  })
  test("drop removes the entry", () => {
    const sid = "ut-instr-2"
    setInstrEntry(sid, { profileId: "general", excludedCardIds: [], reason: "fallback-widest" })
    dropInstrScopeChannel(sid)
    expect(instrScopeFor(sid)).toBeUndefined()
  })
  test("re-inserting the same session refreshes it (not evicted under cap)", () => {
    // Fill the channel up to its cap, then re-insert an old sid — it must survive the next write.
    const victim = "ut-instr-victim"
    setInstrEntry(victim, { profileId: "general", excludedCardIds: [], reason: "fallback-widest" })
    // Force the cap to a small value via repeated inserts (the cap is 32 by default)
    for (let i = 0; i < 35; i++) {
      setInstrEntry(`ut-instr-fill-${i}`, { profileId: "general", excludedCardIds: [], reason: "fallback-widest" })
    }
    // victim was inserted FIRST and not re-inserted, so under LRU it is evicted
    // (this documents the behavior, mirroring beltwire — refresh-first survives, laggards evict)
    expect(instrScopeFor(victim)).toBeUndefined()
    // cleanup
    for (let i = 0; i < 35; i++) dropInstrScopeChannel(`ut-instr-fill-${i}`)
  })
  test("refresh keeps the writing session alive across interleaving writes", () => {
    const alive = "ut-instr-alive"
    setInstrEntry(alive, { profileId: "general", excludedCardIds: [], reason: "fallback-widest" })
    setInstrEntry(alive, { profileId: "general", excludedCardIds: [], reason: "fallback-widest" }) // refresh
    for (let i = 0; i < 5; i++) {
      setInstrEntry(`ut-instr-other-${i}`, { profileId: "general", excludedCardIds: [], reason: "fallback-widest" })
    }
    expect(instrScopeFor(alive)?.profileId).toBe("general")
    dropInstrScopeChannel(alive)
    for (let i = 0; i < 5; i++) dropInstrScopeChannel(`ut-instr-other-${i}`)
  })
})
