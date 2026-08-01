;(function () {
  // The anti-flash script: it runs BEFORE the bundle, so whatever it stamps here is what the user's eye
  // sees first. It therefore has to agree with the bundle about what the default theme is.
  //
  // MEASURED 2026-08-01: it did not. This script knew nothing about the FABULA theme — it defaulted to
  // "oc-2", migrated "oc-1" → "oc-2", and then RETURNED EARLY for "oc-2" without injecting any CSS. So on
  // a fresh profile the first paint was the old engine default, corrected to `fabula` only once the
  // bundle had loaded. Returning users were unaffected (their stored id is already `fabula`), which is
  // exactly why it survived — and its own test asserted the oc-1 → oc-2 migration, pinning the gap in
  // place rather than catching it.
  //
  // The two rules below now mirror `packages/ui/src/theme/context.tsx`: the same marker guard, the same
  // legacy set, the same default. A user who has deliberately chosen oc-1 or oc-2 SINCE the migration
  // keeps it, because the marker is written once and checked here too.
  var key = "opencode-theme-id"
  var MIGRATED = "fabula-theme-migrated"
  var themeId = localStorage.getItem(key)

  if (!localStorage.getItem(MIGRATED)) {
    // Do NOT write the marker here — the bundle owns that write, and claiming the migration from a
    // script that may be cached separately would make the two disagree about whether it has happened.
    if (!themeId || themeId === "oc-1" || themeId === "oc-2") themeId = "fabula"
  }
  themeId = themeId || "fabula"

  var scheme = localStorage.getItem("opencode-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode

  // oc-2 is the one theme whose colours are compiled into the stylesheet, so it needs no injection.
  // Every other theme — fabula included — is served from the cached CSS below.
  if (themeId === "oc-2") return

  var css = localStorage.getItem("opencode-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "oc-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
