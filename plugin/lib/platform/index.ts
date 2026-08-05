// Which operating system is this, asked ONCE and answered in ONE place.
//
// Every platform decision in the harness routes through this module. Nothing under `plugin/` may test
// `process.platform` directly — a second reading of the same question drifts from the first, and this
// project has paid for two-definitions-of-one-rule more often than for any other defect (store vs gate on
// what an origin is; panel vs gate on what "enabled" means; preload vs resolver on where a store lives).
// Whichever runs first wins, and which one that is changes.
//
// READ AT CALL TIME, NEVER AT IMPORT. A value captured when a module loads is a snapshot, and this
// repository has been bitten by that exact shape repeatedly — a window cached for the life of a process,
// an endpoint frozen at import, MODEL_API captured before a test could point it elsewhere. Every function
// here takes its inputs as parameters with live defaults, so a caller (and a test) can always ask the
// question for a platform that is not the one it happens to be running on.

export type Platform = "darwin" | "linux" | "win32"

export const PLATFORMS: readonly Platform[] = ["darwin", "linux", "win32"] as const

function isPlatform(v: unknown): v is Platform {
  return typeof v === "string" && (PLATFORMS as readonly string[]).includes(v)
}

/**
 * The platform this process is running on.
 *
 * `FABULA_PLATFORM` overrides it. That knob is NOT a production switch and must never be used to make
 * the harness pretend: it exists so a test on one machine can drive the branches of the other two. The
 * exit criterion for the platform seam is exactly that — flip this to "linux" on a Mac and the
 * macOS-specific assertions must FAIL. Without an override there is no way to tell a seam that is wired
 * from a seam that is merely declared, which is this repository's most-repeated trap: a pure core green
 * while the two lines that connect it are covered by nothing.
 *
 * An unrecognised value is IGNORED rather than honoured. A typo must not silently select a fourth,
 * nonexistent platform whose branches are all fall-through.
 */
export function current(env: NodeJS.ProcessEnv = process.env, runtime: string = process.platform): Platform {
  const forced = env.FABULA_PLATFORM
  if (isPlatform(forced)) return forced
  if (isPlatform(runtime)) return runtime
  // Everything else in the POSIX family (freebsd, openbsd, sunos, aix) behaves like Linux for every
  // decision this seam makes: a POSIX shell, XDG paths, /proc-shaped memory, no Seatbelt. Answering
  // "linux" is a truthful approximation; answering "darwin" would hand it a Seatbelt that does not exist.
  return "linux"
}

/**
 * The platform this process is REALLY on, with the override deliberately not consulted.
 *
 * There are two kinds of question in this seam and they want different answers. "Where would this live
 * on system X" must answer in X's terms, so it goes through `current()` and honours the override — that
 * is what lets one machine drive another's branches. "Open this file, here, now" is not a question about
 * a platform at all; it is an action on this filesystem, and it must keep working while a test is
 * pretending to be somewhere else. Routing the acting kind through the override made a simulated run
 * write its stores under names this filesystem could not open, and thirty-five checks failed against
 * data that had been put somewhere unreachable.
 *
 * Use this ONLY for acting. Anything that merely reports should take a platform parameter instead, so a
 * caller can ask about a system that is not this one.
 */
export function hostPlatform(runtime: string = process.platform): Platform {
  return isPlatform(runtime) ? runtime : "linux"
}

/** Is this a POSIX host — one shell family, one path separator, one set of persistence targets? */
export function isPosix(p: Platform = current()): boolean {
  return p !== "win32"
}

/** The PATH list separator. `:` everywhere except Windows, where it is `;`. */
export function pathListSeparator(p: Platform = current()): string {
  return p === "win32" ? ";" : ":"
}

/** The suffix an executable carries on this platform (`""` on POSIX, `".exe"` on Windows). */
export function exeSuffix(p: Platform = current()): string {
  return p === "win32" ? ".exe" : ""
}
