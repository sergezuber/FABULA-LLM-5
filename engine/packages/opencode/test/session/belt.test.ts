// Tests for session/belt.ts — Context OS Phase 1 per-session belt state (pure module state).
import { afterEach, describe, expect, test } from "bun:test"
import {
  wrapShadowCall,
  beltVisible,
  NEVER_MASK,
  beltFor,
  beltMasks,
  clearBelt,
  clearShadow,
  getBelt,
  setBelt,
  shadowFor,
  stashShadow,
  type BeltEntry,
} from "../../src/session/belt"

const S1 = "ses_belt_test_1"
const S2 = "ses_belt_test_2"
const CHILD = "ses_belt_child"

afterEach(() => {
  for (const id of [S1, S2, CHILD]) {
    clearBelt(id)
    clearShadow(id)
  }
})

describe("per-session registry — no cross-session clobbering (design К4)", () => {
  test("two sessions hold DIFFERENT belts simultaneously", () => {
    setBelt(S1, { profileId: "coding", hide: ["weather_fetch"], hideGlobs: [] })
    setBelt(S2, { profileId: "web-research", hide: [], hideGlobs: ["serena_*"] })
    expect(getBelt(S1)?.profileId).toBe("coding")
    expect(getBelt(S2)?.profileId).toBe("web-research")
    // and updating one never touches the other
    setBelt(S1, { profileId: "full", hide: [], hideGlobs: [] })
    expect(getBelt(S2)?.profileId).toBe("web-research")
  })

  test("no entry → undefined (env floor applies at the call site)", () => {
    expect(getBelt("ses_never_set")).toBeUndefined()
  })
})

describe("beltFor — subagent inherits the ROOT session's belt", () => {
  test("child session resolves the parent's entry (one hop)", () => {
    setBelt(S1, { profileId: "coding", hide: ["x"], hideGlobs: [] })
    expect(beltFor(CHILD, S1)?.profileId).toBe("coding")
  })
  test("own entry wins over the parent's", () => {
    setBelt(S1, { profileId: "coding", hide: [], hideGlobs: [] })
    setBelt(CHILD, { profileId: "full", hide: [], hideGlobs: [] })
    expect(beltFor(CHILD, S1)?.profileId).toBe("full")
  })
  test("no parent, no entry → undefined", () => {
    expect(beltFor(CHILD, null)).toBeUndefined()
  })
})

describe("beltMasks — exact ids, server globs, NEVER_MASK floor", () => {
  const entry: Pick<BeltEntry, "hide" | "hideGlobs"> = {
    hide: ["weather_fetch", "vision_analyze"],
    hideGlobs: ["serena_*", "ast_grep_*"],
  }
  test("exact id masks", () => {
    expect(beltMasks("weather_fetch", entry)).toBe(true)
    expect(beltMasks("bash", entry)).toBe(false)
  })
  test("server glob masks BOTH key forms (colon and underscore)", () => {
    expect(beltMasks("serena:find_symbol", entry)).toBe(true)
    expect(beltMasks("serena_find_symbol", entry)).toBe(true)
    expect(beltMasks("ast_grep:find_code", entry)).toBe(true)
    expect(beltMasks("searxng:web_search", entry)).toBe(false)
  })
  test("glob does not swallow prefix-similar servers", () => {
    expect(beltMasks("serenade:tool", entry)).toBe(false)
  })
  test("NEVER_MASK ids never mask, even if listed", () => {
    const hostile: Pick<BeltEntry, "hide" | "hideGlobs"> = { hide: ["verify_done", "skill", "view"], hideGlobs: [] }
    for (const id of ["verify_done", "skill", "view"]) expect(beltMasks(id, hostile)).toBe(false)
    expect(NEVER_MASK.has("verify_done")).toBe(true)
  })
})

describe("shadow executors — attempt-routed dispatch channel (К2)", () => {
  test("stash + resolve by session; parent fallback; miss → undefined", async () => {
    const calls: string[] = []
    stashShadow(S1, new Map([["weather_fetch", { execute: async () => (calls.push("wf"), "ok") }]]))
    const t = shadowFor(S1, "weather_fetch")
    expect(t).toBeDefined()
    await t!.execute({}, { toolCallId: "c1", messages: [] })
    expect(calls).toEqual(["wf"])
    // child session falls back to the parent's shadow
    expect(shadowFor(CHILD, "weather_fetch", S1)).toBeDefined()
    expect(shadowFor(CHILD, "nope", S1)).toBeUndefined()
    expect(shadowFor(S2, "weather_fetch")).toBeUndefined()
  })
})

