# FABULA-LLM-5 — dependencies

Auto-generated from [`plugin/lib/manifest.ts`](plugin/lib/manifest.ts) (the single source of truth).
Regenerate: `bun scripts/install-deps.ts --md > DEPENDENCIES.md`.

Install everything missing: `bun scripts/install-deps.ts --all` (or `./setup.sh`). Install one plugin's deps:
`bun scripts/install-deps.ts --plugin=<id>`, or the in-app `install_plugin_deps` tool. Toggle plugins with the
in-app `enable_plugin` / `disable_plugin` tools (or `FABULA_DISABLE=id1,id2`).

## tools — Core tools · core

The core tool belt: web, shell/code, file edits, search, weather, places, mixture-of-agents.

**Tools:** `web_search`, `web_fetch`, `image_search`, `weather_fetch`, `places_search`, `bash_tool`, `view`, `str_replace`, `create_file`, `note_append`, `present_files`, `verify_done`, `mixture_of_agents`, `session_search`, `execute_code`, `save_skill`, `cost_report`, `batch_run`, `search_mcp_registry`, `suggest_connectors`, `recommend_LLM_apps`, `fetch_sports_data`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |
| defuddle | npm | **yes** | web_fetch HTML→markdown | `cd plugin && bun install` |
| linkedom | npm | **yes** | web_fetch DOM parsing | `cd plugin && bun install` |
| unpdf | npm | **yes** | web_fetch PDF extraction | `cd plugin && bun install` |
| SearXNG | service | optional | web_search / image_search backend | `Run a SearXNG instance (docker run searxng/searxng) and set SEARXNG_URL` |
| Docker | docker | optional | execute_code sandbox (FABULA_CODE_SANDBOX=docker) | `brew install --cask docker  # then launch Docker Desktop once` |

## graph — Workflow graph · core

Plan a task into ≤5 isolated steps, run them (parallel where independent), synthesize. Opt-in local→cloud router.

**Tools:** `workflow_graph`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |
| LM Studio (+ :1235 adapter) | service | **yes** | the local model the agent runs on | `Install LM Studio (https://lmstudio.ai), load a tool-calling model, then start proxy/lmstudio-adapter.py` |

## handoff — Handoff artifacts

Durable, threat-scanned handoff artifacts passed between steps/sessions.

**Tools:** `save_handoff`, `read_handoff`, `list_handoffs`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## checkpoint — Checkpoints & undo

Shadow-git snapshots before each edit + restore/diff — undo the agent's changes without touching your real git.

**Tools:** `list_checkpoints`, `restore_checkpoint`, `diff_checkpoints`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |
| git | system | **yes** | shadow-git checkpoint store (separate from your repo) | `Install git (xcode-select --install, or brew install git).` |

## reliability — Reliability · core

Loop-guard, tool-arg repair, ntfy push notifications, optional actor role preambles.

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |
| ntfy | service | optional | push notifications (FABULA_NTFY_TOPIC) | `Set FABULA_NTFY_TOPIC and subscribe in the ntfy app — no install needed (uses ntfy.sh by default).` |

## security — Security · core

SSRF guards, secret redaction, untrusted-result wrapping, command/approval guards, permission modes.

**Tools:** `set_permission_mode`, `allow_command`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## context — Context & memory · core

Curated-memory injection and single-system-message collapse for strict endpoints.

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## ops — Scheduling & ops

Recurring/one-off jobs via launchd, a run-ledger with overdue detection, notifications.

**Tools:** `schedule_task`, `list_scheduled`, `cancel_scheduled`, `send_notification`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |
| launchd | builtin | **yes** | scheduling backend (macOS) | Built into macOS. |
| bun | system | optional | runs the scheduled-job helper (FABULA_BUN_BIN) | `brew install oven-sh/bun/bun` |

## multimodal — Multimodal (vision/TTS/STT)

Image analysis, text-to-speech, and speech-to-text.

**Tools:** `vision_analyze`, `text_to_speech`, `transcribe_audio`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |
| vision endpoint (VLM) | service | optional | vision_analyze | `Load a VLM in LM Studio (set LMSTUDIO_VLM_MODEL) or set FABULA_VISION_URL+FABULA_VISION_MODEL` |
| say (macOS TTS) | builtin | optional | text_to_speech fallback | Built into macOS — text_to_speech works out of the box (Milena voice for Russian). |
| piper | system | optional | text_to_speech (higher quality than say) | `pip3 install piper-tts  # then set FABULA_PIPER_VOICE to a .onnx voice` |
| faster-whisper | python | optional | transcribe_audio (speech-to-text) | `pip3 install faster-whisper` |

## vision — Vision capability sync

