# FABULA plugins & tools — the full map

[English](PLUGINS.md) · [中文](PLUGINS.zh-CN.md) · [Русский](PLUGINS.ru.md)

Every capability is a plugin: a single file (`plugin/fabula-*.ts`) with a declared manifest
([`plugin/lib/manifest.ts`](../plugin/lib/manifest.ts) is the source of truth). The tags in the app's
timeline **are** the plugins — same names everywhere: in `list_plugins`, in **Settings ▸ Plugins**, and below.

<p align="center">
  <img src="assets/plugins.svg" alt="All 40 FABULA plugins grouped by role — UNDERSTAND & PLAN, ACT ON THE WORLD, REMEMBER, PERCEIVE, GUARD EVERY CALL, VERIFY & SHIP (including the Go static-analysis floor), WHEN THE MODEL FAILS (rewind, escalate), GROW, OWN THE STACK, and the PROOF ECONOMY disrupt layer (registry, witness, daemon, relay, coordinator, buddy — off by default); ⚡ marks the pure hooks that fire themselves" width="880">
</p>

## What the system does

### It acts
Web fetch with clean extraction (HTML→Markdown, PDFs included), private web & image search, shell, sandboxed code execution, exact-match file editing, a real Chromium it can drive, image analysis, text-to-speech, transcription, weather, places, scheduled jobs, durable hand-off notes between sessions, and a workflow graph that runs independent sub-steps in parallel.

### It doesn't break

- **Loops are cut, not tolerated.** Byte-identical calls are hard-stopped; a paraphrased re-search is blocked at the second occurrence, and a per-turn budget of distinct searches forces synthesis.
- **Near-miss edits still land.** Malformed tool arguments are repaired on the fly, and exact-match edits fall through a unicode-drift matcher — smart quotes, any dash, non-breaking spaces, BOM.
- **The transport is guarded.** The bundled `:1235` adapter normalizes reasoning-model quirks, watches the prefix cache, and flags silent context-overflow.
- **Output can't blow the window.** Every command's output is capped and spilled to a file with a continuation cursor, so a giant test log stays a log.

### It doesn't leak
SSRF guards on every outbound fetch, secret redaction in tool output, prompt-injection defense (untrusted web content is wrapped and isolated), command/approval guards on the shell.

### It learns
Curated notes and preferences load at session start; after you finish *and verify* a real multi-step change, it nudges you to distill that trajectory into a reusable skill. Skills and memory compound between sessions, entirely on-device.

### It forgets on command
Deleting a chat purges all of its artifacts; web caches are wiped on quit; no telemetry, no account. It learns what you let it and forgets what you delete.

## Plugin-by-plugin

