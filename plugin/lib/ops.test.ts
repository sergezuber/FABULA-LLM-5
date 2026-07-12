import { test, expect } from "bun:test"
import { buildNtfy } from "./notify"
import { sanitizeJobId, parseTime, shQuote, buildPlist, buildJobCommand, LABEL_PREFIX } from "./schedule"

// ── 5.3 notify ──
test("buildNtfy: topic→url + headers; no topic→null", () => {
  const r = buildNtfy({ topic: "my-topic", title: "Done", message: "hi", priority: "high", tags: "tada" })!
  expect(r.url).toBe("https://ntfy.sh/my-topic")
  expect(r.headers.Title).toBe("Done")
  expect(r.headers.Priority).toBe("high")
  expect(r.headers.Tags).toBe("tada")
  expect(r.body).toBe("hi")
  expect(buildNtfy({ message: "x" })).toBe(null)
})
test("buildNtfy: custom server + header CRLF-injection stripped", () => {
  const r = buildNtfy({ topic: "t", server: "https://ntfy.example.com/", message: "m", title: "a\r\nX-Evil: 1" })!
  expect(r.url).toBe("https://ntfy.example.com/t")
  expect(r.headers.Title).not.toContain("\n")
  expect(r.headers.Title).not.toContain("\r")
})

// ── 5.4 schedule ──
test("sanitizeJobId + parseTime", () => {
  expect(sanitizeJobId("My Daily Job")).toBe("my-daily-job")
  expect(sanitizeJobId("../evil")).toBe("evil")          // slashes collapse to a safe slug
  expect(parseTime("09:30")).toEqual({ hour: 9, minute: 30 })
  expect(parseTime("23:59")).toEqual({ hour: 23, minute: 59 })
  expect(parseTime("24:00")).toBe(null)
  expect(parseTime("9:5")).toBe(null)
})
test("shQuote escapes single quotes", () => {
  expect(shQuote("it's")).toBe("'it'\\''s'")
})
test("buildPlist contains label, schedule, command", () => {
  const p = buildPlist({ label: "com.fabula.schedule.x", command: "echo hi", hour: 8, minute: 15, logPath: "/tmp/x.log" })
  expect(p).toContain("<string>com.fabula.schedule.x</string>")
  expect(p).toContain("<key>Hour</key><integer>8</integer>")
  expect(p).toContain("<key>Minute</key><integer>15</integer>")
  expect(p).toContain("echo hi")
  expect(p).toContain("/bin/bash")
})
test("buildJobCommand: sources env, runs the engine, one-shot self-removes", () => {
  const c = buildJobCommand({ workspace: "/w", dotenv: "/w/.env", engine: "/bin/fabula", model: "m", prompt: "do x", oneShot: true, plistPath: "/p.plist", label: "L" })
  expect(c).toContain("cd '/w'")
  expect(c).toContain(". '/w/.env'")
  expect(c).toContain("/bin/fabula' run -m 'm' 'do x'")
  expect(c).toContain("launchctl unload '/p.plist'")
  expect(c).toContain("rm -f '/p.plist'")
})
test("buildJobCommand: no one-shot → no self-remove", () => {
  const c = buildJobCommand({ workspace: "/w", dotenv: "/w/.env", engine: "/bin/fabula", prompt: "p" })
  expect(c).not.toContain("launchctl unload")
  expect(LABEL_PREFIX).toBe("com.fabula.schedule.")
})
