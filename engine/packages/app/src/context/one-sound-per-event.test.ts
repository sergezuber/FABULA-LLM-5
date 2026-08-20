import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// ONE EVENT, ONE SOUND.
//
// The in-page sound and the desktop notification fire for the SAME event, and the notification carries a
// sound of its own — so with the window in the background the reader heard both: a click on top of a
// chime (reported 2026-08-20). Neither layer could see the other, so each played unconditionally.
//
// `platform.notify` now reports whether it actually sounded, and the in-page sound is played only when it
// did not — window in view, notifications off, or permission denied. These read the source, because the
// defect is the ABSENCE of a check: a test of the sound helper alone stays green while both still play.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8")

describe("one event, one sound", () => {
  const notification = read("./notification.tsx")
  const layout = read("../pages/layout.tsx")

  test("every in-page sound is gated on the notification not having sounded", () => {
    for (const src of [notification, layout]) {
      for (const call of src.split("playSoundById(").slice(1)) {
        // the guard sits immediately before the call on the same line
        const line = src.slice(0, src.indexOf(call)).split("\n").pop() ?? ""
        expect(line).toContain("!did")
      }
    }
  })

  test("the contract says notify reports whether it sounded", () => {
    expect(read("./platform.tsx")).toContain("Promise<boolean>")
  })

  test("the implementation answers on every path", () => {
    const entry = read("../entry.tsx")
    const notify = entry.slice(entry.indexOf('const notify: Platform["notify"]'), entry.indexOf("const openLink"))
    // in view, no Notification API, permission denied -> no sound was made
    expect((notify.match(/return false/g) ?? []).length).toBeGreaterThanOrEqual(4)
    // a posted banner (native bridge or web) is sounded by the system
    expect((notify.match(/return true/g) ?? []).length).toBe(2)
  })

  test("the same event is not notified twice", () => {
    // the completion path used to call notify once for the sound decision and again below it
    const idle = notification.slice(notification.indexOf("handleSessionIdle"), notification.indexOf("handleSessionError"))
    expect((idle.match(/platform\.notify\(/g) ?? []).length).toBe(1)
  })
})
