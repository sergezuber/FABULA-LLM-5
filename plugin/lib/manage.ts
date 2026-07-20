// FABULA-LLM-5 — plugin management + dependency helpers (pure-ish; shells out to check/install deps).
// Shared by fabula-manage.ts (the in-app tool), scripts/install-deps.ts (the installer), and lib/registry.ts.

import { execFile } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { MANIFEST, allDeps, pluginById, type Dep, type PluginMeta } from "./manifest"

/** repo root = plugin/lib/manage.ts → up 3. realpathSync resolves the ~/.config/mimocode/plugin symlink. */
export function repoRoot(): string {
  if (process.env.FABULA_REPO) return process.env.FABULA_REPO
  const here = realpathSync(fileURLToPath(import.meta.url)) // .../plugin/lib/manage.ts (real path)
  return dirname(dirname(dirname(here)))
}

function sh(cmd: string, timeoutMs = 600000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("/bin/bash", ["-lc", cmd], { timeout: timeoutMs, cwd: repoRoot(), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: ((stdout || "") + (stderr || "")).trim() })
    })
  })
}

export type DepStatus = { dep: Dep; present: boolean; checked: boolean }

/** Run a dependency's check command (exit 0 = present). No check = treated as present (builtin/manual). */
export async function checkDep(dep: Dep): Promise<DepStatus> {
  if (!dep.check) return { dep, present: true, checked: false }
  const r = await sh(dep.check, 30000)
  return { dep, present: r.ok, checked: true }
}

/** Install a dependency via its install command. Returns the combined output. */
export async function installDep(dep: Dep): Promise<{ ok: boolean; out: string; skipped?: string }> {
  if (dep.manual) return { ok: false, out: "", skipped: "manual step (guidance, not a runnable command)" }
  if (!dep.install) return { ok: false, out: "", skipped: "no install command (manual/builtin)" }
  const r = await sh(dep.install)
  // re-check after install
  const after = await checkDep(dep)
  return { ok: after.present || r.ok, out: r.out }
}

export type PluginStatus = {
  meta: PluginMeta
  enabled: boolean
  deps: DepStatus[]
  missingRequired: string[]
  missingOptional: string[]
}

export async function pluginStatus(meta: PluginMeta, enabled: boolean): Promise<PluginStatus> {
  const deps = await Promise.all(meta.deps.map(checkDep))
  const missingRequired = deps.filter((d) => !d.present && d.dep.required).map((d) => d.dep.name)
  const missingOptional = deps.filter((d) => !d.present && !d.dep.required).map((d) => d.dep.name)
  return { meta, enabled, deps, missingRequired, missingOptional }
}

// ── enable/disable state (external — never touches the repo) ──────────────────
export function statePath(): string {
  // Must resolve to the SAME file the engine's /global/fabula/plugins route reads/writes
  // (Global.Path.config/fabula-state.json). The engine app id is "fabula"
  // (engine/packages/shared/src/global.ts: APP="fabula"), so the config dir is ~/.config/fabula —
  // NOT ~/.config/mimocode. Reading the wrong path made the UI enable/disable toggle and the plugin's
  // own self-gating disagree. FABULA_PLUGIN_STATE overrides (used by hermetic tests).
  return process.env.FABULA_PLUGIN_STATE ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fabula", "fabula-state.json")
}
export interface State { disabled: string[]; enabled: string[] }
export function readState(): State {
  try {
    const j = JSON.parse(readFileSync(statePath(), "utf8"))
    return { disabled: Array.isArray(j?.disabled) ? j.disabled.map(String) : [], enabled: Array.isArray(j?.enabled) ? j.enabled.map(String) : [] }
  } catch { return { disabled: [], enabled: [] } }
}
export function writeState(st: State): void {
  const p = statePath()
  try { mkdirSync(dirname(p), { recursive: true }) } catch {}
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(st, null, 2))
  renameSync(tmp, p)
}
export function isEnabled(id: string): boolean {
  const envOff = (process.env.FABULA_DISABLE || "").split(",").map((s) => s.trim()).filter(Boolean)
  if (envOff.includes(id)) return false
  const st = readState()
  if (st.disabled.includes(id)) return false
  if (st.enabled.includes(id)) return true
  return pluginById(id)?.defaultEnabled ?? true
}
/** Wrap an expression-body plugin factory's return value: `=> gate("id", ({...}))` → {} when disabled. */
export function gate<T>(id: string, plugin: T): T | Record<string, never> {
  return isEnabled(id) ? plugin : {}
}
/**
 * Plugins the AGENT may not switch off. These are the supervision layer itself: the guards that contain
 * the run, and the gates that decide whether "done" is proven. A model that can disable them can hand
 * itself an unguarded, unverified run — and the entire premise here is that the guarantees come from the
 * harness rather than from the model choosing to keep them on.
 *
 * The OWNER may still disable any of them (the app's Plugins panel, `manage-cli`, `FABULA_DISABLE`).
 * This is about who is asking, not about making the switch unreachable.
 */
export const AGENT_PROTECTED = ["security", "reproduce-gate", "change-quiz", "rewind", "reliability"] as const

export type ToggleOrigin = "owner" | "agent"

export function setEnabled(id: string, on: boolean, origin: ToggleOrigin = "owner"): State {
  if (!on && origin === "agent" && (AGENT_PROTECTED as readonly string[]).includes(id)) {
    // Refused, and deliberately not silently: the caller reports it, so an attempt is visible rather
    // than looking like it worked.
    throw new Error(
      `"${id}" is part of the supervision layer and cannot be disabled from inside the run. ` +
        `The owner can turn it off in the app (Settings ▸ Plugins), with manage-cli, or via FABULA_DISABLE.`,
    )
  }
  return setEnabledUnchecked(id, on)
}

function setEnabledUnchecked(id: string, on: boolean): State {
  const st = readState()
  st.disabled = st.disabled.filter((x) => x !== id)
  st.enabled = st.enabled.filter((x) => x !== id)
  if (on) st.enabled.push(id)
  else st.disabled.push(id)
  writeState(st)
  return st
}

export { MANIFEST, allDeps, pluginById }
