// Scheduling and the adapter service, on three platforms.
//
// The property these exist to protect is not "the plist is well-formed" — it is that a FILE IS NOT A
// SCHEDULE. MEASURED 2026-08-01: two `com.fabula.schedule.*` plists sat in `~/Library/LaunchAgents` that
// `launchctl list` had never heard of, and `list_scheduled` printed both as armed jobs, so a user asking
// what was scheduled was told two jobs would fire that could not. That claim now has to hold on all
// three platforms, which is why `parseKnownJobs` reads the SCHEDULER's own output everywhere.

import { test, expect, describe } from "bun:test"
import * as path from "node:path"
import {
  LABEL_PREFIX, jobLabel, jobDir, jobFile, planInstall, parseKnownJobs,
  selfRemoveCommand, buildPlist, buildSystemdUnits,
} from "./scheduler"
import { planServiceInstall, serviceFile, pythonCandidates, ADAPTER_LABEL } from "./service"
import { sanitizeJobId, parseTime, buildJobCommand } from "../schedule"

const ENV = { HOME: "/home/u" }
const SPEC = { id: "nightly", command: "echo hi", hour: 8, minute: 15, logPath: "/tmp/x.log" }

describe("job identity is the same on every platform", () => {
  test("the id survives all three naming schemes", () => {
    // Lowercase + digits + hyphens is the intersection of a launchd label, a systemd unit name and a
    // Task Scheduler task name — so one id names one job everywhere.
    expect(sanitizeJobId("Nightly Report!")).toBe("nightly-report")
    expect(sanitizeJobId("   ")).toBeNull()
    expect(jobLabel("nightly")).toBe("com.fabula.schedule.nightly")
    expect(LABEL_PREFIX).toBe("com.fabula.schedule.")
  })

  test("parseTime is unchanged and still refuses nonsense", () => {
    expect(parseTime("08:15")).toEqual({ hour: 8, minute: 15 })
    expect(parseTime("24:00")).toBeNull()
    expect(parseTime("8:1")).toBeNull()
  })
})

describe("each platform gets its own store — and Windows has none of ours", () => {
  test("definition files live where that scheduler expects them", () => {
    expect(jobDir("darwin", ENV)).toBe(path.join("/home/u", "Library", "LaunchAgents"))
    expect(jobDir("linux", ENV)).toBe(path.join("/home/u", ".config", "systemd", "user"))
    expect(jobDir("win32", ENV)).toBeNull()

    expect(jobFile("nightly", "darwin", ENV)).toEndWith("com.fabula.schedule.nightly.plist")
    expect(jobFile("nightly", "linux", ENV)).toEndWith("com.fabula.schedule.nightly.timer")
    expect(jobFile("nightly", "win32", ENV)).toBeNull()
  })
})

describe("planInstall — same three steps, three languages", () => {
  test("macOS: write a plist, unload, load", () => {
    const p = planInstall(SPEC, { shell: "/bin/bash", platform: "darwin", env: ENV })
    expect(p.fileBody).toContain("<key>Label</key><string>com.fabula.schedule.nightly</string>")
    expect(p.fileBody).toContain("<key>Hour</key><integer>8</integer>")
    expect(p.registerArgv[0]).toBe("launchctl")
    expect(p.unregisterArgv).toContain("unload")
  })

  test("Linux: a timer unit, enabled with systemctl --user", () => {
    const p = planInstall(SPEC, { shell: "/bin/bash", platform: "linux", env: ENV })
    expect(p.fileBody).toContain("OnCalendar=*-*-* 08:15:00")
    expect(p.registerArgv.join(" ")).toBe("systemctl --user enable --now com.fabula.schedule.nightly.timer")
  })

  test("Linux timers are Persistent — a sleeping laptop must not silently skip the day", () => {
    // launchd does this by default and systemd does not. A job skipped without a word is the exact
    // failure the run-ledger exists to make visible, so it must not be reintroduced by the port.
    expect(buildSystemdUnits({ ...SPEC, label: "l", shell: "/bin/bash" }).timer).toContain("Persistent=true")
  })

  test("Linux service unit quotes the command rather than splicing it", () => {
    // A command with spaces or quotes spliced raw into ExecStart is a unit that silently does something
    // else. JSON.stringify is systemd-compatible quoting and is not a guess.
    const u = buildSystemdUnits({ ...SPEC, command: 'echo "a b"', label: "l", shell: "/bin/bash" })
    expect(u.service).toContain('ExecStart=/bin/bash -lc "echo \\"a b\\""')
  })

  test("Windows: no file at all, the task IS the registration", () => {
    const p = planInstall(SPEC, { shell: "bash.exe", platform: "win32", env: ENV })
    expect(p.filePath).toBeNull()
    expect(p.fileBody).toBeNull()
    expect(p.registerArgv.join(" ")).toContain("/SC DAILY /ST 08:15")
    expect(p.registerArgv.join(" ")).toContain("com.fabula.schedule.nightly")
  })

  test("the plist names the shell it was GIVEN, not a literal /bin/bash", () => {
    const p = planInstall(SPEC, { shell: "/opt/marker-shell", platform: "darwin", env: ENV })
    expect(p.fileBody).toContain("<string>/opt/marker-shell</string>")
  })

  test("XML in a command cannot break out of the plist", () => {
    const p = planInstall({ ...SPEC, command: 'echo "<a & b>"' }, { shell: "/bin/bash", platform: "darwin", env: ENV })
    expect(p.fileBody).toContain("&lt;a &amp; b&gt;")
    expect(p.fileBody).not.toContain("<a & b>")
  })
})

