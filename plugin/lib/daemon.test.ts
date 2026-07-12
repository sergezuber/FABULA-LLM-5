import { test, expect, describe } from "bun:test"
import {
  CACHE_WINDOW_MS,
  newDaemonState,
  sleepAdvice,
  focusPosture,
  KAIROS_BLOCK,
  daemonSystem,
  parsePrEvents,
  newEventsSince,
} from "./daemon"

describe("sleepAdvice — cache-aware pacing", () => {
  test("under the cache window → cheap-wake note", () => {
    const a = sleepAdvice(120000)
    expect(a.ms).toBe(120000)
    expect(a.note).toContain("warm prompt cache")
  })
  test("at/over the cache window → uncached-wake note", () => {
    expect(sleepAdvice(CACHE_WINDOW_MS).note).toContain("uncached")
    expect(sleepAdvice(1800000).note).toContain("uncached")
  })
  test("zero / garbage → 0ms with a warning", () => {
    expect(sleepAdvice(0).ms).toBe(0)
    expect(sleepAdvice("nope").ms).toBe(0)
    expect(sleepAdvice(undefined).ms).toBe(0)
    expect(sleepAdvice(0).note).toContain("0ms")
  })
  test("string number parsed", () => {
    expect(sleepAdvice("90000").ms).toBe(90000)
  })
})

describe("focusPosture", () => {
  test("focused → collaborate + ask", () => {
    const p = focusPosture("focused")
    expect(p).toContain("FOCUSED")
    expect(p).toContain("ASK before large")
  })
  test("unfocused → full autonomy", () => {
    expect(focusPosture("unfocused")).toContain("full autonomy")
  })
  test("unknown → empty (inject nothing)", () => {
    expect(focusPosture(undefined)).toBe("")
    expect(focusPosture("weird")).toBe("")
  })
})

describe("daemonSystem", () => {
  test("always carries the KAIROS block + the verified-in-the-dark line", () => {
    const s = daemonSystem("unfocused")
    expect(s).toContain("Autonomous work (FABULA daemon)")
    expect(s).toContain("mints a replayable Proof-of-Done receipt")
    expect(s).toContain("MUST call `sleep`")
  })
  test("appends focus posture only when known", () => {
    expect(daemonSystem("focused")).toContain("FOCUSED")
    expect(daemonSystem(undefined)).toBe(KAIROS_BLOCK)
  })
})

describe("PR event diffing", () => {
  const comments = [{ id: 1, user: { login: "alice" }, created_at: "2026-07-10T10:00:00Z", body: "please fix" }]
  const checks = [
    { id: 9, name: "ci", status: "completed", conclusion: "success", completed_at: "2026-07-10T10:05:00Z" },
    { id: 8, name: "lint", status: "in_progress", conclusion: null, completed_at: null },
  ]
  const events = parsePrEvents(comments, checks)

  test("normalizes comments and checks", () => {
    expect(events.find((e) => e.kind === "comment")?.who).toBe("alice")
    expect(events.find((e) => e.id.startsWith("check:9"))?.body).toContain("success")
  })
  test("a check status change is a NEW event (id folds status+conclusion)", () => {
    const before = parsePrEvents([], [{ id: 8, name: "lint", status: "in_progress", conclusion: null }])
    const after = parsePrEvents([], [{ id: 8, name: "lint", status: "completed", conclusion: "failure" }])
    const fresh = newEventsSince(after, before.map((e) => e.id))
    expect(fresh).toHaveLength(1)
    expect(fresh[0].body).toContain("failure")
  })
  test("newEventsSince filters already-seen", () => {
    const seen = events.map((e) => e.id)
    expect(newEventsSince(events, seen)).toHaveLength(0)
    expect(newEventsSince(events, [])).toHaveLength(events.length)
  })
})

describe("newDaemonState", () => {
  test("starts at tick 0, first tick pending", () => {
    expect(newDaemonState()).toEqual({ tick: 0, lastSleepMs: 0, firstTickDone: false })
  })
})
