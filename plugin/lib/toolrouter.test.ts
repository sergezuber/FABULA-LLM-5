// Tests for lib/toolrouter.ts — Context OS §7 deterministic router core (pure).
import { describe, expect, test } from "bun:test"
import {
  bm25Scores,
  buildIndex,
  cardDocument,
  profileScore,
  route,
  rrfFuse,
  tokenize,
  verbatimIncludes,
  type Profile,
  type ToolCard,
} from "./toolrouter"

const CARDS: ToolCard[] = [
  { id: "bash", description: "Run a shell command", params: ["command"], tags: ["code"], utterances: ["запусти команду", "run tests"] },
  { id: "str_replace", description: "Exact string replacement in a file", params: ["file_path", "old_str", "new_str"], tags: ["files"], utterances: ["замени строку в файле", "edit the file"] },
  { id: "web_search", description: "Search the web via SearXNG", params: ["query"], tags: ["web"], utterances: ["поищи в интернете", "search the web for"] },
  { id: "weather_fetch", description: "Get the weather forecast", params: ["place"], tags: ["web"], utterances: ["какая погода", "weather in"] },
  { id: "grep", description: "Search file contents with a regex", params: ["pattern"], tags: ["files"], utterances: ["найди в файлах"] },
]

const PROFILES: Profile[] = [
  { id: "coding", tools: ["bash", "str_replace", "grep"] },
  { id: "web", tools: ["web_search", "weather_fetch"] },
  { id: "full", tools: ["bash", "str_replace", "grep", "web_search", "weather_fetch"] },
]

describe("tokenize / cardDocument", () => {
  test("splits snake_case and camelCase, lowercases, drops 1-char tokens", () => {
    expect(tokenize("str_replace FilePath a")).toEqual(["str", "replace", "file", "path"])
  })
  test("russian text tokenizes", () => {
    expect(tokenize("Замени строку")).toEqual(["замени", "строку"])
  })
  test("card document doubles id tokens", () => {
    const doc = cardDocument(CARDS[0])
    expect(doc.filter((t) => t === "bash")).toHaveLength(2)
  })
})

describe("bm25", () => {
  const index = buildIndex(CARDS)
  test("exact intent word ranks the right tool first", () => {
    const s = bm25Scores(index, "поищи в интернете свежие статьи")
    const top = [...s.entries()].sort((a, b) => b[1] - a[1])[0]
    expect(top[0]).toBe("web_search")
  })
  test("english task matches utterances", () => {
    const s = bm25Scores(index, "run tests and fix them")
    expect([...s.keys()]).toContain("bash")
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
    // both rank x and y; x is 1st+2nd, y is 2nd+1st → equal; add a third arm to break
    const c = new Map([["x", 1]])
    const fused3 = rrfFuse([a, b, c])
    expect(fused3.get("x")! > fused3.get("y")!).toBe(true)
    expect(fused.size).toBe(2)
  })
  test("empty arms contribute nothing", () => {
    expect(rrfFuse([new Map()]).size).toBe(0)
  })
})

describe("verbatimIncludes", () => {
  test("full id mention pins the tool", () => {
    expect(verbatimIncludes(CARDS, "используй str_replace для правки")).toEqual(new Set(["str_replace"]))
  })
  test("id word mention pins (grep)", () => {
    expect(verbatimIncludes(CARDS, "сделай grep по репе")).toEqual(new Set(["grep"]))
  })
  test("param name mention pins the owner tool", () => {
    const pins = verbatimIncludes(CARDS, "поменяй old_str на новое")
    expect(pins.has("str_replace")).toBe(true)
  })
  test("short ids don't false-positive from substrings", () => {
        // "bash" (RU) is not mentioned; 'bash' as a substring of a Russian word must not be pinned by that word
    const pins = verbatimIncludes(CARDS, "разложи по полочкам")
    expect(pins.size).toBe(0)
  })
  test("REGRESSION: param inside another tool's id must NOT pin (place ⊂ str_replace)", () => {
    const pins = verbatimIncludes(CARDS, "используй str_replace для правки")
    expect(pins.has("weather_fetch")).toBe(false) // 'place' is _-bounded inside str_replace
    expect(pins).toEqual(new Set(["str_replace"]))
  })
  test("REGRESSION: id inside a longer word must NOT pin (read ⊂ already)", () => {
    const cards = CARDS.concat([{ id: "read", description: "Read a file" }])
    const pins = verbatimIncludes(cards, "this is already done")
    expect(pins.has("read")).toBe(false)
  })
})

describe("route — profile quantization", () => {
  test("coding task → coding profile", () => {
    const d = route(CARDS, PROFILES, "запусти команду сборки и замени строку в файле")
    expect(d.profileId).toBe("coding")
    expect(d.reason).toBe("scores")
  })
  test("web task → web profile", () => {
    const d = route(CARDS, PROFILES, "поищи в интернете какая погода в Москве")
    expect(d.profileId).toBe("web")
  })
  test("no signal → widest profile (never block)", () => {
    const d = route(CARDS, PROFILES, "сделай хорошо")
    expect(d.profileId).toBe("full")
    expect(d.reason).toBe("fallback-widest")
  })
  test("hysteresis holds the incumbent on a weak challenger", () => {
    // task slightly web-ish; incumbent coding must hold unless beaten by margin
    const base = route(CARDS, PROFILES, "поищи в интернете", { margin: 1000 })
    const held = route(CARDS, PROFILES, "поищи в интернете", { current: "coding", margin: 1000 })
    expect(base.profileId).toBe("web")
    expect(held.profileId).toBe("coding")
    expect(held.reason).toBe("hysteresis-hold")
  })
  test("pinned tool narrows the pool to covering profiles", () => {
    // web_search verbatim + otherwise coding-ish text: only 'web' and 'full' cover the pin
    const d = route(CARDS, PROFILES, "запусти web_search по докам и поправь файл")
    expect(["web", "full"]).toContain(d.profileId)
    expect(d.pinned.has("web_search")).toBe(true)
    expect(d.reason).toBe("verbatim+scores")
  })
  test("dense arm participates in fusion when provided", () => {
    const dense = new Map([["weather_fetch", 0.99]])
    const d = route(CARDS, PROFILES, "что там за окном завтра", { denseArm: dense })
    expect(d.profileId).toBe("web") // dense signal pulled weather → web profile
  })
  test("empty profile registry throws (misconfiguration must be loud)", () => {
    expect(() => route(CARDS, [], "x")).toThrow()
  })
})

describe("profileScore", () => {
  test("normalizes by sqrt(size) so bulk doesn't win", () => {
    const fused = new Map([["bash", 1]])
    const lean: Profile = { id: "lean", tools: ["bash"] }
    const bulky: Profile = { id: "bulky", tools: ["bash", "a", "b", "c", "d", "e", "f", "g", "h"] }
    expect(profileScore(lean, fused, new Set())).toBeGreaterThan(profileScore(bulky, fused, new Set()))
  })
})