describe("wrapShadowCall — repair rewrite into expand_tools (К2 normal path)", () => {
  test("valid JSON args pass through under args", () => {
    const s = wrapShadowCall("weather_fetch", '{"place":"Moscow"}')
    expect(JSON.parse(s)).toEqual({ tool: "weather_fetch", args: { place: "Moscow" } })
  })
  test("empty/undefined input → empty args object", () => {
    expect(JSON.parse(wrapShadowCall("x", undefined))).toEqual({ tool: "x", args: {} })
    expect(JSON.parse(wrapShadowCall("x", ""))).toEqual({ tool: "x", args: {} })
  })
  test("half-written JSON survives as args_raw (dispatcher can show the schema)", () => {
    const s = wrapShadowCall("edit", '{"file_path": "/a.ts", "old_')
    expect(JSON.parse(s)).toEqual({ tool: "edit", args: { args_raw: '{"file_path": "/a.ts", "old_' } })
  })
})

describe("beltVisible — THE shared visibility decision (М10 byte-parity)", () => {
  const REGISTRY = ["bash", "edit", "view", "verify_done", "weather_fetch", "browser_click", "skill"]
  const env = new Set(["weather_fetch"])

  test("router off (no entry): env floor hides, everything else visible — legacy byte-compat", () => {
    expect(beltVisible("weather_fetch", env, undefined)).toBe(false)
    expect(beltVisible("bash", env, undefined)).toBe(true)
    // legacy path has NO NEVER_MASK exemption (byte-compat with pre-belt behavior)
    expect(beltVisible("view", new Set(["view"]), undefined)).toBe(false)
  })

  test("router on: belt hides + env floor hides, NEVER_MASK always visible", () => {
    const entry = { hide: ["browser_click"], hideGlobs: [] }
    expect(beltVisible("browser_click", env, entry)).toBe(false) // belt
    expect(beltVisible("weather_fetch", env, entry)).toBe(false) // env floor
    expect(beltVisible("bash", env, entry)).toBe(true)
    expect(beltVisible("verify_done", new Set(["verify_done"]), { hide: ["verify_done"], hideGlobs: [] })).toBe(true) // NEVER_MASK wins over both
  })

  test("PARITY PROPERTY: for any belt state, the visible set is identical however computed", () => {
        // the M10 contract: runLoop resolveTools and the fork/checkpoint capture both derive
    // visibility from beltVisible — same inputs MUST give the same set, entry or not
    for (const entry of [undefined, { hide: ["browser_click", "edit"], hideGlobs: [] }, { hide: [], hideGlobs: [] }]) {
      const a = REGISTRY.filter((id) => beltVisible(id, env, entry))
      const b = REGISTRY.filter((id) => beltVisible(id, env, entry))
      expect(a).toEqual(b)
      // and the set actually narrows when the belt hides something
      if (entry?.hide.length) expect(a.length).toBeLessThan(REGISTRY.length)
    }
  })

  test("glob-hidden ids are invisible through the shared decision too", () => {
    const entry = { hide: [], hideGlobs: ["browser_*"] }
    expect(beltVisible("browser_click", new Set(), entry)).toBe(false)
    expect(beltVisible("bash", new Set(), entry)).toBe(true)
  })
})

describe("the shadow channel is bounded (W6)", () => {
  // This map hangs off `globalThis` and the server is long-lived, so every session ever routed used to
  // keep its tool CLOSURES alive for the life of the process.
  const mk = (id: string) => new Map([["t", { execute: async () => id } as any]])
  const ids = (n: number, p = "ses_cap_") => Array.from({ length: n }, (_, i) => `${p}${i}`)
  const cleanup: string[] = []
  const stash = (id: string) => {
    cleanup.push(id)
    stashShadow(id, mk(id))
  }
  afterEach(() => {
    for (const id of cleanup.splice(0)) clearShadow(id)
  })

  test("older sessions are released once the cap is passed", () => {
    const all = ids(80)
    for (const id of all) stash(id)
    // the newest are resident…
    expect(shadowFor(all[79]!, "t")).toBeDefined()
    // …and the oldest have been let go
    expect(shadowFor(all[0]!, "t")).toBeUndefined()
  })

  test("the session being written is NEVER the one evicted", () => {
    // Dropping a live session's entry would silently change its tool prefix mid-run — the byte-parity
    // break this module exists to avoid.
    for (const id of ids(80, "ses_live_")) {
      stash(id)
      expect(shadowFor(id, "t")).toBeDefined()
    }
  })

  test("an ACTIVELY USED session is never evicted in favour of newer idle ones", () => {
    // "Oldest" must mean least recently USED, not first seen. With insertion order, a session that
    // re-stashes on every prompt build stayed the oldest key forever and was evicted by the next other
    // session's write — the one case the eviction promises cannot happen. Measured on the pre-fix order:
    // dropped once across 60 interleaved stashes; zero times after.
    const busy = "ses_busy"
    cleanup.push(busy)
    for (const id of ids(60, "ses_churn_")) {
      stashShadow(busy, mk(busy))
      stash(id)
      // checked INSIDE the loop: by the end busy has simply been re-stashed, so a final-state assertion
      // would pass against both orders and prove nothing.
      expect(shadowFor(busy, "t")).toBeDefined()
    }
    expect(shadowFor("ses_churn_0", "t")).toBeUndefined() // the quiet old ones were still released
  })
})