Detects which loaded models are vision-capable (LM Studio type:vlm) and syncs the flag.

**Tools:** `sync_model_vision`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |
| LM Studio | service | optional | model vision query | — |

## browser — Browser automation

Drive a real browser: navigate, click, type, snapshot, vision, CDP.

**Tools:** `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_vision`, `browser_back`, `browser_press`, `browser_get_images`, `browser_console`, `browser_dialog`, `browser_cdp`, `browser_close`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |
| playwright | npm | **yes** | browser driver | `cd plugin && bun install` |
| chromium (playwright browser) | system | **yes** | the actual browser binary | `cd plugin && npx playwright install chromium` |

## readfloor — Read-limit floor · core

Raises small default read limits so the agent reads whole files (built for large context windows).

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## unknowns — Finding unknowns

Actively closes the prompt↔codebase gap (Thariq Shihipar's 'finding your unknowns', built as hooks not skills): tool reference_hunt (grep the repo for analogous code, digest its contract via the aux model) + surface_unknowns (blindspot pass grounded in real code → refined task) + a reference-first steer that fires on the first source edit made without a reference/unknowns pass. Kill-switch: FABULA_REFERENCE_FIRST=0.

**Tools:** `reference_hunt`, `surface_unknowns`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## brainstorm — Brainstorm prototypes

brainstorm-prototypes (Thariq Shihipar): tool brainstorm_prototypes generates 3-5 wildly different throwaway design variations to react to, each labeled with the belief it bets on and its tradeoff — surfaces the implicit preference faster than more questions. For design/UX/API-shape choices before committing.

**Tools:** `brainstorm_prototypes`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## shipnotes — Implementation notes & pitch

implementation-notes + pitch-packager (Thariq Shihipar): auto-captures the edit trail as you build (fires itself) + tool implementation_note to log a deviation/decision, then pitch_packager bundles the diff + notes into a DEMO-FIRST reviewer buy-in doc (what it does + one step to see it, why, decisions, risks).

**Tools:** `implementation_note`, `pitch_packager`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## interview — Interview (unknowns triage)

interview-me built active (Thariq Shihipar): tool interview_me triages a task's unknowns into code-answerable (resolve by reading) vs the ONE decision only the human can make (grounded in the real code), plus an auto-nudge that fires itself when a new task reads as underspecified. Kill-switch: FABULA_INTERVIEW_NUDGE=0.

**Tools:** `interview_me`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## change-quiz — Change-quiz gate

A comprehension gate (Thariq Shihipar's 'quiz before merge'): after a green verify with source changes, requires the agent to pass change_quiz — 3 questions about its OWN diff, graded against the diff by the aux model (no self-assessment theater) — before 'done' stands. Kill-switch: FABULA_CHANGE_QUIZ=0.

**Tools:** `change_quiz`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## reproduce-gate — Reproduce-first gate

Downgrades a green verify_done to NOT-DONE when source changed but no reproduction test exercises the new behavior — the #1 cause of plausible-but-wrong patches on SWE-bench Pro (proven on 479aa075). Kill-switch: FABULA_REPRODUCE_GATE=0.

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## learn — Learn (skill-packaging nudge)

Closes the 'skills compound' loop as a light self-nudge: after the agent completes AND verifies a real multi-step change, a tool-result steer points at /distill so the fresh trajectory gets packaged into a reusable skill/command while it is fresh. The manual-trigger alternative to the guarded auto-distill pass — it never runs distill for you. Kill-switch: FABULA_LEARN_NUDGE=0.

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## selfextend — Self-extension (author tools)

Lets the model author a NEW fabula plugin/tool for itself when a capability is missing (create_plugin). The harness scaffolds it and enforces the one-plugin-per-file contract deterministically before writing; it becomes callable after the next engine start. The supervised model grows its own supervised tool belt.

**Tools:** `create_plugin`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## coordinator — Coordinator (sub-receipt proof tree)

A verified TEAM, not just an agent loop. When work is split across workers (spawned via the engine's own task/AgentTool), each leaves its own Proof-of-Done receipt; subreceipt_add joins them into a proof tree, and proof_tree renders the honest composite verdict — VERIFIED only if EVERY worker's receipt is VERIFIED, a single NOT DONE anywhere makes the whole run NOT DONE. That is supply-chain provenance for AI work (an SBOM for an agent trajectory): you prove not just that the result is right, but that every step, by every worker, was verified. State in .fabula/coordinator/tree.json (companion to the receipt — never modified); reuses the receipt parser. Off by default.

**Tools:** `subreceipt_add`, `proof_tree`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## tool-router — Tool router (per-task belt profiles, Context OS Phase 1)

The Context OS per-task tool router: on every real user message it deterministically classifies the task (word-bounded verbatim tool mentions + BM25 over tool cards with RU/EN utterances, RRF fusion) into a PROFILE from a closed nested registry — coding / web-research / full — and stamps a per-SESSION belt that the engine reads when building tool schemas. Result: only the profile's tools reach the model (schemas are the #1 prefill cost), the tool set stays byte-stable within a task so the local model's KV-cache survives, and concurrent sessions never clobber each other (the old env mask stays as a static floor). Gate tools (verify_done, skill, …) are never maskable; a masked tool the model calls BY NAME still executes through a shadow dispatch — a router miss costs one roundtrip, never a blocked task. Gate PASSED on the real-model A/B bench (success 7/7 vs 6/7 off, prefill −2.3k/step, cache-breaks −23%) — ON by default; kill-switch: disable this toggle or unset FABULA_TOOL_ROUTER.

**Tools:** `expand_tools`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## buddy — Buddy (a companion that grows from VERIFIED work)

A small ASCII companion that sits with the project. Its look — species, rarity, eye, hat, base stats — is DETERMINISTIC from your user id (regenerated on every read, so a rename can't break it and you can't hand-edit your way to a rarer pet); you author only its name + one-line personality, once, at hatch. The FABULA twist, and the whole point: it grows ONLY from VERIFIED work. buddy shows it; buddy_hatch names it; buddy_feed feeds it a Proof-of-Done receipt — a PASSED receipt grants XP (base + reproduce/quiz gates + 10×witnesses + a SWE-bench bonus) and its gates bump matching stats, while a NOT DONE receipt grants nothing. A silent hook auto-feeds the latest receipt on every green verify_done, so the pet literally grows from proven work; only a level-up or the legendary upgrade surfaces a one-line note. Three published receipts each attested by ≥3 independent witnesses upgrade the pet to legendary — a badge you cannot fake. State in .fabula/buddy/state.json. Off by default; auto-feed kill-switch FABULA_BUDDY_AUTO=0.

**Tools:** `buddy`, `buddy_hatch`, `buddy_feed`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## relay — Cloud relay (escalation ladder → cloud writes the patch)

The escalation rung beyond advice: when the local model stays stuck, relay_to_cloud has a STRONGER cloud model write the fix ITSELF as a complete unified diff (saved to .fabula/relay/patch.diff). The patch is NOT trusted — the model must apply it and re-run the SAME verify/reproduce/change-quiz gates; only a green gate makes it count. This is what lets FABULA honestly say the work will be done AND proven: NOT DONE is a transient rung, the ladder climbs until VERIFIED or the budget is spent (FABULA_RELAY_MAX_ATTEMPTS / _MAX_COST_USD / _MAX_TIME_MIN) or a single need-input question. Every attempt is appended to .fabula/relay/attempts.json (companion to the receipt — the receipt is never modified). Target via FABULA_RELAY_URL+FABULA_RELAY_MODEL or a cloud provider in the config. Off by default.

**Tools:** `relay_to_cloud`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## daemon — Autonomous daemon (KAIROS posture + pacing + PR poll)

The always-on autonomous posture. When FABULA_DAEMON=1 a system block turns the session into an autonomous worker (KAIROS): it paces itself with `sleep`, acts on its own judgment, and adapts to terminal focus (FABULA_TERMINAL_FOCUS=focused|unfocused → collaborate vs full autonomy). The FABULA twist: background 'done' still runs the same gates and mints a replayable receipt, so overnight autonomy can't lie. Tools: `sleep` (cache-aware pacing — staying under the 5-min prompt-cache window is cheap) and `check_pr_activity` (POLLS a GitHub PR via `gh` for NEW comments/check-runs since the last poll — honest polling, not a fabricated webhook subscription). Off unless FABULA_DAEMON=1; the tick/wake loop is the engine's (cron/wakeup).

**Tools:** `sleep`, `check_pr_activity`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## witness — Cross-model witness (independent diff review)

An INDEPENDENT model of a DIFFERENT architecture adversarially reviews the diff a local model just wrote. witness_diff sends the diff to a second model (FABULA_WITNESS_MODEL + FABULA_WITNESS_URL, or a cloud provider in the config) and returns CONFIRMED (correct + safe) or DISPUTED (a real problem, with the reason). Guards independence — a witness whose model id equals the author is refused. A confirmed witness is recorded as a companion attestation next to the receipt (.fabula/receipts/witnesses.json) WITHOUT modifying the receipt itself, so it composes with fabula-receipt. Not the author quizzing itself (that is change-quiz) — a second, orthogonal reader. Off by default; timeout FABULA_WITNESS_TIMEOUT_MS.

**Tools:** `witness_diff`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## registry — Proof registry (publish/verify/search)

Turns a LOCAL Proof-of-Done receipt into something the world can find and re-verify. publish_receipt copies the last green run's receipt + patch into a content-addressed git store (id = SHA256(patch + verify cmd)) and pushes to FABULA_REGISTRY_REMOTE if set (returns the real public URL, else the local store path — never a fabricated link). verify_receipt replays a receipt by id/path/URL in a throwaway worktree at the recorded base and runs its verification command (VERIFIED / NOT DONE); untrusted http receipts run their own shell, so that needs FABULA_REGISTRY_VERIFY_UNTRUSTED=1 (ideally FABULA_CODE_SANDBOX=docker). search_receipts queries the store index. Off by default (experimental); store at FABULA_REGISTRY_DIR.

**Tools:** `publish_receipt`, `verify_receipt`, `search_receipts`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## escalate — Cloud second-opinion escalation

When the local model is stuck (the same fix keeps failing, or it can't find the root cause), escalate_to_cloud gets a second opinion from a stronger CLOUD model on the same problem — same context in, a concrete root cause + next step back — then the local model keeps driving. Requires a cloud provider in the config; the message normalization reuses the cross-provider replay core. Target via FABULA_ESCALATE_MODEL/FABULA_ESCALATE_PROVIDER.

**Tools:** `escalate_to_cloud`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## rewind — Auto-rewind on repeated failure

When each edit keeps the verify RED, the HARNESS reverts (LOCK 4): on a green verify_done it snapshots the good state, and after N consecutive red verifies it atomically restores the files to that last-green checkpoint (shadow-git, real .git untouched) and steers the model to try a DIFFERENT approach instead of looping on the same failing change. When the ladder is exhausted — no green anchor ever existed, or the rewind budget is spent and a fresh approach still fails — it surfaces the explicit terminal ❌ NOT DONE verdict (Greenpaper: no silent third state); a later green fully recovers the run. Kill-switch: FABULA_AUTO_REWIND=0; thresholds: FABULA_REWIND_THRESHOLD (default 2), FABULA_NOTDONE_THRESHOLD (default 4).

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## memory — Anchored memory from verified work

Memory that can be CHECKED rather than trusted. A memory formed from a verified turn is bound at write time to the code it is about — today the file and its exact bytes; symbol-span scope is implemented and used wherever a symbol is known, but the writer that records a verified turn supplies a path only, so a real memory currently invalidates on ANY edit to that file — and before it is ever served back, that binding is re-checked against the real tree with git rather than judged by a model. Code moved on? The memory is withheld, or the CURRENT source is served in its place; it is never handed over with a 'possibly stale' label, because a hedge beside a memory is the exact stimulus measured to make the decision worse, not a softer form of honesty. Raw episodes are append-only and never destroyed by consolidation, which writes a new record pointing back at what it summarised. Whether a memory gets PROMOTED is decided from an outcome produced outside the model — the project's own verifier — and that decision starts in SHADOW: journalled, acting on nothing, until its record has been read. Kill-switches: FABULA_MEM_PIN=0 (restore the old positional truncation), FABULA_MEM_WORTH=0 (stop the usefulness counters), FABULA_MEM_STALE_MODE (withhold | evidence); FABULA_MEM_PROMOTE=1 turns the shadow journal into action.

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## receipt — Proof-of-Done receipt

On a green verify_done that no other gate downgraded, mints a machine-readable Proof-of-Done receipt (Greenpaper contract): model in the socket, which gates fired and what each forced, the diff, the verification that passed, and a deterministic replay command — written to .fabula/receipts/. Read-only: never blocks or changes the verdict, only records it. Manual mint: mint_receipt. Kill-switch: FABULA_RECEIPT=0.

**Tools:** `mint_receipt`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## distill-guard — Distill guard · core

Blocks the harness's auto self-improvement passes — distill AND dream memory consolidation — on uncensored models (policy collision). One decision covers every pass, so a new pass can never slip by.

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## purge-hook — Purge hook · core

Fully purges a deleted chat's artifacts (privacy).

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

## manage — Plugin manager · core

Manage plugins: list status + dependency health, enable/disable, and install a plugin's deps. Cannot be disabled.

**Tools:** `list_plugins`, `check_deps`, `install_plugin_deps`, `enable_plugin`, `disable_plugin`

| Dependency | Kind | Required | Purpose | Install / note |
|---|---|---|---|---|
| @mimo-ai/plugin | npm | **yes** | plugin SDK (tool/hook API) | `cd plugin && bun install` |

