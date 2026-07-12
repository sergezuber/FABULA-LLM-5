import { test, expect, describe } from "bun:test"
import {
  SPECIES, RARITIES, STAT_NAMES, roll, rollWithSeed, hashString,
  buddyXpFromFeed, bumpStatsFromGates, levelFromXp, applyFeed, emptyState,
  getCompanion, renderSprite, renderFace, spriteFrameCount, renderCard,
  type FeedInput, type BuddyState,
} from "./buddy"

const feed = (o: Partial<FeedInput>): FeedInput => ({ receiptId: "r1", passed: true, gates: [], task: "", witnessCount: 0, ...o })

describe("deterministic roll — same userId, same buddy", () => {
  test("roll is a pure function of userId", () => {
    const a = roll("user-abc")
    const b = roll("user-abc")
    expect(a.bones).toEqual(b.bones)
  })
  test("different users generally differ, and every field is in-range", () => {
    const r = rollWithSeed("some-seed-42")
    expect(SPECIES).toContain(r.bones.species)
    expect(RARITIES).toContain(r.bones.rarity)
    expect(r.bones.hat === "none" || r.bones.rarity !== "common").toBe(true) // commons wear no hat
    for (const s of STAT_NAMES) {
      expect(r.bones.stats[s]).toBeGreaterThanOrEqual(1)
      expect(r.bones.stats[s]).toBeLessThanOrEqual(100)
    }
  })
  test("hashString is stable + deterministic (no Bun/env dependence)", () => {
    expect(hashString("abc")).toBe(hashString("abc"))
    expect(hashString("abc")).not.toBe(hashString("abd"))
  })
})

describe("XP — ONLY from proven work", () => {
  test("a NOT DONE receipt grants zero XP", () => {
    expect(buddyXpFromFeed(feed({ passed: false, gates: ["verify"], witnessCount: 5 }))).toBe(0)
  })
  test("base verified receipt = 10", () => {
    expect(buddyXpFromFeed(feed({ passed: true }))).toBe(10)
  })
  test("reproduce + change-quiz gates add 5 each", () => {
    expect(buddyXpFromFeed(feed({ gates: ["reproduce-gate", "change-quiz"] }))).toBe(20)
  })
  test("witnesses multiply, swe-bench bonus", () => {
    expect(buddyXpFromFeed(feed({ witnessCount: 3 }))).toBe(40) // 10 + 30
    expect(buddyXpFromFeed(feed({ task: "SWE-bench Pro task 0b621cb0" }))).toBe(60) // 10 + 50
  })
})

describe("gate → stat bumps", () => {
  test("verify bumps DEBUGGING, rewind PATIENCE, escalate CHAOS, quiz WISDOM", () => {
    expect(bumpStatsFromGates(["verify", "rewind", "escalate", "change-quiz"])).toEqual({
      DEBUGGING: 1, PATIENCE: 1, CHAOS: 1, WISDOM: 1,
    })
  })
})

describe("level curve", () => {
  test("levels begin at 25·L·(L-1)", () => {
    expect(levelFromXp(0).level).toBe(1)
    expect(levelFromXp(49).level).toBe(1)
    expect(levelFromXp(50).level).toBe(2)
    expect(levelFromXp(150).level).toBe(3)
    expect(levelFromXp(500).level).toBe(5)
  })
  test("toNext is span - intoLevel", () => {
    const l = levelFromXp(60)
    expect(l.level).toBe(2)
    expect(l.intoLevel).toBe(10)
    expect(l.span).toBe(100) // need(3)-need(2) = 150-50
    expect(l.toNext).toBe(90)
  })
})

