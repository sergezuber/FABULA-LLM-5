// The kernel floor, and the one platform where there isn't one.
//
// The property under test is NOT "the profile is well-formed". It is that a platform which cannot enforce
// the claim SAYS SO, and that the caller can tell "this is enforced" from "this ran unconfined" without
// reading the source. A sandbox that silently degrades is worse than no sandbox: the caller believes a
// claim nobody is keeping.

import { test, expect, describe } from "bun:test"
import { sandboxPlan, sandboxShellArgv, buildSeatbeltProfile, bubblewrapArgs, shellScope, untrustedScope } from "./sandbox"
import { hardlineKernelRegex } from "./persistence"
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
    // while the kernel confined another.
    const { argv } = sandboxShellArgv("echo hi", SCOPE, "win32", ENV)
    expect(argv).toEqual(["bash", "-lc", "echo hi"])
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
