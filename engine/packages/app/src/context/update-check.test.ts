import { describe, expect, test } from "bun:test"
import { isNewer, parseVersion, updateNotice } from "./update-check"

describe("comparing versions numerically, not as strings", () => {
  test("the tenth minor release is newer than the ninth — the trap this module exists for", () => {
    // As strings, "0.9.0" > "0.10.0". This project's minor number has no ceiling and is already past
    // two hundred, so a string comparison would be wrong far more often than right.
    expect(isNewer("0.10.0", "0.9.0")).toBe(true)
    expect(isNewer("0.9.0", "0.10.0")).toBe(false)
    expect(isNewer("0.221.0", "0.220.0")).toBe(true)
    expect(isNewer("0.99.0", "0.220.0")).toBe(false)
  })

  test("a leading v is the tag's spelling, not part of the number", () => {
    expect(isNewer("v0.221.0", "0.220.0")).toBe(true)
    expect(isNewer("V0.221.0", "0.220.0")).toBe(true)
    expect(isNewer("v0.220.0", "0.220.0")).toBe(false)
  })

  test("a missing component is zero, so 0.221 and 0.221.0 are one release", () => {
    expect(isNewer("0.221", "0.221.0")).toBe(false)
    expect(isNewer("0.221.0", "0.221")).toBe(false)
    expect(isNewer("0.221.1", "0.221")).toBe(true)
  })

  test("the same version is not an update", () => {
    expect(isNewer("0.220.0", "0.220.0")).toBe(false)
  })

  test("a patch above the running patch is an update", () => {
    expect(isNewer("0.220.1", "0.220.0")).toBe(true)
    expect(isNewer("0.220.0", "0.220.1")).toBe(false)
  })
})

describe("anything that cannot be compared with certainty produces no notice", () => {
  test("a suffix is refused rather than guessed at", () => {
    // The engine's own build carries `0.220.0-prod-202608130918`. Ordering pre-releases is a policy
    // nobody here has decided; inventing one could announce a build OLDER than what is running.
    expect(parseVersion("0.221.0-rc1")).toBeNull()
    expect(parseVersion("0.220.0-prod-202608130918")).toBeNull()
    expect(isNewer("0.221.0-rc1", "0.220.0")).toBe(false)
  })

  test("garbage, empty and absent all refuse", () => {
    for (const bad of ["", "   ", "v", "latest", "0.x.0", "..", null, undefined]) {
      expect(parseVersion(bad as string)).toBeNull()
      expect(isNewer(bad as string, "0.220.0")).toBe(false)
      expect(isNewer("0.221.0", bad as string)).toBe(false)
    }
  })

  test("a plain number is a version, since a page may tag a release that way", () => {
    expect(parseVersion("7")).toEqual([7])
    expect(isNewer("7", "6")).toBe(true)
  })
})

describe("the notice carries everything it needs, or there is no notice", () => {
  const REL = { version: "v0.221.0", url: "https://github.com/sergezuber/FABULA-LLM-5/releases/tag/v0.221.0" }

  test("a newer release becomes a notice with the v stripped for display", () => {
    expect(updateNotice(REL, "0.220.0")).toEqual({ version: "0.221.0", url: REL.url })
  })

  test("no release, an older release and the same release all draw nothing", () => {
    expect(updateNotice(null, "0.220.0")).toBeNull()
    expect(updateNotice({ ...REL, version: "0.219.0" }, "0.220.0")).toBeNull()
    expect(updateNotice({ ...REL, version: "0.220.0" }, "0.220.0")).toBeNull()
  })

  test("a link that is not https draws nothing — the indicator is clickable", () => {
    // The URL arrives over the network and ends up in a browser navigation. A notice without a link
    // it can safely open is not a notice worth showing.
    expect(updateNotice({ ...REL, url: "javascript:alert(1)" }, "0.220.0")).toBeNull()
    expect(updateNotice({ ...REL, url: "http://example.com" }, "0.220.0")).toBeNull()
    expect(updateNotice({ ...REL, url: "" }, "0.220.0")).toBeNull()
  })
})