describe("A FILE IS NOT A SCHEDULE — the scheduler is always asked", () => {
  test("every backend is asked what it actually knows", () => {
    expect(planInstall(SPEC, { shell: "s", platform: "darwin", env: ENV }).listArgv).toEqual(["launchctl", "list"])
    expect(planInstall(SPEC, { shell: "s", platform: "linux", env: ENV }).listArgv[0]).toBe("systemctl")
    expect(planInstall(SPEC, { shell: "s", platform: "win32", env: ENV }).listArgv[0]).toBe("schtasks")
  })

  test("our labels are read out of each scheduler's own output format", () => {
    expect(parseKnownJobs("-\t0\tcom.fabula.schedule.nightly\n123\t0\tcom.apple.other")).toEqual(["nightly"])
    expect(parseKnownJobs("com.fabula.schedule.weekly.timer  Mon 2026-08-10  n/a")).toEqual(["weekly"])
    expect(parseKnownJobs('"\\com.fabula.schedule.daily","2026-08-04 08:15:00","Ready"')).toEqual(["daily"])
  })

  test("an empty or unparseable listing claims NOTHING, rather than claiming none", () => {
    // The caller distinguishes "the scheduler says no jobs" from "the scheduler could not be asked";
    // this function only reports what it could read.
    expect(parseKnownJobs("")).toEqual([])
    expect(parseKnownJobs("total nonsense")).toEqual([])
  })

  test("a job is never counted twice however many times its label appears", () => {
    expect(parseKnownJobs("com.fabula.schedule.x\ncom.fabula.schedule.x\n")).toEqual(["x"])
  })
})

describe("a one-shot job removes ITSELF, in its own scheduler's language", () => {
  test("each platform's self-removal", () => {
    expect(selfRemoveCommand("com.fabula.schedule.x", "/p.plist", "darwin"))
      .toBe("launchctl unload '/p.plist' 2>/dev/null; rm -f '/p.plist'")
    expect(selfRemoveCommand("com.fabula.schedule.x", "/u/x.timer", "linux"))
      .toContain("systemctl --user disable --now 'com.fabula.schedule.x.timer'")
    expect(selfRemoveCommand("com.fabula.schedule.x", null, "win32"))
      .toBe("schtasks /Delete /TN 'com.fabula.schedule.x' /F >NUL 2>&1")
  })

  test("it removes the file it was INSTALLED from, not one it recomputed", () => {
    // A helper that derived the path would silently remove nothing whenever the caller had installed the
    // job anywhere else — a one-shot that quietly becomes a recurring job.
    expect(selfRemoveCommand("l", "/somewhere/else.plist", "darwin")).toContain("/somewhere/else.plist")
  })

  test("buildJobCommand still sources .env, runs the engine, and self-removes when one-shot", () => {
    const c = buildJobCommand({
      workspace: "/w", dotenv: "/w/.env", engine: "/bin/fabula", model: "m", prompt: "do x",
      oneShot: true, plistPath: "/p.plist", label: "L",
    })
    expect(c).toContain("cd '/w'")
    expect(c).toContain(". '/w/.env'")
    expect(c).toContain("'/bin/fabula' run -m 'm' 'do x'")
    expect(buildJobCommand({ workspace: "/w", dotenv: "/w/.env", engine: "/e", prompt: "p" }))
      .not.toContain("unload")
  })
})

describe("the adapter comes up with the session on every platform", () => {
  test("each platform's service definition", () => {
    const spec = { python: "/usr/bin/python3", script: "/r/proxy/lmstudio-adapter.py", logPath: "/l/a.log" }

    const mac = planServiceInstall(spec, "darwin", ENV)
    expect(mac.fileBody).toContain("<key>KeepAlive</key><true/>")
    expect(mac.registerArgv[0]).toBe("launchctl")

    const lin = planServiceInstall(spec, "linux", ENV)
    expect(lin.fileBody).toContain("Restart=always")
    expect(lin.fileBody).toContain("ExecStart=/usr/bin/python3 /r/proxy/lmstudio-adapter.py")
    expect(serviceFile("linux", ENV)).toEndWith(".config/systemd/user/fabula-adapter.service")

    const win = planServiceInstall(spec, "win32", ENV)
    expect(win.filePath).toBeNull()
    // ONLOGON, not boot: the adapter talks to a runtime the user starts in their own session.
    expect(win.registerArgv.join(" ")).toContain("/SC ONLOGON")
  })

  test("no unit tries to smuggle environment in — `.env` is the single honest place for knobs", () => {
    // A service manager passes NO environment, which once made every documented adapter knob silently a
    // code default and every kill-switch unreachable in production. The adapter loads `.env` itself; a
    // unit that ALSO set variables would create a second, invisible source of truth.
    const spec = { python: "/p", script: "/s", logPath: "/l" }
    for (const p of ["darwin", "linux"] as const) {
      const body = planServiceInstall(spec, p, ENV).fileBody!
      expect(body).not.toContain("FABULA_")
      expect(body.toLowerCase()).not.toContain("environmentvariables")
      expect(body).not.toContain("Environment=")
    }
  })

  test("every platform offers a next step when registration fails", () => {
    for (const p of ["darwin", "linux", "win32"] as const) {
      const plan = planServiceInstall({ python: "/p", script: "/s", logPath: "/l" }, p, ENV)
      expect(plan.hint.length).toBeGreaterThan(20)
      expect(plan.statusArgv.length).toBeGreaterThan(1)
    }
    expect(ADAPTER_LABEL).toBe("com.fabula.lmstudio-adapter")
    expect(pythonCandidates("win32")[0]).toContain("python")
  })
})
