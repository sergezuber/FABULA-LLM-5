// Corner-case + event tests for the Buddy engine. Drives the rAF loop and clock deterministically so
// the async/behavioral fixes from the independent review are pinned:
//  - reduced-motion still positions the hit-area + expires bubbles (#2)
//  - the hit-area is the pet's small box, not the full 102px band (#1)
//  - trigger("level") bumps EXACTLY one level with the right label + XP (#9)
//  - sleep walks to a corner then sleeps; wake wakes (async)
//  - measure() with clientWidth==0 is a no-op (#6)
//  - per-user stats (userId seeds regenSoul); rolled bones are deterministic
//  - unknown trigger kinds are ignored
import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { BuddyEngine, rollBones, statIcon, STAT_DEFS, SPECIES, EYES, HATS, TRIGGER_KINDS, type BuddyLook, type BuddyInfo } from "./buddy-engine"

// ---- deterministic environment ----
let clock = 1000
let rafCb: ((t: number) => void) | null = null
let rafId = 0
const origRAF = globalThis.requestAnimationFrame
const origCAF = globalThis.cancelAnimationFrame
const origPerfNow = globalThis.performance?.now?.bind(globalThis.performance)
const origMatch = (globalThis as any).matchMedia ?? (globalThis as any).window?.matchMedia
let reduced = false

beforeEach(() => {
  clock = 1000; rafCb = null; rafId = 0; reduced = false
  globalThis.requestAnimationFrame = ((cb: any) => { rafCb = cb; return ++rafId }) as any
  globalThis.cancelAnimationFrame = (() => { rafCb = null }) as any
  if (globalThis.performance) globalThis.performance.now = () => clock
  ;(globalThis as any).matchMedia = (q: string) => ({ matches: reduced && /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} })
  if ((globalThis as any).window) (globalThis as any).window.matchMedia = (globalThis as any).matchMedia
})
afterEach(() => {
  globalThis.requestAnimationFrame = origRAF
  globalThis.cancelAnimationFrame = origCAF
  if (globalThis.performance && origPerfNow) globalThis.performance.now = origPerfNow
  ;(globalThis as any).matchMedia = origMatch
  if ((globalThis as any).window) (globalThis as any).window.matchMedia = origMatch
})

// run the pending rAF callback `frames` times, advancing the clock by `dtMs` each frame
function pump(frames: number, dtMs = 16) {
  for (let i = 0; i < frames; i++) { if (!rafCb) break; const cb = rafCb; rafCb = null; clock += dtMs; cb(clock) }
}

function make(width = 400, look: Partial<BuddyLook> = {}, userId = "u1") {
  const el = () => document.createElement("div")
  const composer = el(); Object.defineProperty(composer, "clientWidth", { get: () => width, configurable: true })
  const petCanvas = document.createElement("canvas") as HTMLCanvasElement
  const hit = el() as HTMLElement, bubble = el() as HTMLElement
  const infos: BuddyInfo[] = []
  const base: BuddyLook = { species: "duck", rarity: "rare", eye: "·", hat: "none", shiny: false, scale: 3, autonomous: true, muted: false, ...look }
  const engine = new BuddyEngine({ petCanvas, composer, hit, bubble }, base, (i) => infos.push(i), userId)
  engine.mount()
  const last = () => infos[infos.length - 1]
  return { engine, composer, petCanvas, hit, bubble, infos, last, setWidth: (w: number) => (width = w) }
}

describe("rollBones — deterministic bones", () => {
  test("stable per userId, full field validity", () => {
    const a = rollBones("user-x"), b = rollBones("user-x")
    expect(a).toEqual(b)
    expect(SPECIES).toContain(a.species)
    expect(["common","uncommon","rare","epic","legendary"]).toContain(a.rarity)
    expect(EYES).toContain(a.eye)
    expect(HATS).toContain(a.hat)
    expect(a.hat === "none" || a.rarity !== "common").toBe(true) // commons wear no hat
  })
  test("different ids generally differ; anon fallback works", () => {
    const many = new Set(["a","b","c","d","e","f"].map((u) => rollBones(u).species + rollBones(u).rarity))
    expect(many.size).toBeGreaterThan(1)
    expect(() => rollBones("")).not.toThrow()
  })
})

