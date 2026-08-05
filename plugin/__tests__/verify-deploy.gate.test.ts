// Deploy-guard gate: scripts/verify-deploy.sh must hold every shipped artifact to the version the
// source declares. The audit found the guard checked timestamps and markers but never the number
// itself: it did not read FABULA_VERSION, never opened the app bundle's Info.plist, never looked at
// the built frontend dist — so a fresh build of the WRONG tree passed as "FRESH".
//
// This test runs the shipped script itself (copied verbatim into a synthetic tree, invoked exactly
// as deployed) against trees where each artifact in turn carries a different version than the
// source declares. Every mismatch case asserts the guard's report line NAMES the version the
// artifact actually carries — not just a non-zero exit — so the assertions are mutation-proof:
// delete any one of the three checks from the script, or drop the actual-version naming from its
// message, and the corresponding test here falls.
//
// The synthetic engine binary is a plain executable that embeds every marker the guard probes for
// (the marker list is read out of the script at runtime, so a marker added later is picked up
// here automatically) — the tree is fully green EXCEPT for the one lie under test, which keeps
// each case pointed at exactly one check.
import { test, expect, afterAll } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { current as currentPlatform } from "../lib/platform/index"
// THE WHOLE FILE IS macOS-SHAPED: every synthetic tree it builds stamps an Info.plist, which is the
// third artifact on THIS platform only — Linux carries a desktop entry and Windows an installer
// manifest. The guard itself was made platform-aware; these fixtures were not, and a fixture that
// describes another platform is not a finding about this one.
const IS_MAC = currentPlatform() === "darwin"

const REPO = path.resolve(__dirname, "..", "..")
const SCRIPT = path.join(REPO, "scripts", "verify-deploy.sh")
const SCRIPT_TEXT = await Bun.file(SCRIPT).text()

// Every string literal the guard's marker section probes the binary for. Read from the script so
// the synthetic binary always satisfies the marker checks, whatever they say this week.
const MARKERS = [...SCRIPT_TEXT.matchAll(/^check_marker +"([^"]+)"/gm)].map((m) => m[1])

const trees: string[] = []
afterAll(() => {
  for (const t of trees) rmSync(t, { recursive: true, force: true })
})

type TreeSpec = {
  srcVer?: string | null // FABULA_VERSION in the changelog source; null = the declaration is absent
  distVer?: string | null // version baked into dist assets; null = no dist bundle at all
  binVer?: string // version embedded in the engine binary's bytes
  plistVer?: string | null // CFBundleShortVersionString; null = no app bundle at all
}

