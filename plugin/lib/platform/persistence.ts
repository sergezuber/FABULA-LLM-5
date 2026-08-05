// WHAT MUST NEVER BE WRITTEN — declared once, rendered into every grammar that has to enforce it.
//
// The same set of targets was written out twice, in two grammars, in two files: `lib/pathguard.ts` matched
// them as JavaScript strings and regexes, and `lib/sandbox.ts` re-spelled them as Seatbelt regex fragments.
// `sandbox.ts` says so in its own comment — "these mirror lib/pathguard's hardline set" — which is an
// honest description of a liability: a mirror is something that can stop reflecting. Add a target to one
// and the other silently keeps enforcing the old set, and the two layers that were supposed to agree
// (in-process rules and the kernel) disagree exactly where it matters least visibly.
//
// A port multiplies that by three. So the set moves here, ONE ordered list per platform, and both layers
// RENDER from it. Adding a target is one edit; forgetting to add it to the kernel becomes impossible.
//
// ORDER IS CONTRACT for the in-process matcher: it reports the code of the FIRST rule that matches, and
// the more specific rule must come first (a write to the current user's own `~/.ssh/authorized_keys` is
// reported as `ssh_authorized_keys`, any other user's as the generic `ssh_key`). The kernel does not care
// about order — every deny is OR'd — but there is no reason to keep two orders.

import * as path from "node:path"
import { current, type Platform } from "./index"

// A macOS path is a POSIX path no matter which machine computes it, and a Windows path is a Windows path
// no matter which machine computes it. `path.join` answers in the HOST's shape — so on a Windows runner
// this module produced `\home\u\.ssh` for the Linux target list and every rule written with `/` stopped
// matching. Sixty-five checks went red there and none anywhere else. The renderers below therefore name
// the dialect they are rendering FOR; `path` itself is kept only where the answer really is about the
// machine this code is running on.
const posix = path.posix
const win = path.win32
import { homeDir } from "./paths"

export interface HardlineTarget {
  /** Reported to the user and to the transcript. Stable — messages and tests key on it. */
  code: string
  /** One sentence saying WHY, in the block message. */
  reason: string
  /** In-process matchers. A string matches by equality-or-prefix; a RegExp by test. */
  match: Array<string | RegExp>
  /**
   * Fragments for a REGEX-based kernel profile (macOS Seatbelt). Written in the kernel's own regex
   * dialect, unescaped — the profile builder escapes them for its literal syntax.
   *
   * A mount-based sandbox (Linux bubblewrap) cannot use these and reads `match` instead: it makes the
   * paths unreachable rather than matching their names. That difference is the reason both fields exist
   * rather than one being derived from the other — deriving a regex from a mount, or a mount from a
   * regex, would be a guess in one direction or the other.
   */
  kernel: string[]
}

