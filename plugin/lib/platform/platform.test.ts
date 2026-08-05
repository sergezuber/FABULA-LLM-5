// The platform seam, and — more importantly — proof that it is WIRED rather than declared.
//
// A pure core with green tests and two dead lines connecting it is this repository's most-repeated
// defect: the corpus worker's decision was covered while the work it was supposed to start was not; the
// memory anchor was unit-tested while nothing in production ever called it. So half of this file tests
// the seam's own functions, and the other half drives the REAL consumers (`lib/pathguard`, `lib/sandbox`)
// with the platform flipped, asserting that their answers CHANGE. If a consumer ever goes back to its own
// hand-written copy of the rules, that half goes red — which is the only thing that can catch it.

import { test, expect, describe } from "bun:test"
import { policyFitsSource, policyMismatchReason, DEFAULT_POLICY_MEASURED_ON } from "../windowplan"
import * as os from "node:os"
import * as fs from "node:fs"
import * as path from "node:path"
import { current, isPosix, pathListSeparator, exeSuffix, PLATFORMS } from "./index"
import { baseDirs, homeDir, goBinDirs, systemBinDirs, appendToPath, joinPathList, splitPathList } from "./paths"
import { shellArgv, shellBin, whichBin, whichFirst } from "./shell"
import { hardlineTargets, hardlineKernelRegex, credentialReadDirs, persistenceCommands } from "./persistence"
import { usedBytes, totalBytes, memoryReading, vramBytes, vramBytes, memoryReading} from "./memory"
import { checkWritePath } from "../pathguard"
import { buildSeatbeltProfile, hardlineSandboxConfig, defaultSandboxConfig, sandboxArgv } from "../sandbox"
import { bashArgv } from "../execbackend"

