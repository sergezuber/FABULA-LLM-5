// Permission modes + persisted allow-list (Item 6). Enforced in the security before-hook (the only
// gate that fires for plugin tools — permission.ask does not). Pure logic + a JSON store.
//
// Modes:
//   default     — the normal guards apply.
//   plan        — read-only planning: every WRITE tool is blocked (propose, don't touch).
//   acceptEdits — file edits are pre-approved (skip the write-path guard's soft blocks) but shell/SSRF
//                 guards still apply.
//   bypass      — skip FABULA's guards for this run (explicit "I know what I'm doing"); still logged.
//
// Persisted allow-list: a user can bless a specific command signature so the guards skip it, without
// turning off all guards globally (e.g. "always allow `git push` here").
//
// Denial vs error: a policy block is NOT a tool failure. Block messages are tagged so the model adapts
// (do not retry the identical call) instead of treating it as a retryable error.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { isWriteTool } from "./roles"

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass"
/** Who put the run in its current mode. Only an owner-set `bypass` actually disarms the guards. */
export type ModeOrigin = "owner" | "agent"
const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"]

interface Store { mode?: PermissionMode; allow?: Record<string, boolean> }

function storeFile(): string {
  if (process.env.FABULA_PERMISSIONS_FILE) return process.env.FABULA_PERMISSIONS_FILE
  const cfg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  // Must match where the engine's /global/fabula/pmode route WRITES this file
  // (Global.Path.config/fabula-permissions.json). The engine app id is "fabula" (global.ts: APP="fabula"),
  // so the config dir is ~/.config/fabula — NOT ~/.config/mimocode. Reading the wrong path made the UI
  // permission-mode + allow-list set by the user never reach the security guards (a security desync).
  return path.join(cfg, "fabula", "fabula-permissions.json")
}

function load(): Store {
  try { return JSON.parse(readFileSync(storeFile(), "utf8")) } catch { return {} }
}
function save(s: Store): void {
  const f = storeFile()
  mkdirSync(path.dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(s, null, 2))
}

/** Current mode: persisted store > FABULA_PERMISSION_MODE env > "default". */
export function permissionMode(): PermissionMode {
  const s = load()
  if (s.mode && MODES.includes(s.mode)) return s.mode
  const env = (process.env.FABULA_PERMISSION_MODE || "").trim() as PermissionMode
  return MODES.includes(env) ? env : "default"
}

/**
 * Set the run's permission mode. `origin` records WHO set it, and that is load-bearing rather than
 * decorative: an agent-set `bypass` is stored and reported but does not disarm the guards (see
 * `shouldBypassGuards`). Everything else an agent sets — plan, acceptEdits, back to default — takes
 * effect normally, because those only ever RESTRICT it.
 */
export function setPermissionMode(mode: string, origin: ModeOrigin = "owner"): { ok: boolean; mode?: PermissionMode; error?: string; note?: string } {
  if (!MODES.includes(mode as PermissionMode)) return { ok: false, error: `unknown mode "${mode}" (use: ${MODES.join(", ")})` }
  const s = load()
  s.mode = mode as PermissionMode
  s.modeOrigin = origin
  save(s)
  if (mode === "bypass" && origin === "agent") {
    return {
      ok: true,
      mode: mode as PermissionMode,
      note:
        "recorded, but NOT honoured: bypass disables the command/SSRF/path guards for the whole run, so it " +
        "is an owner decision. Set it from the app (Settings ▸ Permissions) or FABULA_PERMISSION_MODE if you " +
        "really want the guards off; the guards stay ON for this run.",
    }
  }
  return { ok: true, mode: mode as PermissionMode }
}

/** Was the current `bypass` set by the agent rather than the owner? Legacy stores carry no origin at
 *  all — those are treated as OWNER-set, because they predate this field and were written by the UI. */
export function bypassWasSetByAgent(): boolean {
  return load().modeOrigin === "agent"
}

/** A stable signature for a tool call, used as the allow-list key. */
export function commandSignature(tool: string | undefined, args: any): string {
  if (!tool) return ""
  if (tool === "bash" || tool === "bash_tool") {
    const cmd = String(args?.command ?? args?.cmd ?? "").replace(/\s+/g, " ").trim()
    return `bash:${cmd}`
  }
  const p = args?.path ?? args?.filePath ?? args?.file ?? args?.url ?? ""
  return `${tool}:${p}`
}

export function isCommandAllowed(sig: string): boolean {
  if (!sig) return false
  return !!load().allow?.[sig]
}

export function allowCommand(sig: string): { ok: boolean; sig: string } {
  const s = load(); s.allow = s.allow || {}; s.allow[sig] = true; save(s)
  return { ok: true, sig }
}

export function revokeCommand(sig: string): { ok: boolean } {
  const s = load(); if (s.allow) { delete s.allow[sig]; save(s) }
  return { ok: true }
}

/** In `plan` mode, a write tool is blocked. */
export function isPlanBlocked(tool: string | undefined, args: any): boolean {
  return permissionMode() === "plan" && isWriteTool(tool, args)
}

/**
 * Guards are skipped when the whole run is in `bypass` mode OR this exact command was pre-allowed.
 *
 * `bypass` is an OWNER decision, never an agent one. It disables the command guard, the SSRF guard and
 * the path guard for the rest of the run, so a model that can set it can disarm the entire supervision
 * layer that exists to contain it — and the whole thesis of this harness is that the guarantees come
 * from the harness, not from the model's good intentions. So the mode is honoured ONLY when it was set
 * outside the agent's reach: the env var, or the UI/CLI writing the persisted store. A mode the AGENT
 * set through `set_permission_mode` is recorded, surfaced, and ignored here.
 */
export function shouldBypassGuards(tool: string | undefined, args: any): boolean {
  if (permissionMode() === "bypass" && !bypassWasSetByAgent()) return true
  return isCommandAllowed(commandSignature(tool, args))
}

/** True when edits should be pre-approved (acceptEdits mode) — used to soften the write-path guard. */
export function editsPreApproved(): boolean {
  return permissionMode() === "acceptEdits"
}

export function planBlockMessage(tool: string | undefined): string {
  return `[DENIED: plan mode] "${tool}" would modify the workspace, but the session is in plan mode ` +
    `(read-only planning). Propose the change and wait — do not retry; switch out of plan mode to apply it.`
}

/** Test-only: reset any env influence is the caller's job; this clears the persisted store path. */
export function _permissionsStoreFile(): string { return storeFile() }
