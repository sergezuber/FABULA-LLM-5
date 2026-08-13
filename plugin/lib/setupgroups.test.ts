import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import nodePath from "path"
import { MANIFEST } from "./manifest"
import { CORE_PLUGINS, SETUP_GROUPS, MODEL_SOURCES, extraDepsForGroups, pluginsForGroups } from "./setupgroups"

// Users said they could not tell what was being installed or why. The cause was a reading of the
// manifest: `required` there means "this PLUGIN cannot work without it", and the installer took it to
// mean "FABULA cannot work without it" — so it installed the required dependency of every plugin,
// including plugins that person would never use. Measured before the change: 22 dependencies treated
// as mandatory, among them a 539 MB Chromium and LM Studio, the latter simply wrong for anyone whose
// model lives behind a gateway. These cases pin the smaller promise the installer now makes.

const REPO = nodePath.resolve(import.meta.dir, "..", "..")

// Unique names: the plugin SDK is declared by every plugin that uses it, so the raw list repeats.
const depsFor = (ids: readonly string[]) => [
  ...new Set(MANIFEST.filter((m) => ids.includes(m.id)).flatMap((m) => m.deps.filter((d) => d.required).map((d) => d.name))),
]

describe("the core is small enough to install without asking", () => {
  test("core needs nothing a person would be surprised by", () => {
    const names = depsFor(CORE_PLUGINS)
    // Four npm packages that arrive in one `bun install`, plus git. Nothing to download separately,
    // nothing to run as a service, no model runtime.
    expect(names.sort()).toEqual(["@mimo-ai/plugin", "defuddle", "git", "linkedom", "unpdf"].sort())
  })

  test("the browser is NOT core — that is the half-gigabyte the complaint was about", () => {
    const names = depsFor(CORE_PLUGINS)
    expect(names.some((n) => /playwright|chromium/i.test(n))).toBe(false)
    // …and it is reachable, as a question with a price on it.
    const browser = SETUP_GROUPS.find((g) => g.id === "browser")
    expect(browser?.plugins).toContain("browser")
    expect(browser?.cost).toMatch(/MB|GB/)
  })

  test("no model runtime is installed by default — an endpoint is a first-class answer", () => {
    const names = depsFor(CORE_PLUGINS)
    expect(names.some((n) => /LM Studio/i.test(n))).toBe(false)
    expect(MODEL_SOURCES.map((m) => m.id)).toEqual(["local", "endpoint", "later"])
  })
})

describe("a choice adds exactly what it promised, and nothing else", () => {
  test("choosing the browser adds the browser plugin and leaves the rest alone", () => {
    expect(pluginsForGroups(["browser"]).sort()).toEqual([...CORE_PLUGINS, "browser"].sort())
  })

  test("choosing nothing installs the core, not an empty set", () => {
    expect(pluginsForGroups([])).toEqual([...CORE_PLUGINS])
  })

  test("capability groups name real dependencies from the manifest, not invented ones", () => {
    const known = new Set(MANIFEST.flatMap((m) => m.deps.map((d) => d.name)))
    const invented = SETUP_GROUPS.flatMap((g) => g.extraDeps ?? []).filter((n) => !known.has(n))
    expect(invented).toEqual([])
  })

  test("every group points at plugins that exist", () => {
    const ids = new Set(MANIFEST.map((m) => m.id))
    const dangling = SETUP_GROUPS.flatMap((g) => g.plugins).filter((p) => !ids.has(p))
    expect(dangling).toEqual([])
  })

  test("go analysers arrive together — a floor missing its tools reads as a clean one", () => {
    const go = extraDepsForGroups(["go"])
    expect(go).toContain("go")
    expect(go).toContain("govulncheck")
    expect(go.length).toBeGreaterThanOrEqual(5)
  })
})

describe("every question a person is asked can be answered without reading the source", () => {
  for (const g of SETUP_GROUPS) {
    test(`${g.id}: asks, prices, and says who should decline`, () => {
      expect(g.question).toMatch(/\?$/)
      expect(g.cost.length).toBeGreaterThan(8)
      // The reason to skip must name a situation, not offer a vague reassurance.
      expect(g.skipIf.length).toBeGreaterThan(40)
      expect(g.skipIf).not.toMatch(/probably|maybe|might not need/i)
    })
  }
})

describe("setup.sh and the installer read this file rather than repeating it", () => {
  const setup = readFileSync(nodePath.join(REPO, "setup.sh"), "utf8")
  const setupPs1 = readFileSync(nodePath.join(REPO, "setup.ps1"), "utf8")
  const installer = readFileSync(nodePath.join(REPO, "scripts/install-deps.ts"), "utf8")

  // BOTH setup scripts, always. The POSIX one was rewritten first and the Windows twin kept calling the
  // installer with no group at all — i.e. the complaint that started this ("I cannot tell what is being
  // installed or why", 22 dependencies, a 539 MB browser among them) stayed live on Windows while the
  // changelog said it was resolved. One platform quietly offering a different product is the failure
  // this pair of cases exists to prevent.
  for (const [name, text] of [
    ["setup.sh", setup],
    ["setup.ps1", setupPs1],
  ] as const) {
    test(`${name} asks the questions from this module and installs only what was chosen`, () => {
      expect(text, `${name} does not read setupgroups`).toContain("setupgroups")
      expect(text, `${name} installs every plugin's required deps`).toContain("--groups=")
      for (const g of SETUP_GROUPS) expect(text, `${name} repeats a question`).not.toContain(g.question)
      for (const m of MODEL_SOURCES) expect(text, `${name} repeats an option`).not.toContain(m.label)
    })

    test(`${name} installs the localhost adapter only for a model on this machine`, () => {
      // Registering a logon task / LaunchAgent for someone whose model lives behind a gateway is the
      // same defect as the browser: something large and permanent, arriving unasked.
      //
      // Read the GUARD, not the file. The first version of this case asked whether the model-source
      // variable appeared anywhere in the script, and replacing the real condition with `if true` left
      // it green — an assertion that cannot become false, in the one place whose job is to notice.
      const lines = text.split("\n")
      const at = lines.findIndex((l) => l.includes("install-adapter-service") && !l.trimStart().startsWith("#"))
      expect(at, `${name} never installs the adapter`).toBeGreaterThan(-1)
      const above = lines.slice(Math.max(0, at - 8), at)
      const guard = above.find((l) => /^\s*(if|elif)\b|\bif\s*\(/.test(l))
      expect(guard, `${name}: the adapter install is not inside a conditional`).toBeDefined()
      expect(guard, `${name}: the adapter is installed regardless of where the model comes from`).toMatch(
        /MODEL_SOURCE|ModelSource/,
      )
    })
  }

  test("the installer honours --groups and still supports its old callers", () => {
    expect(installer).toContain("--groups=")
    expect(installer).toContain("pluginsForGroups")
    // Absent flag → the historical behaviour, so app/build.sh and every existing script keep working.
    expect(installer).toContain("GROUPS = groupsArg === undefined ? null")
  })

  test("setup never blocks on a prompt where nothing can answer it", () => {
    expect(setup).toContain("[ -t 0 ]")
  })
})
