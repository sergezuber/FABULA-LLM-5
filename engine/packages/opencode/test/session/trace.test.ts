// The flight recorder's toggle and sink. Pinned because the whole point is trust: when future-you flips
// the marker mid-task, tracing MUST start on the live process, and when it is off it must cost nothing
// and write nothing.
import { describe, test, expect, afterEach } from "bun:test"
import { traceDecision, trace, traceEnabled, _traceResetCache, traceFilePath, traceMarkerPath } from "../../src/session/trace"
import { existsSync, rmSync, readFileSync, writeFileSync } from "node:fs"

const SAVED = process.env.FABULA_TRACE
afterEach(() => {
  if (SAVED === undefined) delete process.env.FABULA_TRACE
  else process.env.FABULA_TRACE = SAVED
  try { rmSync(traceMarkerPath()) } catch {}
  _traceResetCache()
})

describe("traceDecision (pure precedence)", () => {
  test("env=1 wins over a missing marker; env=0 wins over a present marker", () => {
    expect(traceDecision("1", false)).toBe(true)
    expect(traceDecision("0", true)).toBe(false)
  })
  test("no env → the marker decides", () => {
    expect(traceDecision(undefined, true)).toBe(true)
    expect(traceDecision(undefined, false)).toBe(false)
    expect(traceDecision("", true)).toBe(true) // empty env is not a decision
  })
})

describe("live toggle + sink", () => {
  test("marker file flips tracing on a LIVE process (no restart)", () => {
    delete process.env.FABULA_TRACE
    _traceResetCache()
    expect(traceEnabled()).toBe(false)
    writeFileSync(traceMarkerPath(), "")
    _traceResetCache()
    expect(traceEnabled()).toBe(true)
  })

  test("when ON, trace() appends one JSONL line with ts+event+data", () => {
    process.env.FABULA_TRACE = "1"
    _traceResetCache()
    try { rmSync(traceFilePath()) } catch {}
    trace("test.event", { sid: "s1", n: 7 })
    const lines = readFileSync(traceFilePath(), "utf8").trim().split("\n")
    const last = JSON.parse(lines[lines.length - 1])
    expect(last.event).toBe("test.event")
    expect(last.sid).toBe("s1")
    expect(last.n).toBe(7)
    expect(typeof last.ts).toBe("string")
  })

  test("when OFF, trace() writes NOTHING — the user-invisible guarantee", () => {
    process.env.FABULA_TRACE = "0"
    _traceResetCache()
    try { rmSync(traceFilePath()) } catch {}
    trace("must.not.appear", { sid: "s2" })
    expect(existsSync(traceFilePath())).toBe(false)
  })

  test("trace() never throws, whatever the data", () => {
    process.env.FABULA_TRACE = "1"
    _traceResetCache()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => trace("cyclic", cyclic)).not.toThrow()
  })
})