describe("statIcon", () => {
  test("returns a data URL for all five stats", () => {
    for (const [k, c] of STAT_DEFS) expect(statIcon(k, c)).toMatch(/^data:image/)
  })
})

describe("mount emits companion info", () => {
  test("name, species, five stats, a level", () => {
    const { last } = make()
    const i = last()
    expect(i.species).toBe("duck")
    expect(i.soulName.length).toBeGreaterThan(0)
    expect(Object.keys(i.stats).sort()).toEqual(["CHAOS","DEBUGGING","PATIENCE","SNARK","WISDOM"])
    expect(i.level).toBeGreaterThanOrEqual(1)
  })
  test("per-user stats: same species, different userId → different stats", () => {
    const a = make(400, { species: "cat" }, "alice").last().stats
    const b = make(400, { species: "cat" }, "bob").last().stats
    expect(a).not.toEqual(b)
  })
})

describe("all 18 species draw + emit without error", () => {
  test("setCfg + card draw for every species is safe and species-consistent", () => {
    const { engine, last } = make()
    const card = document.createElement("canvas")
    for (const sp of SPECIES) {
      engine.setCfg({ species: sp })
      expect(last().species).toBe(sp)
      expect(() => engine.drawCardPet(card)).not.toThrow()
    }
  })
})

describe("events → bubbles + observable state", () => {
  test("each event shows its bubble text", () => {
    const { engine, bubble } = make()
    engine.trigger("send"); expect(bubble.textContent).toBe("!")
    engine.trigger("error"); expect(bubble.textContent).toBe("NOT DONE…")
    engine.trigger("awaiting"); expect(bubble.textContent).toBe("нужно ваше ок?")
    engine.trigger("think"); expect(bubble.textContent).toBe("...")
  })
  test("verify adds XP (info changes)", () => {
    const { engine, last } = make()
    const before = last().xpLabel
    engine.trigger("verify")
    expect(last().xpLabel).not.toBe(before)
  })
  test("REGRESSION #9: level bumps EXACTLY one level with correct label + no over-award", () => {
    const { engine, last, bubble } = make()
    for (let n = 0; n < 4; n++) {
      const before = last().level
      engine.trigger("level")
      const after = last().level
      expect(after).toBe(before + 1)                 // exactly +1, not +2
      expect(bubble.textContent).toBe("Уровень " + after + "!") // label matches the real new level
      expect(last().into).toBe(0)                    // landed on the boundary, didn't overshoot
    }
  })
  test("unknown/untrusted kind is ignored (no bubble change, no crash)", () => {
    const { engine, bubble } = make()
    engine.trigger("send"); const b = bubble.textContent
    engine.trigger("totally-bogus" as any)
    expect(bubble.textContent).toBe(b)
    expect(TRIGGER_KINDS).toContain("verify")
  })
})

describe("sleep / wake (async walk-to-corner)", () => {
  test("sleep walks to a corner then sleeps; wake wakes", () => {
    const { engine } = make(400)
    engine.trigger("sleep")
    expect(engine.sleepingNow).toBe(false) // still walking to the corner
    pump(200)                              // enough frames to reach the corner
    expect(engine.sleepingNow).toBe(true)
    engine.trigger("wake")
    expect(engine.sleepingNow).toBe(false)
  })
})

describe("#6 measure() guard", () => {
  test("clientWidth 0 is a no-op; a real width sizes the layer", () => {
    const { engine, petCanvas, setWidth } = make(0)
    expect(engine.layerH).toBe(100)      // default kept — measure bailed on width 0
    expect(petCanvas.width).not.toBe(102)
    setWidth(500); engine.measure()
    expect(engine.layerH).toBe(Math.round(34 * 3)) // 102
    expect(petCanvas.width).toBe(500)
  })
})

describe("#1 hit-area is the pet's small box, not the full band", () => {
  test("hit height << layer height after a frame", () => {
    const { engine, hit } = make(400)
    pump(2)
    const hitH = parseInt(hit.style.height || "0", 10)
    expect(hitH).toBeGreaterThan(0)
    expect(hitH).toBeLessThan(engine.layerH) // not the full ~102px band
  })
})

