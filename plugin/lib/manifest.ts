// FABULA-LLM-5 — plugin + dependency MANIFEST (single source of truth).
//
// Every plugin and EVERY artifact it needs is declared here. Consumed by:
//   - lib/manage.ts          — user enable/disable state (self-gating)
//   - fabula-manage.ts       — the in-app management tool (list / enable / disable / install deps)
//   - scripts/install-deps.ts — the installer that ships with the app (checks + installs missing deps)
//   - docs                   — README / .env.example are kept in sync with this file
//
// Rule: a tool/feature that needs an artifact MUST list it here. "Plugin exists but a dependency is
// missing" is a bug — the manifest makes every dependency explicit, checkable, and installable.

export type DepKind = "npm" | "system" | "python" | "service" | "docker" | "builtin"

export interface Dep {
  kind: DepKind
  name: string
  /** required = the plugin's PRIMARY function fails without it; optional = a fallback exists or it's secondary. */
  required: boolean
  /** which tool/feature needs it. */
  purpose: string
  /** shell that exits 0 iff the dependency is present. */
  check?: string
  /** shell that installs it on macOS (idempotent where possible). */
  install?: string
  note?: string
}

export interface PluginMeta {
  id: string // stable short id used in state/registry, e.g. "tools", "graph"
  file: string // plugin/<file>
  name: string
  description: string
  /** user-facing tools this plugin registers (empty = hooks only, no callable tools). */
  tools: string[]
  deps: Dep[]
  /** enabled unless the user turns it off. Core plugins default to true. */
  defaultEnabled: boolean
  /** core plugins are recommended-always (reliability/security/etc.); still user-toggleable. */
  core?: boolean
}

// ── shared dependency fragments ──────────────────────────────────────────────
const NPM_BUNDLED: Dep[] = [
  { kind: "npm", name: "@mimo-ai/plugin", required: true, purpose: "plugin SDK (tool/hook API)", check: "test -d plugin/node_modules/@mimo-ai/plugin", install: "cd plugin && bun install" },
]
const LOCAL_MODEL: Dep = {
  kind: "service", name: "LM Studio (+ :1235 adapter)", required: true,
  purpose: "the local model the agent runs on", check: "curl -sf http://localhost:1235/v1/models >/dev/null",
  install: "Install LM Studio (https://lmstudio.ai), load a tool-calling model, then start proxy/lmstudio-adapter.py",
  note: "The :1235 Python adapter is mandatory (json_object→json_schema + reasoning→content).",
}

