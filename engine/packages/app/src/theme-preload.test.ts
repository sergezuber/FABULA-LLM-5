import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/oc-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  // MEASURED 2026-08-01: this script defaulted to "oc-2" and migrated oc-1 → oc-2, knowing nothing about
  // the FABULA theme the bundle defaults to — so a fresh profile's FIRST PAINT was the old engine theme,
  // corrected only once the bundle had loaded. Running before the bundle is the entire reason this script
  // exists. The assertion that used to live here checked the oc-1 → oc-2 migration, which pinned the gap
  // in place rather than catching it.
  test("a fresh profile paints the FABULA theme, not the old engine default", () => {
    localStorage.setItem("opencode-theme-css-light", "--background-base:#171717;")

    run()

    expect(document.documentElement.dataset.theme).toBe("fabula")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain("--background-base:#171717;")
  })

  test("a legacy stored theme is migrated to FABULA, matching the bundle's own one-time migration", () => {
    for (const legacy of ["oc-1", "oc-2"]) {
      localStorage.clear()
      localStorage.setItem("opencode-theme-id", legacy)
      run()
      expect(document.documentElement.dataset.theme).toBe("fabula")
    }
  })

  test("after the migration has run, a deliberately chosen legacy theme is respected", () => {
    localStorage.setItem("fabula-theme-migrated", "1")
    localStorage.setItem("opencode-theme-id", "oc-2")

    run()

    expect(document.documentElement.dataset.theme).toBe("oc-2")
    // oc-2's colours are compiled into the stylesheet — nothing to inject, as before.
    expect(document.getElementById("oc-theme-preload")).toBeNull()
  })

  test("the marker is the BUNDLE's to write — a cached copy of this script must not claim the migration ran", () => {
    run()
    expect(localStorage.getItem("fabula-theme-migrated")).toBeNull()
  })

  test("keeps cached css for non-default themes", () => {
    localStorage.setItem("opencode-theme-id", "nightowl")
    localStorage.setItem("opencode-theme-css-light", "--background-base:#fff;")

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.getElementById("oc-theme-preload")?.textContent).toContain("--background-base:#fff;")
  })
})