| Tag | What it does |
|---|---|
| `verify` | **The heart of the harness.** `reproduce-gate` runs the new test against the *pre-patch* tree — a test that passes with **and** without the change is fake, and a change that breaks a sibling is a regression; either keeps the build *not done*. `change_quiz` grades the agent against its own diff before "done" stands. The `attest` gate carries the same idea to **written** deliverables — an analysis, a plan, a research summary. All three fire themselves. [Details ↓](#the-attest-gate) *(`fabula-reproduce-gate`, `fabula-change-quiz`, `fabula-attest`)* |
| `go-audit` | **Go projects only, silent everywhere else.** On a green Go change six analysers run over the module; if they are not clean, *done* is taken back with each finding's file and line. A vulnerability blocks only when it is **reachable** — actually called, not merely in `go.mod`. [Details ↓](#the-go-security-floor) *(`fabula-goaudit`)* |
| `receipt` | Mints the Proof-of-Done receipt on a fully-gated green verify — model, gates, diff, verification, replay command, and the run's full context identity ([open spec draft](spec/verified-autonomy-receipt-v0.2.md)): prompt-prefix fingerprint, hash of the user's request text, the serving model's descriptor (honestly labeled *not a weights hash*), and — with `FABULA_WEIGHTS_DIGEST=1` — a real digest of the weight files on disk. *(`fabula-receipt`)* |
| `graph` | **Plans and parallelizes.** `workflow_graph` breaks a request into up to 5 isolated sub-steps and runs independent ones in parallel. The edge between steps is a contract: a step that produced nothing arrives as an *absence*, never as text that reads like a result; a truncation says how much it removed; an unusable output is retried once, then marked empty so the merge knows where the holes are. For genuinely multi-agent work the engine's own `workflow` tool is the full orchestrator. *(`fabula-graph`)* |
| `unknowns` | **Closes the prompt↔codebase gap before coding.** `reference_hunt` reads working code as the spec; `surface_unknowns` lists what your ask doesn't say; `interview_me` asks the one decision only you can make; `brainstorm_prototypes` gives divergent options. *(`fabula-unknowns`, `fabula-interview`, `fabula-brainstorm`)* |
| `code` / `files` | **Executes, doesn't guess.** Guarded shell, sandboxed Python/JS, whole-file reads, exact-match `str_replace` edits that refuse to apply on a mismatch — no silent corruption. *(`fabula-tools`)* |
| `web` | Clean web fetch (HTML→Markdown, PDFs), private SearXNG search, live weather/places — no keys required. *(`fabula-tools`)* |
| `browser` | 13 tools drive real Chromium: navigate, click, type, screenshot, console, raw CDP. *(`fabula-browser`)* |
| `memory` / `handoff` | Curated memory injected at session start; structured, threat-scanned hand-off notes survive between sessions. A separate anchored-memory plugin binds each memory written from a verified turn to the code it is about and re-checks that binding against your real tree with git before serving it back — code moved on, and the memory is withheld or the current source is served instead, never handed over with a "possibly stale" label. Off by default, and its promotion decisions start in shadow: journalled, acting on nothing, until you have read them. *(`fabula-context`, `fabula-handoff`, `fabula-memory`)* |
| `offload` | **Material lives outside the context; the context holds a handle to it.** A result too large for the turn is kept whole outside the conversation, and a short block takes its place. `handle_query` then asks a question of *all* of it — read in window-sized slices by separate sub-calls, answers merged — so nothing is truncated and no raw material enters the context. `handle_peek` reads any passage verbatim. The decision compares size against the model's real window; it never reads your wording. *(`fabula-handle`)* |
| `corpus` | **A whole book does not have to fit in one context.** Covering a corpus, the harness takes the work over as a map-reduce: batches sized to the model's real window, each summarized in an isolated call, every summary written to disk as it goes — an interruption resumes instead of restarting — then one report synthesized from them. What starts it is the *shape of the work* (file after file out of one folder, past the window, more still unread), never the wording of the ask. *(`fabula-corpus`)* |
| `window` | **The context window is computed, never typed.** On a model change the harness reads the model's own passport and this machine's memory, works out the widest window that actually fits, loads the model at it, and corrects the figure every later decision is computed from. A number nobody measured is never trusted. *(`fabula-window`)* |
| `context-budget` | Keeps a single turn from outgrowing the window it is served with. Near the ceiling it makes the agent consolidate what it has read and stop holding raw text; on an unbounded "read everything" ask it steers toward bounded batches with a running summary. Inert below the high-water mark, so an ordinary turn is left byte-identical and pays nothing. *(`fabula-ctxguard`)* |
| `checkpoint` | Snapshots every file before the agent edits it, into a private git store — undo the agent even in a non-git project. *(`fabula-checkpoint`)* |
| `rewind` | **The harness reverts, not the model.** When each edit keeps the verify red, it rolls the files back to the last state that passed — atomically, from its own shadow-git — and steers a different approach instead of digging the hole deeper. The failed attempts are dropped from the model's context so the retry runs clean (a contaminated retry multiplies the error), the steer names the recurring root-cause signature, and non-idempotent side effects from the reverted attempts (installs, migrations, network calls) are flagged as not-undone. *(`fabula-rewind`)* |
| `escalate` | **A second opinion when the local model is stuck.** `escalate_to_cloud` sends the same problem — what was tried, the relevant code, the errors — to a stronger cloud model and hands back a concrete root cause and next step, so the model in the socket stops looping on a dead end. The model stays a swappable chip; the auto-rewind steer points it here, and the harness also calls it itself on a scored red streak (bounded by FABULA_ESCALATE_MAX, kill-switch FABULA_ESCALATE_AUTO=0) rather than relying on the model to ask when a rewound different approach also fails. *(`fabula-escalate`)* |
| `moa` | A second model cross-reviews the diff. *(`fabula-tools`)* |
| `voice` / `vision` | TTS (with zero-install macOS fallback), local Whisper transcription, image analysis with VLM auto-detection. *(`fabula-multimodal`, `fabula-vision`)* |
| `ops` | Real `launchd` scheduled jobs with an overdue-run ledger and native notifications. `list_scheduled` asks **launchd** what is loaded rather than trusting the files on disk, so a leftover plist launchd has never heard of is shown as `NOT LOADED` instead of as an armed job. *(`fabula-ops`)* |
| `reliability` | Loop-guard hard-stop and on-the-fly tool-call repair. (The `:1235` adapter is a separate bundled component: [`proxy/lmstudio-adapter.py`](../proxy/lmstudio-adapter.py).) *(`fabula-reliability`)* |
| `security` | SSRF filtering, secret redaction, injection-safe wrapping of untrusted text, and shell guards — around every tool call. The same rules cover **three doors**: the tool, the shell, and code the model writes itself, which runs under the OS kernel profile where the platform has one (Seatbelt on macOS, bubblewrap on Linux; on Windows the container backend is the isolation). *(`fabula-security`)* |
| `shipnotes` / `learn` | Auto-captured edit trail + deviation notes packaged into a reviewer-ready pitch; a nudge to distill verified wins into reusable skills. *(`fabula-shipnotes`, `fabula-learn`)* |
| `self-extend` | **The model grows its own tool belt.** `create_plugin` lets the model author a new tool when a capability is missing; the harness scaffolds it and enforces the one-plugin-per-file contract before writing — a self-authored plugin can never break loading. *(`fabula-selfextend`)* |
| `tool-router` | **The right tools, not all the tools.** On every real user message it deterministically classifies the task into a closed profile (coding / web-research / full) and only that profile's tool schemas reach the model — tool schemas are the dominant fixed prefill cost of every request — while the set stays byte-stable within a task so the KV-cache survives. A masked tool called by name still executes through a shadow dispatch: a router miss costs one roundtrip, never a blocked task. *(`fabula-toolrouter`)* |
| `manage` + housekeeping | Enable/disable plugins with dependency health; a capacity report naming what THIS machine is (memory kind and size, cores, accelerator, kernel confinement, containers) and what was derived from it — the window policy and how many calls may reach the model at once, each with where that number came from; whole-file read floors; a guard that blocks the auto self-improvement passes (distill and dream memory consolidation) on uncensored models; full purge of deleted chats. *(`fabula-manage`, `fabula-readfloor`, `fabula-distill-guard`, `fabula-purge-hook`)* |

On/off state lives outside the repo (`~/.config/fabula/fabula-state.json` — the engine config dir; override with `FABULA_PLUGIN_STATE`, or use `FABULA_DISABLE=browser,ops`); a server restart applies changes.

## Two gates in detail

### The `attest` gate

`verify` and `reproduce` decide whether *code* is done. `attest` carries the same standard to a written
deliverable — an analysis, a plan, a research summary — where there is no test to run.

It decomposes the text into typed claims and re-derives each one:

- a **quote** must appear verbatim in the source it cites (a real line pinned to the wrong section is caught as mis-attribution);
- a **number** must be present in the source;
- a **process** claim like "read all N files" is checked against the run's own read log.

Only the claims that fail the free deterministic check reach a quarantined model that separates a faithful
paraphrase from a fabrication. It is silent on chat turns and fail-open, so it never rejects grounded work.
Validated on a planted-defect bench (every planted fabrication caught, zero false positives) and a live run.

### The Go security floor

When a Go change goes green, the module's own analysers run once — `govulncheck`, `gosec`, `staticcheck`,
NilAway, `go vet`, `golangci-lint`. If they are not clean, *done* is taken back with each finding's file
and line.

**Reachability is the precision lever.** A known vulnerability blocks only when the vulnerable symbol is
actually called — not merely present in `go.mod` — so four advisories about an unused dependency never
stop you while the one real call path does.

On top of the linters, `go_audit_criteria` checks the ~30 review criteria no Go linter can decide: reading
through the pool inside a transaction, goroutine leaks, silently skipped branches, unbounded queries, Kafka
offsets committed too early, `sync.Pool` objects reused without `Reset`. Everything a linter already catches
is declared out of scope, and every finding must cite a `file:line` from the diff.

**Install what you want checked:**

```bash
brew install go golangci-lint
go install golang.org/x/vuln/cmd/govulncheck@latest
go install github.com/securego/gosec/v2/cmd/gosec@latest
go install honnef.co/go/tools/cmd/staticcheck@latest
go install go.uber.org/nilaway/cmd/nilaway@latest
```

Every analyser is optional, and **every absence is named in the report** — a thin floor never reads as a
clean one. Only `govulncheck` reports reachability, so without it there is no CVE check at all. In a
repository with no `go.mod` the plugin is inert and costs nothing.

## The disrupt layer — turning a Proof-of-Done into a proof economy (experimental, off by default)

The core harness ends a run by minting a **Proof-of-Done receipt** (`fabula-receipt`): the model, the gates, the diff, the exact verification command, a one-command replay. These six plugins build *on top of* that receipt — turning a private artifact into something you can **publish, independently attest, guarantee, compose, and be rewarded for**. Every one is `defaultEnabled:false`; enable them per-plugin in **Settings ▸ Plugins** or via `fabula-state.json`. Each keeps the harness's honesty discipline: nothing is faked, and a receipt is never modified after the fact.

| Tag | What it does |
|---|---|
| `registry` | **A public, content-addressed proof registry.** `publish_receipt` stores a receipt in a sharded content-addressed store (a file tree keyed by `sha256(patch + verify-cmd)`, version-controlled via git) — the same fix + same check is the same id on any machine, so a proof can't be forged without changing what it proves — and can push it to a shared remote. `verify_receipt` re-runs the proof in a throwaway git worktree at the recorded base commit; `search_receipts` queries the local index. A public URL is only ever reported when a remote actually holds it. *(`fabula-registry`)* |
| `witness` | **Independent cross-model attestation.** `witness_diff` has a model of a *different family* adversarially review the diff (independence enforced at the model-family level: the witness can't share the author's lineage) → CONFIRMED / DISPUTED, recorded as a companion attestation next to the receipt (`.fabula/receipts/witnesses.json`) — the receipt itself is never touched. A green build says *the author's tests pass*; a witness says *someone else, who can't rubber-stamp, agrees*. *(`fabula-witness`)* |
| `daemon` | **KAIROS — a background posture that mints proof while you're away.** With `FABULA_DAEMON=1` it adds an honest work posture (cache-aware pacing, real `gh` PR-activity polling — no fake webhooks, terminal-focus awareness) so a long autonomous run keeps producing verified, receipted work between check-ins. The tick loop is the engine's (cron/wakeup); the plugin supplies the posture + tools. *(`fabula-daemon`)* |
| `relay` | **A budgeted escalation loop.** When the model in the socket is truly stuck, `relay_to_cloud` has a stronger cloud model write the fix as a unified diff — which is **never trusted**: the socketed model applies it and re-runs the *same gates*. The loop is bounded by attempt/cost/time budgets, so the run either reaches VERIFIED or asks you a precise question — it never quietly gives up or quietly lies. (The full ladder — direct → rewind-retry → advice → with-hint → cloud-writes-it → need-input — is the design map; `relay_to_cloud` is the wired rung.) *(`fabula-relay`)* |
| `coordinator` | **Supply-chain provenance for a team of agents.** When work is split across workers (each a real engine subagent leaving its own receipt), `subreceipt_add` joins their receipts into a proof tree and `proof_tree` renders the honest composite: VERIFIED only if **every** worker's receipt is VERIFIED — a single NOT DONE anywhere makes the whole run NOT DONE. An SBOM for an agent trajectory: not just "the result is right," but "every step, by every worker, was proven." *(`fabula-coordinator`)* |
| `buddy` | **A companion that grows only from VERIFIED work.** A small ASCII pet whose look is deterministic from your user id (you can't hand-edit your way to a rarer one); it earns XP and levels **only** from receipts that *passed* — a NOT DONE receipt grows nothing. Gates bump matching stats, witnesses multiply the reward, and three published receipts each attested by ≥3 independent witnesses upgrade it to legendary — a badge you cannot fake. A silent hook feeds it on every green verify, so proof, not time, is what makes it grow. *(`fabula-buddy`)* |

Read together, the layer is a bet: if a local model's work can be **proven, published, independently witnessed, and composed**, then trust stops depending on which model produced it. *Any model in — proven work out.*

## Works with any tool-calling model

| Runtime / provider | How |
|---|---|
| **LM Studio** (local) | Default path — through the bundled `:1235` adapter, which normalizes structured/tool calls for reasoning models |
| **Ollama & other local servers** | Same OpenAI-compatible `baseURL` path as LM Studio — end-to-end validation run pending |
| **Any OpenAI-compatible cloud** | Add `baseURL` + key in `fabula.config.json` — the engine ships a large built-in provider preset catalog |
| **Corporate gateways (LiteLLM etc.)** | Strict single-system-message endpoints handled by `fabula-context` |

The base system prompt ([`system-prompt.example.md`](../system-prompt.example.md)) is original and model-agnostic — the public template you can build on. Copy it to `system-prompt.md` (the path the config's `instructions` point at) to run your own.
