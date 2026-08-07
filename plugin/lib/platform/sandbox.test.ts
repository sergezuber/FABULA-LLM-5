// The kernel floor, and the one platform where there isn't one.
//
// The property under test is NOT "the profile is well-formed". It is that a platform which cannot enforce
// the claim SAYS SO, and that the caller can tell "this is enforced" from "this ran unconfined" without
// reading the source. A sandbox that silently degrades is worse than no sandbox: the caller believes a
// claim nobody is keeping.

import { test, expect, describe } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { sandboxPlan, sandboxShellArgv, buildSeatbeltProfile, bubblewrapArgs, shellScope, untrustedScope } from "./sandbox"
import { hardlineKernelRegex } from "./persistence"
import { shellArgv } from "./shell"
import { resolveDep, MANIFEST } from "../manifest"

const ENV = { HOME: "/home/u", PATH: "/usr/bin:/bin" }
const SCOPE = { home: "/home/u", denyCredentialReads: true }

describe("what each platform can actually enforce", () => {
  test("macOS enforces with Seatbelt when sandbox-exec is there", () => {
    const plan = sandboxPlan(SCOPE, "darwin", ENV)
    // This machine has it; the assertion is about the SHAPE either way.
    if (plan.available) {
      expect(plan.mechanism).toBe("seatbelt")
      expect(plan.wrap(["echo", "hi"])[0]).toBe("sandbox-exec")
    } else {
      expect(plan.note).toContain("sandbox-exec")
    }
  })

  test("Linux without bubblewrap NAMES the missing package", () => {
    // A missing package is fixable and an unfixable platform is not — the reader has to be able to tell
    // which one they have, so the note says the package name and how to get it.
    const plan = sandboxPlan(SCOPE, "linux", { HOME: "/home/u", PATH: "/nonexistent" })
    expect(plan.available).toBe(false)
    expect(plan.note).toContain("bubblewrap")
    expect(plan.note).toContain("apt install")
  })

  test("Windows says there is nothing to install, and points somewhere real", () => {
    // Saying "not installed" would send someone looking for a package that does not exist. It names the
    // Docker backend instead, which IS the isolation Windows has.
    const plan = sandboxPlan(SCOPE, "win32", ENV)
    expect(plan.available).toBe(false)
    expect(plan.note).not.toContain("install")
    expect(plan.note).toContain("Docker")
  })

  test("an unavailable plan NEVER pretends: wrap is the identity", () => {
    // The whole failure mode this guards: an argv that LOOKS confined but is not. If nothing can be
    // enforced, the command must come back exactly as it went in, so the caller's own note is the only
    // thing claiming anything.
    for (const p of ["win32"] as const) {
      const plan = sandboxPlan(SCOPE, p, ENV)
      expect(plan.wrap(["python3", "-c", "print(1)"])).toEqual(["python3", "-c", "print(1)"])
    }
  })
})

describe("both platforms protect the SAME set, from the same list", () => {
  test("the Seatbelt profile is rendered from the hardline targets, not hand-written", () => {
    const profile = buildSeatbeltProfile(SCOPE, ENV)
    for (const frag of hardlineKernelRegex(ENV, "darwin")) {
      expect(profile).toContain(frag.replace(/\\\\/g, "\\"))
    }
    expect(profile).toContain("(allow default)")
    // The credential READ denial is scoped to the home it was GIVEN, not this process's home.
    expect(profile).toContain('(subpath "/home/u/.ssh")')
  })

  test("bubblewrap makes the Linux persistence targets unreachable", () => {
    const args = bubblewrapArgs(SCOPE, ENV)
    const joined = args.join(" ")
    expect(joined).toContain("--die-with-parent")
    expect(joined).toContain("/home/u/.config/systemd/user")
    expect(joined).toContain("/home/u/.config/autostart")
    // Credentials are shadowed rather than name-matched — there is no spelling to evade.
    expect(joined).toContain("--tmpfs /home/u/.ssh")
  })

  test("the main shell keeps its reads; only untrusted code loses them", () => {
    // A guard that refused the shell its own reads is a guard that gets switched off.
    expect(buildSeatbeltProfile({ home: "/home/u", denyCredentialReads: false }, ENV)).not.toContain("file-read*")
    expect(buildSeatbeltProfile({ home: "/home/u", denyCredentialReads: true }, ENV)).toContain("file-read*")
    expect(shellScope({ HOME: "/h" }).denyCredentialReads).toBe(false)
    expect(untrustedScope({ HOME: "/h" }).denyCredentialReads).toBe(true)
  })

  test("the confined shell is the SAME program as the unconfined one", () => {
    // If the sandbox picked a different shell, cmdguard and shelltargets would be parsing one grammar
    // while the kernel confined another. So the assertion is SAMENESS, stated against the unconfined
    // answer itself — spelling `bash` here asserted a POSIX fact instead, and on a machine where the
    // seam resolves a real Git-shipped shell the check failed for the two being identical.
    const { argv } = sandboxShellArgv("echo hi", SCOPE, "win32", ENV)
    expect(argv).toEqual(shellArgv("echo hi", { platform: "win32", env: ENV }))
  })
})

