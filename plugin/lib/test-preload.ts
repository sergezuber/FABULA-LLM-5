// Hermetic test environment (loaded via bunfig.toml [test].preload).
//
// ⚠️ MUST live in lib/ — the ENGINE scans {plugin,plugins}/*.{ts,js} and imports EVERY match as a
// plugin (config/plugin.ts load()). When this file sat at plugin/ root, its top-level side effect
// hijacked XDG_CONFIG_HOME/XDG_DATA_HOME for the WHOLE LIVE ENGINE process on every serve: plugin
// enable/disable state and permission modes silently read a throwaway temp dir, so default-off
// plugins could never be enabled. lib/ is not scanned; never move this back.
//
// FABULA persists two bits of on-disk state under $XDG_CONFIG_HOME/mimocode/ (falling back to
// ~/.config): the permission mode (fabula-permissions.json) and the plugin enable/disable list
// (fabula-state.json). Unit tests must NOT read the developer's machine state — e.g. a persisted
// permission `mode: "bypass"` (left over from a --dangerously-skip-permissions run) makes
// shouldBypassGuards() return true, so every security before-hook returns without throwing and all
// "blocks rm -rf / SSRF / backdoor-write" assertions fail on that machine while passing in CI.
//
// Redirect XDG_CONFIG_HOME to a throwaway temp dir so every test starts from clean default state.
// Tests that need specific state set their own FABULA_PERMISSIONS_FILE / FABULA_PLUGIN_STATE.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "fabula-test-cfg-"))
process.env.XDG_CONFIG_HOME = dir

// Also isolate the on-disk DATA stores so wiring tests that fire a checkpoint/handoff/ops write (via a
// real plugin before/after hook) never litter the developer's LIVE ~/.local/share/fabula (the engine
// data dir — home to the real shadow-git undo history). Each store honors its own override env; point
// them at a throwaway temp dir. (We deliberately do NOT touch XDG_DATA_HOME, so the opt-in "live" DB
// tests can still find the real fabula.db when it exists.)
const data = mkdtempSync(join(tmpdir(), "fabula-test-data-"))
process.env.FABULA_CHECKPOINT_DIR = join(data, "checkpoints")
process.env.FABULA_HANDOFF_DIR = join(data, "handoff")
process.env.FABULA_OPS_DIR = join(data, "ops")
