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
// NB the memory store is deliberately NOT pinned here. `storeDir()` carries its own test-runner guard
// (no XDG_DATA_HOME + a test runner → tmpdir, never the developer's home), and pinning an ABSOLUTE
// path here OUTRANKED that: a rig setting its own XDG_DATA_HOME had its writes land outside its own
// data dir, so a case asserting "the real hooks moved something" saw nothing move and failed
// deterministically. Two guards for one hazard is not belt-and-braces when the outer one silences the
// inner one — the override must stay available to a caller who names a directory on purpose.

// No test may reach the NETWORK by accident. The W6 harness-fired escalation calls a real cloud endpoint
// from a `tool.execute.after` hook the moment a red streak forms — and `secondOpinion` correctly returns
// early only when NO cloud provider is configured. On a machine that HAS one (this one does), the unit
// suite was making live outbound calls to a paid endpoint on every run: measured as a bimodal
// rewind-wiring test, 0.7s when the call resolved fast and a hard 5s timeout kill when it did not, three
// different cases failing across three runs. Tests were paying real money and reporting it as a flake.
// A mechanism that reaches the network must be OFF under a test runner; a test that wants it sets it back.
process.env.FABULA_ESCALATE_AUTO = process.env.FABULA_ESCALATE_AUTO ?? "0"
// NB this list is an ALLOW-LIST of stores we happen to know about, and that is its weakness: a NEW
// store added later inherits none of this and silently writes to the developer's home instead. That is
// not hypothetical — the W7 memory store did exactly that, accumulating 71 junk records in the real
// ~/.local/share/fabula/memstore while its own tests read a temp dir and reported the records missing.
// Any new on-disk store MUST be added here AND carry its own test-runner guard in its path resolver,
// because whichever of the two someone forgets, the other still holds.