describe("#2 reduced-motion keeps overlays + bubbles working", () => {
  test("hit is positioned and the bubble expires even with prefers-reduced-motion", () => {
    reduced = true
    const { engine, hit, bubble } = make(400)
    engine.trigger("send")
    expect(bubble.style.opacity).toBe("1")
    pump(1)                                   // one frame: tickOverlays must run under reduced motion
    expect(parseInt(hit.style.width || "0", 10)).toBeGreaterThan(0) // positionOverlays ran
    pump(1, 2000)                             // advance wall clock past the 0.9s bubble
    expect(bubble.style.opacity).toBe("0")    // bubble expired (was stuck before the fix)
  })
})

describe("#5 syncFromBackend — matches the real companion", () => {
  test("xp→level, legendary override, stat bumps, hatched name", () => {
    const { engine, last } = make(400, { species: "cat", rarity: "common" }, "alice")
    const baseStat = last().stats.DEBUGGING
    engine.syncFromBackend({ xp: 300, legendaryEarned: true, statBumps: { DEBUGGING: 20 }, name: "Sir Purr" })
    const i = last()
    expect(i.level).toBeGreaterThanOrEqual(5)          // 300 XP → several levels up
    expect(i.rarity).toBe("legendary")                 // legendary upgrade applied
    expect(i.stars).toBe("★★★★★")
    expect(i.stats.DEBUGGING).toBe(Math.min(100, baseStat + 20)) // stat bump applied (clamped)
    expect(i.soulName).toBe("Sir Purr")               // hatched name from backend
  })
  test("empty backend state is a safe no-op-ish call", () => {
    const { engine } = make()
    expect(() => engine.syncFromBackend({})).not.toThrow()
  })
})

describe("#8 setWorking — no mid-turn sleep", () => {
  test("stays awake while the agent works (past the 14s idle-sleep threshold), then sleeps once idle", () => {
    const { engine } = make(400)
    engine.setWorking(true)
    pump(2000, 16)                    // ~32s of frames — well past the 14s autonomous-sleep threshold
    expect(engine.sleepingNow).toBe(false) // never dozed while the agent was working
    engine.setWorking(false)
    pump(2000, 16)                    // agent stopped → autonomous sleep resumes after the idle window
    expect(engine.sleepingNow).toBe(true)
  })
  test("setWorking is idempotent (repeated true is a no-op, no throw)", () => {
    const { engine } = make(400)
    expect(() => { engine.setWorking(true); engine.setWorking(true); engine.setWorking(false) }).not.toThrow()
  })
})

describe("hover wakes the pet + keeps it awake", () => {
  test("a sleeping pet wakes the instant the pointer hovers it", () => {
    const { engine } = make(400)
    engine.trigger("sleep"); pump(200)          // walk to corner, then sleep
    expect(engine.sleepingNow).toBe(true)
    engine.setHovered(true)                      // pointer lands on the pet
    expect(engine.sleepingNow).toBe(false)       // wakes immediately, no waiting
  })
  test("stays awake while hovered, past the 14s idle-sleep threshold", () => {
    const { engine } = make(400)
    engine.setHovered(true)
    pump(2000, 16)                               // ~32s of frames — well past the 14s nap threshold
    expect(engine.sleepingNow).toBe(false)       // never naps under the cursor
    engine.setHovered(false)                     // pointer leaves
    pump(2000, 16)                               // autonomous sleep resumes after the idle window
    expect(engine.sleepingNow).toBe(true)
  })
  test("setHovered is idempotent (repeated true is a no-op, no throw)", () => {
    const { engine } = make(400)
    expect(() => { engine.setHovered(true); engine.setHovered(true); engine.setHovered(false) }).not.toThrow()
  })
})

describe("cleanup", () => {
  test("destroy() stops the loop (no further frames/info)", () => {
    const { engine, infos } = make()
    pump(3)
    const n = infos.length
    engine.destroy()
    pump(5) // rafCb was cancelled → nothing runs
    expect(infos.length).toBe(n)
  })
})
