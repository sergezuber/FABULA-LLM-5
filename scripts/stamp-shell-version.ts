#!/usr/bin/env bun
/**
 * Write the declared version into the two TRACKED files the desktop shell's toolchain reads.
 *
 * Cargo and Tauri both require the version inside their own manifest, so it necessarily lives there as
 * well as in `fabula-changelog.ts`. That makes those two files a place the number can LAG — and it did:
 * stamping happened inside `shell/build.sh`, which only ever runs where the shell is built. On macOS the
 * top-level build compiles the Swift host instead, so the shell manifests were never touched, and every
 * commit from this machine carried a version two waves behind the source. Linux and Windows CI then built
 * exactly what was committed, and the deploy check — correctly — reported that the package and the
 * installer did not carry the declared version.
 *
 * So stamping is its own step, called by every build on every platform and by CI before it compiles.
 * Idempotent, and it says what it changed rather than passing in silence.
 *
 *   bun scripts/stamp-shell-version.ts          # stamp
 *   bun scripts/stamp-shell-version.ts --check   # exit 1 if the files lag, change nothing
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const SOURCE = path.join(ROOT, "engine/packages/app/src/data/fabula-changelog.ts")

export function declaredVersion(text: string): string | null {
  return /^export const FABULA_VERSION = "(.*)"$/m.exec(text)?.[1] ?? null
}

/** The package's own version, never a dependency's — hence anchoring to the start of a line. */
export function stampCargo(text: string, version: string): string {
  return text.replace(/^version = "[^"]*"/m, `version = "${version}"`)
}

export function stampTauri(text: string, version: string): string {
  return text.replace(/"version": "[^"]*"/, `"version": "${version}"`)
}

export function readVersions(cargo: string, tauri: string): { cargo: string | null; tauri: string | null } {
  return {
    cargo: /^version = "([^"]*)"/m.exec(cargo)?.[1] ?? null,
    tauri: /"version": "([^"]*)"/.exec(tauri)?.[1] ?? null,
  }
}

if (import.meta.main) {
  const version = declaredVersion(readFileSync(SOURCE, "utf8"))
  if (!version) {
    console.error("FAIL: no FABULA_VERSION in the changelog source — nothing to stamp")
    process.exit(1)
  }

  const files = {
    cargo: path.join(ROOT, "shell/Cargo.toml"),
    tauri: path.join(ROOT, "shell/tauri.conf.json"),
  }
  const before = { cargo: readFileSync(files.cargo, "utf8"), tauri: readFileSync(files.tauri, "utf8") }
  const after = { cargo: stampCargo(before.cargo, version), tauri: stampTauri(before.tauri, version) }
  const carried = readVersions(before.cargo, before.tauri)

  if (process.argv.includes("--check")) {
    const lagging = Object.entries(carried).filter(([, v]) => v !== version)
    if (lagging.length === 0) {
      console.log(`shell manifests carry ${version}`)
      process.exit(0)
    }
    for (const [name, v] of lagging) console.error(`shell ${name} carries ${v}, the source declares ${version}`)
    process.exit(1)
  }

  for (const key of ["cargo", "tauri"] as const) {
    if (after[key] === before[key]) continue
    writeFileSync(files[key], after[key])
    console.log(`stamped shell ${key}: ${carried[key]} -> ${version}`)
  }
  if (after.cargo === before.cargo && after.tauri === before.tauri) console.log(`shell manifests already carry ${version}`)
}