function makeTree(spec: TreeSpec = {}): string {
  const { srcVer = "7.7.7", distVer = "7.7.7", binVer = "7.7.7", plistVer = "7.7.7" } = spec
  const root = mkdtempSync(path.join(tmpdir(), "fabula-deploy-gate-"))
  trees.push(root)

  // The shipped script, verbatim, at its shipped location — ROOT derivation and all.
  mkdirSync(path.join(root, "scripts"))
  cpSync(SCRIPT, path.join(root, "scripts", "verify-deploy.sh"))

  // The single source of truth the guard must read.
  const dataDir = path.join(root, "engine", "packages", "app", "src", "data")
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    path.join(dataDir, "fabula-changelog.ts"),
    srcVer === null
      ? `// synthetic changelog with no version declaration\nexport const CHANGELOG = []\n`
      : `// synthetic changelog\nexport const FABULA_VERSION = "${srcVer}"\nexport const CHANGELOG = [{ version: "${srcVer}", date: "2026-01-01", items: [] }]\n`,
  )

  // Engine source that predates the binary, so the timestamp section stays green.
  const srcDir = path.join(root, "engine/packages/opencode/src")
  mkdirSync(srcDir, { recursive: true })
  const srcFile = path.join(srcDir, "index.ts")
  writeFileSync(srcFile, "export {}\n")
  const past = new Date("2020-01-01T00:00:00Z")
  utimesSync(srcFile, past, past)

  // A runnable "engine binary" whose bytes carry every marker plus the changelog payload in the
  // same shape the real bundler emits it (`version:"X",date`), so the guard can read back what
  // the binary ACTUALLY carries when the numbers disagree.
  mkdirSync(path.join(root, "bin"))
  const bin = path.join(root, "bin", "fabula")
  writeFileSync(
    bin,
    [
      "#!/bin/bash",
      "# synthetic engine for the deploy gate — the markers the guard probes for:",
      ...MARKERS.map((m) => `# ${m}`),
      `# embedded frontend payload: {version:"${binVer}",date:"2026-01-01",items:[]} "${binVer}"`,
      `echo "synthetic-engine ${binVer}"`,
      "",
    ].join("\n"),
  )
  chmodSync(bin, 0o755)

  if (distVer !== null) {
    const assets = path.join(root, "engine", "packages", "app", "dist", "assets")
    mkdirSync(assets, { recursive: true })
    writeFileSync(
      path.join(assets, "index-SYNTH.js"),
      `const L=[{version:"${distVer}",date:"2026-01-01",items:[]}];export{L};\n`,
    )
  }

  if (plistVer !== null) {
    const contents = path.join(root, "FABULA-LLM-5.app", "Contents")
    mkdirSync(contents, { recursive: true })
    writeFileSync(
      path.join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>FABULA-LLM-5</string>
  <key>CFBundleVersion</key><string>${plistVer}</string>
  <key>CFBundleShortVersionString</key><string>${plistVer}</string>
</dict></plist>
`,
    )
  }

  return root
}

// Run the tree's own copy exactly as deployed. PATH is pinned to the system dirs so the developer's
// real `fabula` shim never leaks into the synthetic tree's shim check.
function runVerify(root: string): { code: number; out: string } {
  const r = spawnSync("/bin/bash", [path.join(root, "scripts", "verify-deploy.sh")], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
  })
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") }
}

test.if(IS_MAC)("marker extraction sees the script's marker list (the synthetic binary depends on it)", () => {
  expect(MARKERS.length).toBeGreaterThan(5)
})

test.if(IS_MAC)("a tree whose three artifacts all carry the declared version is FRESH, one report line each", () => {
  const { code, out } = runVerify(makeTree())
  expect(out).toContain("✅ frontend dist carries 7.7.7")
  expect(out).toContain("✅ engine binary carries 7.7.7")
  expect(out).toContain("✅ app bundle Info.plist carries 7.7.7")
  expect(out).toContain("DEPLOY: FRESH")
  expect(code).toBe(0)
})

test.if(IS_MAC)("frontend dist carrying another version is STALE and the report names what dist actually carries", () => {
  const { code, out } = runVerify(makeTree({ distVer: "9.9.9" }))
  expect(out).toContain("❌ frontend dist carries 9.9.9, source declares 7.7.7")
  expect(out).toContain("✅ engine binary carries 7.7.7") // the lie stays isolated to one check
  expect(out).toContain("✅ app bundle Info.plist carries 7.7.7")
  expect(out).toContain("DEPLOY: STALE")
  expect(code).not.toBe(0)
})

test.if(IS_MAC)("an engine binary carrying another version is STALE and the report names what the bytes actually carry", () => {
  const { code, out } = runVerify(makeTree({ binVer: "9.9.9" }))
  expect(out).toContain("❌ engine binary carries 9.9.9, source declares 7.7.7")
  expect(out).toContain("✅ frontend dist carries 7.7.7")
  expect(out).toContain("✅ app bundle Info.plist carries 7.7.7")
  expect(out).toContain("DEPLOY: STALE")
  expect(code).not.toBe(0)
})

test.if(IS_MAC)("an app bundle stamped with another version is STALE and the report names the stamped version", () => {
  const { code, out } = runVerify(makeTree({ plistVer: "9.9.9" }))
  expect(out).toContain("❌ app bundle Info.plist carries 9.9.9, source declares 7.7.7")
  expect(out).toContain("✅ frontend dist carries 7.7.7")
  expect(out).toContain("✅ engine binary carries 7.7.7")
  expect(out).toContain("DEPLOY: STALE")
  expect(code).not.toBe(0)
})

test.if(IS_MAC)("a tree with no built frontend dist is STALE — absence is a finding, not a skip", () => {
  const { code, out } = runVerify(makeTree({ distVer: null }))
  expect(out).toContain("❌ frontend dist has no assets/index-*.js")
  expect(out).toContain("DEPLOY: STALE")
  expect(code).not.toBe(0)
})

test.if(IS_MAC)("a tree with no app bundle is STALE — absence is a finding, not a skip", () => {
  const { code, out } = runVerify(makeTree({ plistVer: null }))
  expect(out).toContain("❌ app bundle has no Info.plist")
  expect(out).toContain("DEPLOY: STALE")
  expect(code).not.toBe(0)
})

test.if(IS_MAC)("a changelog source with no FABULA_VERSION is STALE — the guard refuses to verify against nothing", () => {
  const { code, out } = runVerify(makeTree({ srcVer: null }))
  expect(out).toContain("❌ no FABULA_VERSION in engine/packages/app/src/data/fabula-changelog.ts")
  expect(out).toContain("DEPLOY: STALE")
  expect(code).not.toBe(0)
})
