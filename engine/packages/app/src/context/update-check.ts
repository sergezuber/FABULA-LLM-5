/**
 * Is a FABULA newer than the one running here published?
 *
 * A rule rather than a view, in a file with no framework imports, so it can be asked without starting
 * the application — the same shape as `models-served.ts` beside it, and for the same reason.
 *
 * WHAT IS COMPARED, and why it is compared HERE rather than in the engine. The number the reader sees
 * in the sidebar footer is `FABULA_VERSION`, baked into this bundle. Comparing anything else would be a
 * second definition of "which version am I", and this repository has paid for that shape more than once
 * — so the route reports only what is PUBLISHED, and the running version enters the comparison from the
 * one place that already owns it.
 *
 * THE DIRECTION OF FAILURE IS DELIBERATE. A missed notice costs the reader a later update. A false one
 * sends them to rebuild a tree that is already current, and teaches them to ignore the indicator — so
 * anything that cannot be compared with certainty produces NO notice, never a hopeful one.
 */

/** A release as the update route reports it. `null` whenever the question could not be answered. */
export type PublishedRelease = { version: string; url: string } | null

/**
 * `"v0.220.0"` → `[0, 220, 0]`, and `null` for anything this cannot compare with certainty.
 *
 * Only a leading `v` and pure-digit components are accepted. A suffix (`0.221.0-rc1`, and note the
 * engine's own build stamp `0.220.0-prod-202608130918`) is refused rather than guessed at: ordering
 * pre-releases is a policy nobody here has decided, and inventing one would show a notice for a build
 * that may be older than what is running.
 */
export function parseVersion(raw: string | null | undefined): number[] | null {
  if (typeof raw !== "string") return null
  const body = raw.trim().replace(/^v/i, "")
  if (body === "") return null
  const parts = body.split(".")
  const out: number[] = []
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null
    out.push(Number(p))
  }
  return out
}

/**
 * Is `latest` a higher version than `current`?
 *
 * Component by component, NUMERICALLY. The trap this exists to avoid is comparing the strings: by that
 * reading `"0.9.0"` sorts above `"0.10.0"`, so the tenth minor release of a series would silently stop
 * announcing itself — and this project's minor number has no ceiling and is already past two hundred,
 * so the string comparison would be wrong far more often than it is right.
 *
 * Missing components count as zero, so `0.221` and `0.221.0` are the same release.
 */
export function isNewer(latest: string | null | undefined, current: string | null | undefined): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/**
 * What the sidebar should show, given what the route said and which version is running.
 *
 * One function so the indicator, its label and its link cannot disagree: either there is a notice with
 * everything it needs, or there is nothing to draw.
 */
export function updateNotice(release: PublishedRelease, current: string): { version: string; url: string } | null {
  if (!release) return null
  if (!isNewer(release.version, current)) return null
  if (typeof release.url !== "string" || !/^https:\/\//.test(release.url)) return null
  return { version: release.version.replace(/^v/i, ""), url: release.url }
}