describe("a dependency is resolved for the platform it will be installed on", () => {
  test("the scheduler is whatever this platform actually provides", () => {
    const sched = MANIFEST.flatMap((m) => m.deps).find((d) => d.purpose.includes("scheduling"))!
    expect(sched.required).toBe(true)
    // Whatever platform the suite runs on, the check must name that platform's own scheduler — never a
    // required dependency the machine could not possibly have.
    expect(sched.check).toMatch(/launchctl|systemctl|schtasks/)
  })

  test("install commands differ where the command genuinely differs", () => {
    const go = MANIFEST.flatMap((m) => m.deps).find((d) => d.name === "go")!
    expect(resolveDep(go, "darwin").install).toContain("brew")
    expect(resolveDep(go, "linux").install).not.toContain("brew")
    expect(resolveDep(go, "win32").install).toContain("winget")
  })

  test("a platform with no override inherits, rather than losing the field", () => {
    const git = MANIFEST.flatMap((m) => m.deps).find((d) => d.name === "git")!
    expect(resolveDep(git, "linux").purpose).toBe(git.purpose)
    expect(resolveDep(git, "linux").kind).toBe(git.kind)
  })

  test("Linux Chromium pulls its system libraries — without them it starts and dies", () => {
    const pw = MANIFEST.flatMap((m) => m.deps).find((d) => d.name.includes("chromium"))!
    expect(resolveDep(pw, "linux").install).toContain("--with-deps")
    expect(resolveDep(pw, "darwin").install).not.toContain("--with-deps")
  })
})

// ── THE KERNEL, ASKED DIRECTLY ─────────────────────────────────────────────────────────────────────
//
// Everything above reads argv. That is necessary and it is NOT sufficient, and this project has now been
// bitten by the gap twice in two syntaxes: the macOS profile emitted regex literals escaped with the
// STRING escaper and four of six write rules matched nothing, and the first Linux profile bound from
// `/var/empty` — a path Debian does not have — so `--ro-bind-try` skipped every rule silently. Both had
// green unit tests. Only the kernel can answer whether a profile denies anything, so the kernel is asked.
//
// Skipped where bubblewrap is absent (macOS, and any Linux without the package); it RUNS in CI's Ubuntu
// row, which is the point.
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { whichBin } from "./shell"

const HAS_BWRAP = !!whichBin("bwrap")

test.if(HAS_BWRAP)("the Linux kernel DENIES persistence writes and credential reads, and allows ordinary work", () => {
  const home = process.env.HOME || "/root"
  mkdirSync(`${home}/.config/systemd/user`, { recursive: true })
  mkdirSync(`${home}/.ssh`, { recursive: true })
  writeFileSync(`${home}/.ssh/id_rsa`, "TOPSECRET")

  const plan = sandboxPlan({ home, denyCredentialReads: true }, "linux")
  expect(plan.available).toBe(true)
  const run = (code: string) => {
    const argv = plan.wrap(["node", "-e", code])
    return spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" }).status
  }

  // Denied by the kernel, not by a string match — the path is COMPUTED inside the program.
  expect(run(`require("fs").writeFileSync(${JSON.stringify(`${home}/.config/systemd/user/evil.service`)},"x")`)).not.toBe(0)
  expect(run(`process.stdout.write(require("fs").readFileSync(${JSON.stringify(`${home}/.ssh/id_rsa`)},"utf8"))`)).not.toBe(0)

  // THE CONTROLS are what keep this from passing on a profile that simply denies everything — which is
  // how a broken floor looks identical to a working one.
  expect(run(`require("fs").writeFileSync("/tmp/fabula-floor-ok.txt","x")`)).toBe(0)
  expect(run(`require("fs").readdirSync("/usr/bin")`)).toBe(0)
})

// ── Where the kernel cannot confine, say what the machine DOES have — probed, not asserted ─────────
//
// "Use the Docker backend for isolation" was constant text. It pointed at a runtime that may not be
// installed, which is the same defect as claiming a kernel profile that is not there: the reader cannot
// tell an unfixable platform from a fixable machine. `available` stays false either way, because a
// container confines by running the work inside an image this plan does not choose.
describe("the Windows note reports what this machine really offers", () => {
  const SCOPE = { home: "C:\\Users\\u", denyCredentialReads: true }

  test("a container runtime that IS present is named", () => {
    // A real file on THIS disk, named the way a win32 probe looks for one, so the branch is exercised
    // rather than asserted: the probe reads the filesystem, and a made-up path would only ever answer no.
    const dir = mkdtempSync(path.join(tmpdir(), "fab-container-"))
    writeFileSync(path.join(dir, "podman.exe"), "")
    const plan = sandboxPlan(SCOPE, "win32", { PATH: dir, PATHEXT: ".EXE", FABULA_DOCKER_BIN: "podman" })
    expect(plan.available).toBe(false)
    expect(plan.mechanism).toBe("none")
    expect(plan.note).toContain("IS present here")
  })

  test("no container runtime either is said outright, not implied", () => {
    const plan = sandboxPlan(SCOPE, "win32", { PATH: "C:\\nonexistent", FABULA_DOCKER_BIN: "definitely-not-a-program" })
    expect(plan.available).toBe(false)
    expect(plan.note).toContain("no container runtime is present either")
    expect(plan.note).not.toContain("IS present here")
  })

  test("the runtime's NAME comes from the one definition, so an override is honoured here too", () => {
    const plan = sandboxPlan(SCOPE, "win32", { PATH: "C:\\nonexistent", FABULA_DOCKER_BIN: "podman" })
    expect(plan.note).toContain("podman")
    expect(plan.note).not.toContain("docker not found")
  })
})