export const MANIFEST: PluginMeta[] = [
  {
    id: "tools", file: "fabula-tools.ts", name: "Core tools", core: true, defaultEnabled: true,
    description: "The core tool belt: web, shell/code, file edits, search, weather, places, mixture-of-agents.",
    tools: ["web_search", "web_fetch", "image_search", "weather_fetch", "places_search", "bash_tool", "view", "str_replace", "create_file", "note_append", "present_files", "verify_done", "mixture_of_agents", "session_search", "execute_code", "save_skill", "cost_report", "batch_run", "search_mcp_registry", "suggest_connectors", "recommend_LLM_apps", "fetch_sports_data"],
    deps: [
      ...NPM_BUNDLED,
      { kind: "npm", name: "defuddle", required: true, purpose: "web_fetch HTML→markdown", check: "test -d plugin/node_modules/defuddle", install: "cd plugin && bun install" },
      { kind: "npm", name: "linkedom", required: true, purpose: "web_fetch DOM parsing", check: "test -d plugin/node_modules/linkedom", install: "cd plugin && bun install" },
      { kind: "npm", name: "unpdf", required: true, purpose: "web_fetch PDF extraction", check: "test -d plugin/node_modules/unpdf", install: "cd plugin && bun install" },
      { kind: "service", name: "SearXNG", required: false, purpose: "web_search / image_search backend", check: "curl -sf ${SEARXNG_URL:-http://localhost:8888}/ >/dev/null", install: "Run a SearXNG instance (docker run searxng/searxng) and set SEARXNG_URL", note: "Without it, web_search/image_search return a clear 'not configured' message." },
      { kind: "docker", name: "Docker", required: false, purpose: "execute_code sandbox (FABULA_CODE_SANDBOX=docker)", check: "docker version --format '{{.Server.Version}}' >/dev/null 2>&1", install: "brew install --cask docker  # then launch Docker Desktop once", note: "Optional: execute_code runs directly if Docker is absent and the command is allowed by the guards." },
    ],
  },
  {
    id: "graph", file: "fabula-graph.ts", name: "Workflow graph", core: true, defaultEnabled: true,
    description: "Plan a task into ≤5 isolated steps, run them (parallel where independent), synthesize. Opt-in local→cloud router.",
    tools: ["workflow_graph"],
    deps: [...NPM_BUNDLED, LOCAL_MODEL],
  },
  {
    id: "handoff", file: "fabula-handoff.ts", name: "Handoff artifacts", defaultEnabled: true,
    description: "Durable, threat-scanned handoff artifacts passed between steps/sessions.",
    tools: ["save_handoff", "read_handoff", "list_handoffs"],
    deps: [...NPM_BUNDLED],
  },
  {
    id: "checkpoint", file: "fabula-checkpoint.ts", name: "Checkpoints & undo", defaultEnabled: true,
    description: "Shadow-git snapshots before each edit + restore/diff — undo the agent's changes without touching your real git.",
    tools: ["list_checkpoints", "restore_checkpoint", "diff_checkpoints"],
    deps: [
      ...NPM_BUNDLED,
      { kind: "system", name: "git", required: true, purpose: "shadow-git checkpoint store (separate from your repo)", check: "git --version >/dev/null 2>&1", install: "Install git (xcode-select --install, or brew install git)." },
    ],
  },
  {
    id: "reliability", file: "fabula-reliability.ts", name: "Reliability", core: true, defaultEnabled: true,
    description: "Loop-guard, tool-arg repair, ntfy push notifications, optional actor role preambles.",
    tools: [],
    deps: [
      ...NPM_BUNDLED,
      { kind: "service", name: "ntfy", required: false, purpose: "push notifications (FABULA_NTFY_TOPIC)", check: "true", install: "Set FABULA_NTFY_TOPIC and subscribe in the ntfy app — no install needed (uses ntfy.sh by default).", note: "Disabled until FABULA_NTFY_TOPIC is set." },
    ],
  },
  {
    id: "security", file: "fabula-security.ts", name: "Security", core: true, defaultEnabled: true,
    description: "SSRF guards, secret redaction, untrusted-result wrapping, command/approval guards, permission modes.",
    tools: ["set_permission_mode", "allow_command"],
    deps: [...NPM_BUNDLED],
  },
  {
    id: "context", file: "fabula-context.ts", name: "Context & memory", core: true, defaultEnabled: true,
    description: "Curated-memory injection and single-system-message collapse for strict endpoints.",
    tools: [],
    deps: [...NPM_BUNDLED],
  },
  {
    id: "ops", file: "fabula-ops.ts", name: "Scheduling & ops", defaultEnabled: true,
    description: "Recurring/one-off jobs via launchd, a run-ledger with overdue detection, notifications.",
    tools: ["schedule_task", "list_scheduled", "cancel_scheduled", "send_notification"],
    deps: [
      ...NPM_BUNDLED,
      { kind: "builtin", name: "launchd", required: true, purpose: "scheduling backend (macOS)", check: "command -v launchctl >/dev/null", note: "Built into macOS." },
      { kind: "system", name: "bun", required: false, purpose: "runs the scheduled-job helper (FABULA_BUN_BIN)", check: "command -v bun >/dev/null", install: "brew install oven-sh/bun/bun" },
    ],
  },
  {
    id: "multimodal", file: "fabula-multimodal.ts", name: "Multimodal (vision/TTS/STT)", defaultEnabled: true,
    description: "Image analysis, text-to-speech, and speech-to-text.",
    tools: ["vision_analyze", "text_to_speech", "transcribe_audio"],
    deps: [
      ...NPM_BUNDLED,
      { kind: "service", name: "vision endpoint (VLM)", required: false, purpose: "vision_analyze", check: "true", install: "Load a VLM in LM Studio (set LMSTUDIO_VLM_MODEL) or set FABULA_VISION_URL+FABULA_VISION_MODEL", note: "vision_analyze returns a clear message if no VLM is configured." },
      { kind: "builtin", name: "say (macOS TTS)", required: false, purpose: "text_to_speech fallback", check: "command -v say >/dev/null", note: "Built into macOS — text_to_speech works out of the box (Milena voice for Russian)." },
      { kind: "system", name: "piper", required: false, purpose: "text_to_speech (higher quality than say)", check: "command -v piper >/dev/null || test -n \"$FABULA_PIPER_BIN\"", install: "pip3 install piper-tts  # then set FABULA_PIPER_VOICE to a .onnx voice", note: "Optional — say is used if piper is absent." },
      { kind: "python", name: "faster-whisper", required: false, purpose: "transcribe_audio (speech-to-text)", check: "python3 -c 'import faster_whisper' 2>/dev/null || command -v whisper >/dev/null", install: "pip3 install faster-whisper", note: "No built-in macOS fallback — transcribe_audio needs this." },
    ],
  },
  {
    id: "vision", file: "fabula-vision.ts", name: "Vision capability sync", defaultEnabled: true,
    description: "Detects which loaded models are vision-capable (LM Studio type:vlm) and syncs the flag.",
    tools: ["sync_model_vision"],
    deps: [...NPM_BUNDLED, { kind: "service", name: "LM Studio", required: false, purpose: "model vision query", check: "curl -sf http://localhost:1234/v1/models >/dev/null || curl -sf http://localhost:1235/v1/models >/dev/null" }],
  },
  {
    id: "browser", file: "fabula-browser.ts", name: "Browser automation", defaultEnabled: true,
    description: "Drive a real browser: navigate, click, type, snapshot, vision, CDP.",
    tools: ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_scroll", "browser_vision", "browser_back", "browser_press", "browser_get_images", "browser_console", "browser_dialog", "browser_cdp", "browser_close"],
    deps: [
      ...NPM_BUNDLED,
      { kind: "npm", name: "playwright", required: true, purpose: "browser driver", check: "test -d plugin/node_modules/playwright", install: "cd plugin && bun install" },
      { kind: "system", name: "chromium (playwright browser)", required: true, purpose: "the actual browser binary", check: "ls -d \"$HOME/Library/Caches/ms-playwright/\"chromium* >/dev/null 2>&1", install: "cd plugin && npx playwright install chromium", note: "playwright is bundled, but the Chromium binary (~150 MB) must be downloaded once." },
    ],
  },
  {
    id: "readfloor", file: "fabula-readfloor.ts", name: "Read-limit floor", core: true, defaultEnabled: true,
    description: "Raises small default read limits so the agent reads whole files (built for large context windows).",
    tools: [], deps: [...NPM_BUNDLED],
  },
  {
    id: "unknowns", file: "fabula-unknowns.ts", name: "Finding unknowns", defaultEnabled: true,
    description: "Actively closes the prompt↔codebase gap (Thariq Shihipar's 'finding your unknowns', built as hooks not skills): tool reference_hunt (grep the repo for analogous code, digest its contract via the aux model) + surface_unknowns (blindspot pass grounded in real code → refined task) + a reference-first steer that fires on the first source edit made without a reference/unknowns pass. Kill-switch: FABULA_REFERENCE_FIRST=0.",
    tools: ["reference_hunt", "surface_unknowns"], deps: [...NPM_BUNDLED],
  },
  {
    id: "brainstorm", file: "fabula-brainstorm.ts", name: "Brainstorm prototypes", defaultEnabled: true,
    description: "brainstorm-prototypes (Thariq Shihipar): tool brainstorm_prototypes generates 3-5 wildly different throwaway design variations to react to, each labeled with the belief it bets on and its tradeoff — surfaces the implicit preference faster than more questions. For design/UX/API-shape choices before committing.",
    tools: ["brainstorm_prototypes"], deps: [...NPM_BUNDLED],
  },
  {
    id: "shipnotes", file: "fabula-shipnotes.ts", name: "Implementation notes & pitch", defaultEnabled: true,
    description: "implementation-notes + pitch-packager (Thariq Shihipar): auto-captures the edit trail as you build (fires itself) + tool implementation_note to log a deviation/decision, then pitch_packager bundles the diff + notes into a DEMO-FIRST reviewer buy-in doc (what it does + one step to see it, why, decisions, risks).",
    tools: ["implementation_note", "pitch_packager"], deps: [...NPM_BUNDLED],
  },
  {
    id: "interview", file: "fabula-interview.ts", name: "Interview (unknowns triage)", defaultEnabled: true,
    description: "interview-me built active (Thariq Shihipar): tool interview_me triages a task's unknowns into code-answerable (resolve by reading) vs the ONE decision only the human can make (grounded in the real code), plus an auto-nudge that fires itself when a new task reads as underspecified. Kill-switch: FABULA_INTERVIEW_NUDGE=0.",
    tools: ["interview_me"], deps: [...NPM_BUNDLED],
  },
  {
    id: "change-quiz", file: "fabula-change-quiz.ts", name: "Change-quiz gate", defaultEnabled: true,
    description: "A comprehension gate (Thariq Shihipar's 'quiz before merge'): after a green verify with source changes, requires the agent to pass change_quiz — 3 questions about its OWN diff, graded against the diff by the aux model (no self-assessment theater) — before 'done' stands. Kill-switch: FABULA_CHANGE_QUIZ=0.",
    tools: ["change_quiz"], deps: [...NPM_BUNDLED],
  },
  {
    id: "reproduce-gate", file: "fabula-reproduce-gate.ts", name: "Reproduce-first gate", defaultEnabled: true,
    description: "Downgrades a green verify_done to NOT-DONE when source changed but no reproduction test exercises the new behavior — the #1 cause of plausible-but-wrong patches on SWE-bench Pro (proven on 479aa075). Kill-switch: FABULA_REPRODUCE_GATE=0.",
    tools: [], deps: [...NPM_BUNDLED],
  },
  {
    id: "learn", file: "fabula-learn.ts", name: "Learn (skill-packaging nudge)", defaultEnabled: true,
    description: "Closes the 'skills compound' loop as a light self-nudge: after the agent completes AND verifies a real multi-step change, a tool-result steer points at /distill so the fresh trajectory gets packaged into a reusable skill/command while it is fresh. The manual-trigger alternative to the guarded auto-distill pass — it never runs distill for you. Kill-switch: FABULA_LEARN_NUDGE=0.",
    tools: [], deps: [...NPM_BUNDLED],
  },
  {
    id: "selfextend", file: "fabula-selfextend.ts", name: "Self-extension (author tools)", defaultEnabled: true,
    description: "Lets the model author a NEW fabula plugin/tool for itself when a capability is missing (create_plugin). The harness scaffolds it and enforces the one-plugin-per-file contract deterministically before writing; it becomes callable after the next engine start. The supervised model grows its own supervised tool belt.",
    tools: ["create_plugin"], deps: [...NPM_BUNDLED],
  },
  {
    id: "coordinator", file: "fabula-coordinator.ts", name: "Coordinator (sub-receipt proof tree)", defaultEnabled: false,
    description: "A verified TEAM, not just an agent loop. When work is split across workers (spawned via the engine's own task/AgentTool), each leaves its own Proof-of-Done receipt; subreceipt_add joins them into a proof tree, and proof_tree renders the honest composite verdict — VERIFIED only if EVERY worker's receipt is VERIFIED, a single NOT DONE anywhere makes the whole run NOT DONE. That is supply-chain provenance for AI work (an SBOM for an agent trajectory): you prove not just that the result is right, but that every step, by every worker, was verified. State in .fabula/coordinator/tree.json (companion to the receipt — never modified); reuses the receipt parser. Off by default.",
    tools: ["subreceipt_add", "proof_tree"], deps: [...NPM_BUNDLED],
  },
  {
    id: "tool-router", file: "fabula-toolrouter.ts", name: "Tool router (per-task belt profiles, Context OS Phase 1)", defaultEnabled: true,
    description: "The Context OS per-task tool router: on every real user message it deterministically classifies the task (word-bounded verbatim tool mentions + BM25 over tool cards with RU/EN utterances, RRF fusion) into a PROFILE from a closed nested registry — coding / web-research / full — and stamps a per-SESSION belt that the engine reads when building tool schemas. Result: only the profile's tools reach the model (schemas are the #1 prefill cost), the tool set stays byte-stable within a task so the local model's KV-cache survives, and concurrent sessions never clobber each other (the old env mask stays as a static floor). Gate tools (verify_done, skill, …) are never maskable; a masked tool the model calls BY NAME still executes through a shadow dispatch — a router miss costs one roundtrip, never a blocked task. Gate PASSED on the real-model A/B bench (success 7/7 vs 6/7 off, prefill −2.3k/step, cache-breaks −23%) — ON by default; kill-switch: disable this toggle or unset FABULA_TOOL_ROUTER.",
    tools: ["expand_tools"], deps: [...NPM_BUNDLED],
  },
  {
    id: "buddy", file: "fabula-buddy.ts", name: "Buddy (a companion that grows from VERIFIED work)", defaultEnabled: false,
    description: "A small ASCII companion that sits with the project. Its look — species, rarity, eye, hat, base stats — is DETERMINISTIC from your user id (regenerated on every read, so a rename can't break it and you can't hand-edit your way to a rarer pet); you author only its name + one-line personality, once, at hatch. The FABULA twist, and the whole point: it grows ONLY from VERIFIED work. buddy shows it; buddy_hatch names it; buddy_feed feeds it a Proof-of-Done receipt — a PASSED receipt grants XP (base + reproduce/quiz gates + 10×witnesses + a SWE-bench bonus) and its gates bump matching stats, while a NOT DONE receipt grants nothing. A silent hook auto-feeds the latest receipt on every green verify_done, so the pet literally grows from proven work; only a level-up or the legendary upgrade surfaces a one-line note. Three published receipts each attested by ≥3 independent witnesses upgrade the pet to legendary — a badge you cannot fake. State in .fabula/buddy/state.json. Off by default; auto-feed kill-switch FABULA_BUDDY_AUTO=0.",
    tools: ["buddy", "buddy_hatch", "buddy_feed"], deps: [...NPM_BUNDLED],
  },
  {
    id: "relay", file: "fabula-relay.ts", name: "Cloud relay (escalation ladder → cloud writes the patch)", defaultEnabled: false,
    description: "The escalation rung beyond advice: when the local model stays stuck, relay_to_cloud has a STRONGER cloud model write the fix ITSELF as a complete unified diff (saved to .fabula/relay/patch.diff). The patch is NOT trusted — the model must apply it and re-run the SAME verify/reproduce/change-quiz gates; only a green gate makes it count. This is what lets FABULA honestly say the work will be done AND proven: NOT DONE is a transient rung, the ladder climbs until VERIFIED or the budget is spent (FABULA_RELAY_MAX_ATTEMPTS / _MAX_COST_USD / _MAX_TIME_MIN) or a single need-input question. Every attempt is appended to .fabula/relay/attempts.json (companion to the receipt — the receipt is never modified). Target via FABULA_RELAY_URL+FABULA_RELAY_MODEL or a cloud provider in the config. Off by default.",
    tools: ["relay_to_cloud"], deps: [...NPM_BUNDLED],
  },
  {
    id: "daemon", file: "fabula-daemon.ts", name: "Autonomous daemon (KAIROS posture + pacing + PR poll)", defaultEnabled: false,
    description: "The always-on autonomous posture. When FABULA_DAEMON=1 a system block turns the session into an autonomous worker (KAIROS): it paces itself with `sleep`, acts on its own judgment, and adapts to terminal focus (FABULA_TERMINAL_FOCUS=focused|unfocused → collaborate vs full autonomy). The FABULA twist: background 'done' still runs the same gates and mints a replayable receipt, so overnight autonomy can't lie. Tools: `sleep` (cache-aware pacing — staying under the 5-min prompt-cache window is cheap) and `check_pr_activity` (POLLS a GitHub PR via `gh` for NEW comments/check-runs since the last poll — honest polling, not a fabricated webhook subscription). Off unless FABULA_DAEMON=1; the tick/wake loop is the engine's (cron/wakeup).",
    tools: ["sleep", "check_pr_activity"], deps: [...NPM_BUNDLED],
  },
  {
    id: "witness", file: "fabula-witness.ts", name: "Cross-model witness (independent diff review)", defaultEnabled: false,
    description: "An INDEPENDENT model of a DIFFERENT architecture adversarially reviews the diff a local model just wrote. witness_diff sends the diff to a second model (FABULA_WITNESS_MODEL + FABULA_WITNESS_URL, or a cloud provider in the config) and returns CONFIRMED (correct + safe) or DISPUTED (a real problem, with the reason). Guards independence — a witness whose model id equals the author is refused. A confirmed witness is recorded as a companion attestation next to the receipt (.fabula/receipts/witnesses.json) WITHOUT modifying the receipt itself, so it composes with fabula-receipt. Not the author quizzing itself (that is change-quiz) — a second, orthogonal reader. Off by default; timeout FABULA_WITNESS_TIMEOUT_MS.",
    tools: ["witness_diff"], deps: [...NPM_BUNDLED],
  },
  {
    id: "registry", file: "fabula-registry.ts", name: "Proof registry (publish/verify/search)", defaultEnabled: false,
    description: "Turns a LOCAL Proof-of-Done receipt into something the world can find and re-verify. publish_receipt copies the last green run's receipt + patch into a content-addressed git store (id = SHA256(patch + verify cmd)) and pushes to FABULA_REGISTRY_REMOTE if set (returns the real public URL, else the local store path — never a fabricated link). verify_receipt replays a receipt by id/path/URL in a throwaway worktree at the recorded base and runs its verification command (VERIFIED / NOT DONE); untrusted http receipts run their own shell, so that needs FABULA_REGISTRY_VERIFY_UNTRUSTED=1 (ideally FABULA_CODE_SANDBOX=docker). search_receipts queries the store index. Off by default (experimental); store at FABULA_REGISTRY_DIR.",
    tools: ["publish_receipt", "verify_receipt", "search_receipts"], deps: [...NPM_BUNDLED],
  },
  {
    id: "escalate", file: "fabula-escalate.ts", name: "Cloud second-opinion escalation", defaultEnabled: true,
    description: "When the local model is stuck (the same fix keeps failing, or it can't find the root cause), escalate_to_cloud gets a second opinion from a stronger CLOUD model on the same problem — same context in, a concrete root cause + next step back — then the local model keeps driving. Requires a cloud provider in the config; the message normalization reuses the cross-provider replay core. Target via FABULA_ESCALATE_MODEL/FABULA_ESCALATE_PROVIDER.",
    tools: ["escalate_to_cloud"], deps: [...NPM_BUNDLED],
  },
  {
    id: "rewind", file: "fabula-rewind.ts", name: "Auto-rewind on repeated failure", defaultEnabled: true,
    description: "When each edit keeps the verify RED, the HARNESS reverts (LOCK 4): on a green verify_done it snapshots the good state, and after N consecutive red verifies it atomically restores the files to that last-green checkpoint (shadow-git, real .git untouched) and steers the model to try a DIFFERENT approach instead of looping on the same failing change. When the ladder is exhausted — no green anchor ever existed, or the rewind budget is spent and a fresh approach still fails — it surfaces the explicit terminal ❌ NOT DONE verdict (Greenpaper: no silent third state); a later green fully recovers the run. Kill-switch: FABULA_AUTO_REWIND=0; thresholds: FABULA_REWIND_THRESHOLD (default 2), FABULA_NOTDONE_THRESHOLD (default 4).",
    tools: [], deps: [...NPM_BUNDLED],
  },
  {
    id: "receipt", file: "fabula-receipt.ts", name: "Proof-of-Done receipt", defaultEnabled: true,
    description: "On a green verify_done that no other gate downgraded, mints a machine-readable Proof-of-Done receipt (Greenpaper contract): model in the socket, which gates fired and what each forced, the diff, the verification that passed, and a deterministic replay command — written to .fabula/receipts/. Read-only: never blocks or changes the verdict, only records it. Manual mint: mint_receipt. Kill-switch: FABULA_RECEIPT=0.",
    tools: ["mint_receipt"], deps: [...NPM_BUNDLED],
  },
  {
    id: "distill-guard", file: "fabula-distill-guard.ts", name: "Distill guard", core: true, defaultEnabled: true,
    description: "Blocks the harness's auto self-improvement pass on uncensored models (policy collision).",
    tools: [], deps: [...NPM_BUNDLED],
  },
  {
    id: "purge-hook", file: "fabula-purge-hook.ts", name: "Purge hook", core: true, defaultEnabled: true,
    description: "Fully purges a deleted chat's artifacts (privacy).",
    tools: [], deps: [...NPM_BUNDLED],
  },
  {
    id: "manage", file: "fabula-manage.ts", name: "Plugin manager", core: true, defaultEnabled: true,
    description: "Manage plugins: list status + dependency health, enable/disable, and install a plugin's deps. Cannot be disabled.",
    tools: ["list_plugins", "check_deps", "install_plugin_deps", "enable_plugin", "disable_plugin"],
    deps: [...NPM_BUNDLED],
  },
]

export function pluginById(id: string): PluginMeta | undefined {
  return MANIFEST.find((p) => p.id === id)
}
export function pluginByFile(file: string): PluginMeta | undefined {
  const base = file.split("/").pop() || file
  return MANIFEST.find((p) => p.file === base)
}
/** All distinct installable deps across plugins (deduped by name), for the installer. */
export function allDeps(): Dep[] {
  const seen = new Set<string>()
  const out: Dep[] = []
  for (const p of MANIFEST) for (const d of p.deps) {
    const key = `${d.kind}:${d.name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(d)
  }
  return out
}