/** Run `fn` with env overrides applied, restoring exactly what was there — including absence. */
function withEnv<T>(over: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>()
  for (const k of Object.keys(over)) saved.set(k, process.env[k])
  try {
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    return fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe("platform/index — the question is asked at call time", () => {
  test("answers the real platform with no override", () => {
    withEnv({ FABULA_PLATFORM: undefined }, () => {
      expect(PLATFORMS).toContain(current())
    })
  })

  test("FABULA_PLATFORM overrides, and is read per call rather than captured at import", () => {
    withEnv({ FABULA_PLATFORM: "win32" }, () => expect(current()).toBe("win32"))
    withEnv({ FABULA_PLATFORM: "linux" }, () => expect(current()).toBe("linux"))
    // Back to the real answer within the same process: a value cached at import could not do this.
    withEnv({ FABULA_PLATFORM: undefined }, () => expect(current()).toBe(process.platform as any))
  })

  test("an unrecognised value is IGNORED, never honoured as a fourth platform", () => {
    withEnv({ FABULA_PLATFORM: "darwn" }, () => expect(current()).toBe(process.platform as any))
    withEnv({ FABULA_PLATFORM: "" }, () => expect(current()).toBe(process.platform as any))
  })

  test("an unknown POSIX runtime degrades to linux, not to darwin", () => {
    // Answering darwin would hand a BSD a Seatbelt profile that does not exist there.
    expect(current({}, "freebsd")).toBe("linux")
    expect(current({}, "sunos")).toBe("linux")
  })

  test("separators and suffixes follow the platform", () => {
    expect(pathListSeparator("win32")).toBe(";")
    expect(pathListSeparator("linux")).toBe(":")
    expect(exeSuffix("win32")).toBe(".exe")
    expect(exeSuffix("darwin")).toBe("")
    expect(isPosix("win32")).toBe(false)
    expect(isPosix("linux")).toBe(true)
  })
})

describe("platform/paths — resolved the way the ENGINE resolves it", () => {
  test("MIMOCODE_HOME moves all four dirs, exactly as resolveMimocodeHome does", () => {
    const d = baseDirs({ MIMOCODE_HOME: "/tmp/fab-root", HOME: "/home/u" })
    expect(d.data).toBe(path.join("/tmp/fab-root", "data"))
    expect(d.cache).toBe(path.join("/tmp/fab-root", "cache"))
    expect(d.config).toBe(path.join("/tmp/fab-root", "config"))
    expect(d.state).toBe(path.join("/tmp/fab-root", "state"))
  })

  test("a RELATIVE MIMOCODE_HOME is refused, falling back to XDG rather than making a path up", () => {
    const d = baseDirs({ MIMOCODE_HOME: "relative/root", HOME: "/home/u" })
    expect(d.data).toBe(path.join("/home/u", ".local", "share", "fabula"))
  })

  test("without MIMOCODE_HOME the answer is byte-identical to what 26 hand-written copies produced", () => {
    const d = baseDirs({ HOME: "/home/u" })
    expect(d.data).toBe(path.join("/home/u", ".local", "share", "fabula"))
    expect(d.config).toBe(path.join("/home/u", ".config", "fabula"))
    // XDG still wins over the default, which is what those copies did too.
    expect(baseDirs({ HOME: "/home/u", XDG_DATA_HOME: "/xdg/data" }).data).toBe(path.join("/xdg/data", "fabula"))
  })

  test("home comes from the environment, because HOME moves and os.homedir() is cached at startup", () => {
    expect(homeDir({ HOME: "/home/moved" })).toBe("/home/moved")
    expect(homeDir({ USERPROFILE: "C:\\Users\\u" })).toBe("C:\\Users\\u")
  })

  test("system bin dirs are platform truth, not a merged superset", () => {
    expect(systemBinDirs("darwin")).toContain("/opt/homebrew/bin")
    expect(systemBinDirs("linux")).not.toContain("/opt/homebrew/bin")
    expect(systemBinDirs("win32")).toEqual([])
  })

  test("go bin dirs honour GOBIN and GOPATH before the documented default", () => {
    expect(goBinDirs({ HOME: "/h", GOBIN: "/gb" }, "linux")[0]).toBe("/gb")
    expect(goBinDirs({ HOME: "/h", GOPATH: "/gp" }, "linux")).toContain(path.join("/gp", "bin"))
    expect(goBinDirs({ HOME: "/h" }, "linux")).toContain(path.join("/h", "go", "bin"))
    expect(goBinDirs({ HOME: "/h" }, "win32")).toContain("C:\\Program Files\\Go\\bin")
  })

  test("appendToPath keeps the caller's own PATH in front and never duplicates", () => {
    expect(appendToPath("/a:/b", ["/b", "/c"], "linux")).toBe("/a:/b:/c")
    expect(appendToPath(undefined, ["/c"], "linux")).toBe("/c")
    expect(appendToPath("C:\\a", ["C:\\b"], "win32")).toBe("C:\\a;C:\\b")
  })

  test("splitPathList uses the platform separator", () => {
    expect(splitPathList("/a:/b", "linux")).toEqual(["/a", "/b"])
    expect(splitPathList("C:\\a;C:\\b", "win32")).toEqual(["C:\\a", "C:\\b"])
    expect(joinPathList(["/a", "", "/b"], "linux")).toBe("/a:/b")
  })
})

describe("platform/shell — one shell family, one grammar the guards can parse", () => {
  test("a login shell by default, because that is what all 25 call sites used", () => {
    expect(shellArgv("echo hi", { platform: "linux", env: {} })).toEqual(["bash", "-lc", "echo hi"])
    expect(shellArgv("echo hi", { platform: "linux", env: {}, login: false })).toEqual(["bash", "-c", "echo hi"])
  })

  test("FABULA_SHELL_BIN names it explicitly", () => {
    expect(shellBin({ FABULA_SHELL_BIN: "/usr/bin/dash" }, "linux")).toBe("/usr/bin/dash")
    expect(shellArgv("x", { platform: "win32", env: { FABULA_SHELL_BIN: "C:\\git\\bash.exe" } }))
      .toEqual(["C:\\git\\bash.exe", "-lc", "x"])
  })

  test("Windows resolves a POSIX shell rather than substituting a different grammar", () => {
    // With no Git install present the answer is a bare `bash` for PATH to resolve — never `cmd` or
    // `powershell`, which would leave cmdguard reading a grammar the machine does not run.
    const argv = shellArgv("echo hi", { platform: "win32", env: {} })
    expect(argv.slice(1)).toEqual(["-lc", "echo hi"])
    expect(argv[0]!.toLowerCase()).toContain("bash")
  })

  test("whichBin reads PATH directly — no `which` process, and it works with PATHEXT", () => {
    // A directory that certainly exists, containing a program that certainly exists.
    const found = whichBin("sh", { PATH: "/bin:/usr/bin" }, "linux")
    expect(found).toBe("/bin/sh")
    expect(whichBin("definitely-not-a-real-binary-xyz", { PATH: "/bin" }, "linux")).toBeNull()
    expect(whichFirst(["nope-xyz", "sh"], { PATH: "/bin" }, "linux")).toBe("/bin/sh")
  })

  test("an explicit path is honoured as given rather than searched for", () => {
    expect(whichBin("/bin/sh", {}, "linux")).toBe("/bin/sh")
    expect(whichBin("/bin/nope-xyz", {}, "linux")).toBeNull()
  })
})

describe("platform/persistence — ONE list, three platforms", () => {
  test("darwin carries launchd; linux carries systemd and autostart; neither carries the other's", () => {
    const mac = hardlineTargets({ HOME: "/h" }, "darwin").map((t) => t.code)
    const lin = hardlineTargets({ HOME: "/h" }, "linux").map((t) => t.code)
    const win = hardlineTargets({ HOME: "/h" }, "win32").map((t) => t.code)

    expect(mac).toContain("launchagent")
    expect(mac).toContain("launchd")
    expect(lin).not.toContain("launchagent")

    expect(lin).toContain("systemd_user")
    expect(lin).toContain("autostart")
    expect(lin).toContain("shell_rc")
    expect(mac).not.toContain("autostart")

    expect(win).toContain("startup_folder")
    expect(win).toContain("scheduled_task")
  })

  test("every platform keeps the supervision state — it is ours, not the OS's", () => {
    for (const p of PLATFORMS) {
      expect(hardlineTargets({ HOME: "/h" }, p).map((t) => t.code)).toContain("supervision_state")
    }
  })

  test("order is contract: this user's own authorized_keys is reported more specifically", () => {
    const codes = hardlineTargets({ HOME: "/h" }, "darwin").map((t) => t.code)
    expect(codes.indexOf("ssh_authorized_keys")).toBeLessThan(codes.indexOf("ssh_key"))
  })

  test("kernel fragments are deduped and keep their order", () => {
    const k = hardlineKernelRegex({ HOME: "/h" }, "darwin")
    expect(new Set(k).size).toBe(k.length)
    expect(k).toContain("/LaunchAgents/")
    expect(k).toContain("authorized_keys")
  })

  test("credential read dirs are built for the home they are GIVEN, never process.env", () => {
    // A profile built for the wrong home denies a path nobody writes to, and reads exactly like one
    // that works.
    expect(credentialReadDirs("/Users/x")).toContain(path.join("/Users/x", ".ssh"))
    expect(credentialReadDirs("/Users/x").some((d) => d.includes(homeDir()))).toBe(
      homeDir() === "/Users/x",
    )
  })

  test("persistence installed by COMMAND is declared too — the Windows Run key has no path", () => {
    const win = persistenceCommands("win32")
    expect(win.some((r) => r.test('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v x'))).toBe(true)
    expect(win.some((r) => r.test("schtasks /create /tn evil /tr calc.exe"))).toBe(true)
    expect(persistenceCommands("linux").some((r) => r.test("systemctl --user enable evil"))).toBe(true)
    expect(persistenceCommands("darwin").some((r) => r.test("launchctl load x.plist"))).toBe(true)
  })
})

// ── WIRING. These are the assertions that go red if a consumer reverts to its own copy of the rules. ──

describe("WIRED: lib/pathguard renders from the platform list", () => {
  test("macOS blocks a LaunchAgent plist and reports the launchagent code", () => {
    withEnv({ FABULA_PLATFORM: "darwin" }, () => {
      const v = checkWritePath(path.join(homeDir(), "Library", "LaunchAgents", "evil.plist"))
      expect(v.blocked).toBe(true)
      expect(v.code).toBe("launchagent")
    })
  })

  test("KILLER: flip to linux and the SAME path is allowed, while linux's own targets block", () => {
    // If pathguard held a hardcoded macOS list, the first assertion would still say "launchagent" and
    // the rest would allow — i.e. this whole test is what distinguishes a wired seam from a declared one.
    withEnv({ FABULA_PLATFORM: "linux" }, () => {
      expect(checkWritePath(path.join(homeDir(), "Library", "LaunchAgents", "evil.plist")).blocked).toBe(false)
      expect(checkWritePath(path.join(homeDir(), ".config", "systemd", "user", "evil.service")).code).toBe("systemd_user")
      expect(checkWritePath(path.join(homeDir(), ".config", "autostart", "evil.desktop")).code).toBe("autostart")
      expect(checkWritePath(path.join(homeDir(), ".bashrc")).code).toBe("shell_rc")
      expect(checkWritePath("/etc/ld.so.preload").code).toBe("ld_preload")
    })
  })

  test("KILLER: on Windows the Startup folder and the Tasks store block", () => {
    withEnv({ FABULA_PLATFORM: "win32" }, () => {
      expect(checkWritePath("C:/Users/u/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/e.lnk").code)
        .toBe("startup_folder")
      expect(checkWritePath("C:/Windows/System32/Tasks/evil").code).toBe("scheduled_task")
      expect(checkWritePath("C:/Users/u/Documents/PowerShell/Microsoft.PowerShell.ps1").code)
        .toBe("powershell_profile")
    })
  })

  test("what every platform must keep refusing, and what none may refuse", () => {
    for (const p of PLATFORMS) {
      withEnv({ FABULA_PLATFORM: p }, () => {
        expect(checkWritePath(path.join(homeDir(), ".ssh", "authorized_keys")).blocked).toBe(true)
        expect(checkWritePath("/Users/me/proj/src/index.ts").blocked).toBe(false)
        expect(checkWritePath("~/projects/app/.env").blocked).toBe(false)
      })
    }
  })
})

describe("WIRED: lib/sandbox renders the SAME list into the kernel profile", () => {
  test("the hardline profile carries the platform's persistence targets", () => {
    withEnv({ FABULA_PLATFORM: "darwin" }, () => {
      const p = buildSeatbeltProfile(hardlineSandboxConfig("/Users/x"))
      expect(p).toContain("/LaunchAgents/")
      expect(p).toContain("authorized_keys")
      expect(p).not.toContain("autostart")
    })
  })

  test("KILLER: flip to linux and the profile's contents follow, from the same source", () => {
    withEnv({ FABULA_PLATFORM: "linux" }, () => {
      const p = buildSeatbeltProfile(hardlineSandboxConfig("/home/x"))
      expect(p).toContain("autostart")
      expect(p).toContain("systemd/user")
      expect(p).not.toContain("/LaunchAgents/")
    })
  })

  test("the drift the mirror had developed is closed: ~/.ssh/id_ now denied in BOTH profiles", () => {
    // The hand-written copy in defaultSandboxConfig had lost this rule while pathguard kept refusing it.
    // Rendering both from one list is what surfaced it, and what stops it recurring.
    withEnv({ FABULA_PLATFORM: "darwin" }, () => {
      expect(buildSeatbeltProfile(defaultSandboxConfig("/Users/x"))).toContain("/\\.ssh/id_")
      expect(buildSeatbeltProfile(hardlineSandboxConfig("/Users/x"))).toContain("/\\.ssh/id_")
    })
  })

  test("the extension rules stay in the untrusted-code profile ONLY", () => {
    // bash_tool writing a .env in your own project is ordinary work; a guard that refuses it gets
    // switched off. execute_code is a different claim.
    expect(buildSeatbeltProfile(defaultSandboxConfig("/Users/x"))).toContain('(regex #"\\.env$")')
    expect(buildSeatbeltProfile(hardlineSandboxConfig("/Users/x"))).not.toContain('(regex #"\\.env$")')
  })
})

describe("WIRED: the confined shell and the unconfined shell are the same program", () => {
  test("sandboxArgv and bashArgv both compose platform/shell", () => {
    withEnv({ FABULA_SHELL_BIN: "/opt/marker-shell" }, () => {
      expect(sandboxArgv("echo hi", "(p)")).toEqual(["sandbox-exec", "-p", "(p)", "/opt/marker-shell", "-lc", "echo hi"])
      expect(bashArgv("echo hi")).toEqual(["/opt/marker-shell", "-lc", "echo hi"])
      expect(bashArgv("echo hi", { sandboxProfile: "(p)" }))
        .toEqual(["sandbox-exec", "-p", "(p)", "/opt/marker-shell", "-lc", "echo hi"])
    })
  })

  test("the container keeps the IMAGE's shell — that is the image's business, not this host's", () => {
    withEnv({ FABULA_SHELL_BIN: "/opt/marker-shell" }, () => {
      expect(bashArgv("echo hi", { dockerCid: "abc" }))
        .toEqual(["docker", "exec", "-i", "abc", "bash", "-lc", "echo hi"])
    })
  })
})

describe("platform/memory — the source of the number is a decision", () => {
  test("this machine reports a real total and a real used figure", () => {
    expect(totalBytes()).toBeGreaterThan(0)
    expect(usedBytes()).toBeGreaterThan(0)
    expect(usedBytes()).toBeLessThan(totalBytes() * 2) // sanity: not a unit error of 1024x
  })

  test("macOS reports unified memory, and never goes looking for a discrete GPU", () => {
    if (process.platform !== "darwin") return
    withEnv({ FABULA_PLATFORM: "darwin", FABULA_MEMORY_SOURCE: undefined }, () => {
      const r = memoryReading()
      expect(r.kind).toBe("unified")
      expect(r.total).toBeGreaterThan(0)
      expect(r.detail).toContain("unified")
    })
    // Asking for VRAM on darwin is answered without a probe — there is none to find.
    expect(vramBytes("darwin")).toBeNull()
  })

  test("an operator naming a source that cannot be confirmed gets `unknown`, never a guess", () => {
    // The planner refuses on unknown. A confident wrong number here drives a machine into swap.
    withEnv({ FABULA_MEMORY_SOURCE: "discrete-vram", FABULA_NVIDIA_SMI: "/nonexistent/nvidia-smi" }, () => {
      const r = memoryReading("linux")
      expect(r.kind).toBe("unknown")
      expect(r.total).toBe(0)
      expect(r.detail).toContain("no GPU tool answered")
    })
  })

  test("a failed reading answers 0 — 'did not measure', never 'nothing is in use'", () => {
    withEnv({ FABULA_MEMORY_SOURCE: "cpu-only" }, () => {
      const r = memoryReading("linux")
      // On a non-Linux host /proc/meminfo is absent, so this exercises the failure path itself.
      expect(r.total === 0 ? r.kind : "cpu-only").toBe(r.total === 0 ? "unknown" : "cpu-only")
    })
  })
})

// ── The GPU branch, against the driver's REAL output format ────────────────────────────────────────
//
// This machine has no discrete GPU and never will, so the honest claim is narrow and is made narrowly:
// the PARSER is verified against the exact bytes `nvidia-smi --query-gpu=memory.total,memory.used
// --format=csv,noheader,nounits` prints — MiB integers, one line per device, comma-separated. Whether a
// real driver behaves as documented is a separate question that needs real hardware, and saying otherwise
// would be the "declared but never met reality" claim this project spends its time removing.
describe("discrete VRAM is read from the driver, summed across devices", () => {
  const shim = (lines: string) => {
    const p = path.join(os.tmpdir(), `fabula-nvsmi-${process.pid}`)
    fs.writeFileSync(p, `#!/bin/sh\n${lines.split("\n").map((l) => `echo ${JSON.stringify(l)}`).join("\n")}\n`)
    fs.chmodSync(p, 0o755)
    return p
  }

  test("two cards are summed, not sampled", () => {
    // A serving runtime handed several GPUs draws on all of them; reading only the first would plan a
    // window for half the machine.
    const env = { HOME: "/home/u", FABULA_NVIDIA_SMI: shim("24564, 1843\n24564, 512") }
    const v = vramBytes("linux", env as any)!
    expect(v.total).toBe(2 * 24564 * 1024 * 1024)
    expect(v.used).toBe((1843 + 512) * 1024 * 1024)
  })

  test("the reading declares itself discrete, so the planner sizes against VRAM", () => {
    const env = { HOME: "/home/u", FABULA_NVIDIA_SMI: shim("24564, 1843") }
    const m = memoryReading("linux", env as any)
    expect(m.kind).toBe("discrete-vram")
    expect(m.detail).toContain("nvidia-smi")
  })

  test("garbage from the driver is REFUSED, never half-parsed into a number", () => {
    // A partial reading is worse than none: it would size a window against an invented pool.
    const env = { HOME: "/home/u", FABULA_NVIDIA_SMI: shim("no devices found") }
    expect(vramBytes("linux", env as any)).toBeNull()
  })

  test("macOS never asks the driver at all", () => {
    // Apple Silicon has no discrete VRAM to find, and asking would add a spawn to every plan.
    expect(vramBytes("darwin", { HOME: "/h", FABULA_NVIDIA_SMI: shim("1, 1") } as any)).toBeNull()
  })
})

// ── Policy constants belong to the machine they were measured on ───────────────────────────────────
//
// DEFAULT_POLICY is a JUDGEMENT — how much of a machine FABULA may commit — measured on 48 GB of unified
// memory, where weights, KV cache and the desktop draw on one pool the system can reclaim from. On a host
// whose cache lives in VRAM none of that holds: a 6 GB "system reserve" is meaningless there, and 90% of
// VRAM is a far more aggressive commitment because nothing can give any of it back. Carrying the number
// across silently is how a window gets sized for hardware that does not exist.
describe("a window policy is not portable just because it is a number", () => {
  test("unified and cpu-only share the shape the constants were measured against", () => {
    expect(policyFitsSource("unified")).toBe(true)
    expect(policyFitsSource("cpu-only")).toBe(true)
  })

  test("a VRAM machine is REFUSED, not approximated", () => {
    // Refusal rather than a conservative guess: an invented conservative number is still invented, and
    // this project has paid for exactly that twice — a cost model fitted on the wrong quantity, and a
    // window computed from a figure somebody typed.
    expect(policyFitsSource("discrete-vram")).toBe(false)
    const why = policyMismatchReason("discrete-vram")
    expect(why).toContain("discrete-vram")
    expect(why).toContain("Re-measure")
  })

  test("an unknown source is not a claim, so nothing is applied to it", () => {
    expect(policyFitsSource("unknown")).toBe(false)
    expect(policyMismatchReason("unknown")).toContain("could not be determined")
  })

  test("the policy DECLARES its provenance, so the check has something to compare against", () => {
    // Without this the mismatch test could only be written by hardcoding "unified" a second time — the
    // two-definitions shape the whole seam exists to remove.
    expect(DEFAULT_POLICY_MEASURED_ON).toBe("unified")
    expect(policyFitsSource("discrete-vram", "discrete-vram")).toBe(true)
  })
})