/** Targets shared by every POSIX host: SSH, system auth, cron. */
function posixTargets(home: string): HardlineTarget[] {
  return [
    {
      code: "ssh_authorized_keys",
      reason: "writing SSH authorized_keys installs a login backdoor.",
      match: [posix.join(home, ".ssh", "authorized_keys")],
      kernel: ["authorized_keys"],
    },
    {
      code: "ssh_key",
      reason: "writing into ~/.ssh keys/authorized_keys is an SSH backdoor vector.",
      match: [/\/\.ssh\/(authorized_keys|id_[a-z0-9]+)$/],
      kernel: ["/\\.ssh/id_"],
    },
    {
      code: "sudoers",
      reason: "modifying /etc/sudoers escalates privileges.",
      match: ["/etc/sudoers"],
      kernel: ["/etc/sudoers"],
    },
    {
      code: "sudoers",
      reason: "modifying sudoers.d escalates privileges.",
      match: [/^\/etc\/sudoers\.d\//],
      kernel: [],
    },
    {
      code: "passwd",
      reason: "modifying /etc/passwd tampers with system accounts.",
      match: ["/etc/passwd"],
      kernel: ["/etc/passwd"],
    },
    {
      code: "shadow",
      reason: "modifying /etc/shadow tampers with password hashes.",
      match: ["/etc/shadow"],
      kernel: ["/etc/shadow"],
    },
    {
      code: "cron",
      reason: "writing cron entries installs persistence.",
      match: [/\/cron(tab|\.d)\b|\/var\/(at|spool\/cron)\//],
      kernel: ["/cron(tab|\\.d)", "/var/at/", "/var/spool/cron/"],
    },
  ]
}

/** launchd — the macOS way to make something run again after a reboot. */
function darwinTargets(home: string): HardlineTarget[] {
  return [
    {
      code: "launchd",
      reason: "writing LaunchDaemons installs persistence.",
      match: [/\/(Library|System)\/LaunchDaemons\//],
      kernel: ["/LaunchDaemons/"],
    },
    {
      code: "launchagent",
      reason: "writing LaunchAgents installs persistence.",
      match: [posix.join(home, "Library", "LaunchAgents")],
      kernel: ["/LaunchAgents/"],
    },
  ]
}

/**
 * The Linux equivalents — the same claim, different mechanisms.
 *
 * A user-level systemd unit and an XDG autostart entry are precisely what a LaunchAgent is: something the
 * session manager will start again without anyone asking. Shell rc files belong here for the same reason
 * and are the oldest trick of the three — a line in `.bashrc` runs on every login shell forever.
 */
function linuxTargets(home: string): HardlineTarget[] {
  return [
    {
      code: "systemd_user",
      reason: "writing a user systemd unit installs persistence.",
      match: [posix.join(home, ".config", "systemd", "user"), /\/\.config\/systemd\/user\//],
      kernel: ["/\\.config/systemd/user/"],
    },
    {
      code: "systemd_system",
      reason: "writing a system systemd unit installs persistence with system privilege.",
      match: [/^\/(etc|usr\/lib|lib)\/systemd\/system\//],
      kernel: ["/systemd/system/"],
    },
    {
      code: "autostart",
      reason: "writing an XDG autostart entry starts a program at every login.",
      match: [posix.join(home, ".config", "autostart"), /\/\.config\/autostart\//],
      kernel: ["/\\.config/autostart/"],
    },
    {
      code: "shell_rc",
      reason: "writing a shell startup file runs code on every login shell.",
      match: [/\/\.(bashrc|bash_profile|zshrc|zprofile|profile)$/],
      kernel: ["/\\.(bashrc|bash_profile|zshrc|zprofile|profile)$"],
    },
    {
      code: "ld_preload",
      reason: "writing ld.so.preload injects a library into every process on the system.",
      match: ["/etc/ld.so.preload"],
      kernel: ["/etc/ld\\.so\\.preload"],
    },
  ]
}

/**
 * The Windows equivalents.
 *
 * NOTE what is NOT here, and it is not an oversight: the `Run` registry keys are the most common Windows
 * persistence of all, and they are not a filesystem path — nothing that reads a write TARGET can see them.
 * They are reachable only as a COMMAND (`reg add`, `New-ItemProperty`, `Register-ScheduledTask`), so they
 * belong to `lib/cmdguard.ts`, and this module exports `PERSISTENCE_COMMANDS` for that reason. A guard
 * that silently covered only the half it could see would be the "thin floor reads as a clean floor"
 * failure this project keeps finding.
 */
function win32Targets(home: string): HardlineTarget[] {
  return [
    {
      code: "startup_folder",
      reason: "writing into the Startup folder runs a program at every login.",
      match: [/\\Start Menu\\Programs\\Startup\\/i, /\/Start Menu\/Programs\/Startup\//i],
      kernel: [],
    },
    {
      code: "scheduled_task",
      reason: "writing into the Tasks store installs a scheduled task.",
      match: [/\\System32\\Tasks\\/i, /\/System32\/Tasks\//i],
      kernel: [],
    },
    {
      code: "powershell_profile",
      reason: "writing a PowerShell profile runs code in every new shell.",
      match: [/\\(Microsoft\.PowerShell|Profile)\.ps1$/i, /\/(Microsoft\.PowerShell|Profile)\.ps1$/i],
      kernel: [],
    },
    {
      code: "ssh_authorized_keys",
      reason: "writing SSH authorized_keys installs a login backdoor.",
      // Both spellings: a Windows machine reaches this file as `C:\\Users\\u\\.ssh\\...` and, through the
      // POSIX shell this harness requires, as `/c/Users/u/.ssh/...`.
      match: [win.join(home, ".ssh", "authorized_keys"), posix.join(home, ".ssh", "authorized_keys")],
      kernel: [],
    },
    {
      code: "ssh_key",
      reason: "writing into ~/.ssh keys/authorized_keys is an SSH backdoor vector.",
      match: [/[\\/]\.ssh[\\/](authorized_keys|id_[a-z0-9]+)$/i],
      kernel: [],
    },
  ]
}

/**
 * The supervision layer's own state.
 *
 * Not persistence — the opposite: these files record whether the guards are ON. A run that can write them
 * does not need to defeat any other rule, because one `echo '{"mode":"bypass"}' >` switches the whole
 * layer off. Guarding the tools that edit them while leaving the files writable is guarding the front door
 * of a house with no walls. Platform-independent by construction: the filenames are ours.
 */
function supervisionTargets(): HardlineTarget[] {
  return [
    {
      code: "supervision_state",
      reason: "this file records whether the guards are on; editing it from inside a run disarms them.",
      match: [/fabula-permissions\.json$/],
      kernel: ["fabula-permissions\\.json$"],
    },
    {
      code: "supervision_state",
      reason: "this file records which plugins load; editing it from inside a run can switch the guards off.",
      match: [/fabula-state\.json$/],
      kernel: ["fabula-state\\.json$"],
    },
  ]
}

/**
 * Every hardline write target for this platform, in match order.
 *
 * Read at CALL time — `home` moves (the test preload rewrites it), and a list frozen at import would
 * enforce whichever home happened to exist when the module first loaded.
 */
export function hardlineTargets(
  env: NodeJS.ProcessEnv = process.env,
  p: Platform = current(env),
): HardlineTarget[] {
  const home = homeDir(env)
  // THE POSIX SET APPLIES ON WINDOWS TOO, and dropping it there was a real hole rather than a tidiness.
  // A Windows machine has no `/etc/sudoers` of its own — but it reaches one through WSL, and the POSIX
  // shell this harness requires presents `/etc/...` paths directly. A rule that matches nothing on a
  // platform costs nothing; a rule that is absent costs exactly the case nobody thought of. Found by
  // running the guard suite with the platform flipped to win32, where four backdoor paths stopped being
  // refused.
  if (p === "win32") return [...posixTargets(home), ...win32Targets(home), ...supervisionTargets()]
  const base = posixTargets(home)
  const os = p === "darwin" ? darwinTargets(home) : linuxTargets(home)
  return [...base, ...os, ...supervisionTargets()]
}

/** Every kernel-profile regex fragment for this platform's hardline set, deduped, order preserved. */
export function hardlineKernelRegex(
  env: NodeJS.ProcessEnv = process.env,
  p: Platform = current(env),
): string[] {
  const out: string[] = []
  for (const t of hardlineTargets(env, p)) for (const k of t.kernel) if (!out.includes(k)) out.push(k)
  return out
}

// ── Credentials ────────────────────────────────────────────────────────────────────────────────────
//
// A separate claim from persistence, and deliberately a wider one: `execute_code` runs untrusted or
// experimental code, so denying it every secret-shaped file is right. `bash_tool` is the main working
// tool and writing a `.env` in your own project is ordinary work — a guard that refuses that is a guard
// that gets switched off. Hence two profiles, and hence this set being its own export.

/**
 * Directories whose READS are denied to untrusted code. Same names on every platform.
 *
 * Takes the home explicitly rather than reading the environment: the sandbox profile is built for a
 * NAMED home (a test builds one for `/Users/x`, and a container backend builds one for the container's
 * home, not this process's). A function that quietly substituted `process.env.HOME` would produce a
 * profile that denies the wrong directory — and a profile denying a path nobody writes to reads exactly
 * like a profile that works.
 */
export function credentialReadDirs(home: string): string[] {
  return [".ssh", ".aws", ".gnupg", ".config/gh", ".netrc"].map((p) => posix.join(home, p))
}

/** Secret-shaped filenames whose WRITES are denied to untrusted code, as kernel regex fragments. */
export const CREDENTIAL_WRITE_REGEX: readonly string[] = [
  "\\.env$", "\\.key$", "\\.pem$", "\\.p12$", "id_rsa", "id_ed25519",
]

// ── Persistence that has no path ───────────────────────────────────────────────────────────────────

/**
 * Persistence installed by COMMAND rather than by writing a file.
 *
 * `lib/cmdguard.ts` and `lib/roles.ts` read command text; these are the verbs that install something
 * which runs again later. Declared here so the path-shaped and command-shaped halves of one claim stay in
 * one module — the Windows registry `Run` key exists ONLY in this half, and a reader who found only the
 * path list would reasonably conclude Windows persistence was covered.
 */
export function persistenceCommands(p: Platform = current()): RegExp[] {
  if (p === "win32") {
    return [
      /\breg(\.exe)?\s+add\b.*\bcurrentversion\\run/i,
      /\bnew-itemproperty\b.*\bcurrentversion\\run/i,
      /\bregister-scheduledtask\b/i,
      /\bschtasks(\.exe)?\s+\/create\b/i,
      /\bnew-service\b|\bsc(\.exe)?\s+create\b/i,
    ]
  }
  if (p === "linux") {
    return [
      /\bsystemctl\s+(--user\s+)?(enable|link)\b/i,
      /\bcrontab\b/i,
      /\bupdate-rc\.d\b|\bchkconfig\b/i,
    ]
  }
  return [
    /\blaunchctl\b/i,
    /\bdefaults\s+write\b/i,
    /\bcrontab\b/i,
  ]
}