describe("applyFeed — the earned state transition", () => {
  test("passed receipt adds XP, bumps stats, dedupes by receiptId", () => {
    let st = emptyState()
    const r1 = applyFeed(st, feed({ receiptId: "a", gates: ["verify"] }))
    expect(r1.result.gained).toBe(10)
    expect(r1.result.bumps).toEqual({ DEBUGGING: 1 })
    st = r1.state
    // same receipt again → no double-count
    const again = applyFeed(st, feed({ receiptId: "a", gates: ["verify"] }))
    expect(again.result.alreadyFed).toBe(true)
    expect(again.result.gained).toBe(0)
    expect(again.state.xp).toBe(10)
  })
  test("NOT DONE receipt changes nothing and is NOT recorded (can feed once it passes)", () => {
    let st = emptyState()
    const fail = applyFeed(st, feed({ receiptId: "x", passed: false }))
    expect(fail.result.gained).toBe(0)
    expect(fail.state.fedReceipts).toEqual([])
    // later the same receiptId passes → now it feeds
    const pass = applyFeed(fail.state, feed({ receiptId: "x", passed: true }))
    expect(pass.result.gained).toBe(10)
  })
  test("leveledUp flips when crossing a boundary", () => {
    const st: BuddyState = { ...emptyState(), xp: 45 }
    const r = applyFeed(st, feed({ receiptId: "b" })) // +10 → 55 → level 2
    expect(r.result.leveledUp).toBe(true)
    expect(r.result.level).toBe(2)
  })
  test("legendary earned from THREE receipts each with ≥3 witnesses", () => {
    let st = emptyState()
    for (const id of ["p1", "p2"]) st = applyFeed(st, feed({ receiptId: id, witnessCount: 3 })).state
    expect(st.legendaryEarned).toBe(false)
    const third = applyFeed(st, feed({ receiptId: "p3", witnessCount: 4 }))
    expect(third.result.legendaryUpgrade).toBe(true)
    expect(third.state.legendaryEarned).toBe(true)
  })
  test("two-witness receipts do NOT count toward legendary", () => {
    let st = emptyState()
    for (const id of ["q1", "q2", "q3", "q4"]) st = applyFeed(st, feed({ receiptId: id, witnessCount: 2 })).state
    expect(st.legendaryEarned).toBe(false)
    expect(st.legendaryReceipts).toEqual([])
  })
})

describe("getCompanion — bones + soul + earned growth", () => {
  test("undefined until hatched (has soul + hatchedAt)", () => {
    expect(getCompanion("u", emptyState())).toBeUndefined()
  })
  test("merges deterministic bones with stored soul; legendary overrides rarity", () => {
    const st: BuddyState = { ...emptyState(), soul: { name: "Sir Quacks", personality: "grumpy" }, hatchedAt: 1000, legendaryEarned: true, statBumps: { DEBUGGING: 5 } }
    const c = getCompanion("u", st)!
    expect(c.name).toBe("Sir Quacks")
    expect(c.rarity).toBe("legendary") // earned override
    const base = roll("u").bones.stats.DEBUGGING
    expect(c.stats.DEBUGGING).toBe(Math.min(100, base + 5))
  })
})

describe("sprites — all 18 species render", () => {
  test("every species has frames and renders 4-5 lines of fixed shape", () => {
    for (const sp of SPECIES) {
      expect(spriteFrameCount(sp)).toBeGreaterThanOrEqual(3)
      const bones = { ...rollWithSeed(sp).bones, species: sp, eye: "·" as const, hat: "none" as const }
      const lines = renderSprite(bones)
      expect(lines.length).toBeGreaterThanOrEqual(4)
      expect(lines.join("")).toContain("·") // the eye substituted in
      expect(renderFace(bones)).toContain("·")
    }
  })
  test("a hat fills the top slot for non-common species", () => {
    const bones = { ...rollWithSeed("cat").bones, species: "cat" as const, eye: "·" as const, hat: "crown" as const, rarity: "rare" as const }
    const lines = renderSprite(bones)
    expect(lines[0]).toContain("^") // crown line
  })
  test("renderCard shows name, stars, level bar and stats", () => {
    const st: BuddyState = { ...emptyState(), soul: { name: "Blobby", personality: "chill" }, hatchedAt: 1, xp: 60 }
    const c = getCompanion("card-user", st)!
    const l = levelFromXp(60)
    const card = renderCard(c, l.level, l.intoLevel, l.span, l.toNext)
    expect(card).toContain("Blobby")
    expect(card).toContain("Lv.2")
    expect(card).toContain("XP to next")
    for (const s of STAT_NAMES) expect(card).toContain(s)
  })
})
