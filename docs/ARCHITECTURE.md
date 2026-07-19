# FABULA-LLM-5 — Architecture Overview

FABULA-LLM-5 is a **local-first, autonomous coding agent for macOS**. It runs your
code-generation, research, and automation workloads against **local models** by default
(via LM Studio), with an **opt-in** escalation path to a cloud provider for heavy work.
Everything is packaged as a native `.app` so it looks and behaves like a first-class
desktop application rather than a browser tab.

This document describes the system's layers, the LM Studio compatibility adapter, the
plugin model, the workflow-graph orchestrator, and the cross-cutting reliability,
security, and ops concerns.

---

## 1. The Layers

The system is composed of four cooperating layers.

```
                          ┌──────────────────────────────────────────┐
                          │  Native macOS .app (Swift + WKWebView)    │
   user ───────────────►  │  app/FabulaApp.swift                      │
                          │  own icon · no browser chrome             │
                          └───────────────────┬──────────────────────┘
                                              │ hosts web UI of
                                              ▼
                          ┌──────────────────────────────────────────┐
                          │  FABULA ENGINE (`fabula`)                 │
                          │  agent loop (lineage: docs/CREDITS.md)        │
                          │  config: fabula.config.json                    │
                          │                                           │
                          │   ┌─────────────────────────────────┐    │
                          │   │ PLUGIN LAYER (plugin/fabula-*.ts) │   │
                          │   │ 33 plugins · shared plugin/lib/   │   │
                          │   └─────────────────────────────────┘    │
                          └───────┬───────────────────────┬──────────┘
                                  │ chat + structured     │ MCP
                                  │ (OpenAI-compatible)   │ (SearXNG, …)
                                  ▼                       ▼
              ┌────────────────────────────────┐   ┌──────────────┐
              │  Adapter  localhost:1235        │   │  MCP servers │
              │  proxy/lmstudio-adapter.py      │   └──────────────┘
              │  schema + reasoning shims,      │
              │  stall watchdog, admission      │
              │  control, cache telemetry       │
              └───────────────┬─────────────────┘
                              │ proxied
                              ▼
              ┌────────────────────────────────┐      ┌─────────────────────┐
              │  LM Studio  localhost:1234      │      │  Cloud: NVIDIA       │
              │  local models (Qwen3.x, …)      │      │  (OpenAI-compatible) │
              └────────────────────────────────┘      │  OPT-IN, heavy steps │
                                                       └─────────────────────┘
```

### 1.1 The engine (`fabula`)

The **FABULA engine** (CLI: `fabula`; derived from an upstream engine — see
[CREDITS](CREDITS.md)) owns the agent loop: prompt assembly, tool dispatch, the chat
session store, the web UI, and the plugin runtime. All agent behavior is configured
through `fabula.config.json` — the engine's config file name (an engine-level contract, kept
for compatibility). A working config is produced by copying
`fabula.config.example.json` → `fabula.config.json` and filling it in.

### 1.2 Models — local-first via the `:1235` adapter

Models are served **locally by LM Studio** (default endpoint `localhost:1234`). The
harness does **not** talk to LM Studio directly. Instead it points at a small Python
**compatibility adapter** on `localhost:1235` (`proxy/lmstudio-adapter.py`), which
proxies to LM Studio and does the following so that *structured output* and *tool calls*
work reliably — and so that concurrency, stalls and cache breaks are governed at the one
point every request passes:

1. **`json_object` → `json_schema`.** The Vercel AI SDK (inside the engine) emits the legacy
   OpenAI `response_format: {type:"json_object"}` mode for `generateObject`. LM Studio
   rejects that mode with **HTTP 400** — it accepts only `json_schema` or `text`. The
   adapter rewrites the request to a **permissive** `{type:"json_schema", json_schema:{…,
   additionalProperties:true}}` so every structured caller gets valid JSON of *its own*
   shape (the per-call schema lives in the prompt, not the request body). A caller that
   wants a specific grammar opts in with the `X-Fabula-Schema` header (the goal judge uses
   this to pin its strict verdict shape).

2. **`reasoning_content` → `content`.** When a reasoning model (e.g. Qwen3.x) leaves
   `content` empty and puts the actual JSON answer in `reasoning_content`, the AI SDK
   can't parse it. For non-streaming responses the adapter detects this and copies the
   `reasoning_content` into `content`.

3. **Stall watchdog + output cap.** A single local call can spiral or hang, emitting zero
   tokens for minutes. Every read carries an **inactivity timeout** with a first-token
   (prefill) budget that drops to a smaller inter-token budget once the first byte arrives —
   applied to *both* the streaming and the non-streaming path. A stalled upstream is
   aborted (retried once if it stalled before the first byte, else ended cleanly) instead
   of wedging the turn; `FABULA_MAX_OUTPUT_TOKENS` / `FABULA_CONTEXT_WINDOW` clamp runaway
   generation. This is the transport-level expression of the harness-over-model thesis.

4. **Declarative reasoning-level control (opt-in) + telemetry.** A config table
   (`proxy/reasoning-map.json`) can patch a request's reasoning knobs per model/level when
   a level is supplied (`X-Fabula-Reasoning` / env); the adapter also logs KV-cache prefix
   breaks (the measured #1 cost) and context-overflow classification for visibility.

5. **Admission control.** This serving class matches cloud latency at low concurrency and
   collapses under concurrent prefill, and every session, background pass and witness call
   funnels through this one adapter — so it serializes *inference* work
   (`FABULA_MAX_CONCURRENT_UPSTREAM`, default 1; `0` = unlimited). Excess requests queue
   FIFO; a queued streaming client receives SSE-comment keepalives, and once those commit
   the response an upstream error travels as an in-band SSE event rather than a second HTTP
   status line. Waits past `FABULA_ADMIT_WAIT_MAX` **fail open** — a gate that blocks would
   be worse than no gate. Metadata (`GET /v1/models`, the app's liveness probe) and
   embeddings bypass the queue entirely. Measured on this hardware with four concurrent
   *unique* heavy prefills: **41.1s unserialized vs 2.4s serialized**; with a warm shared
   prefix the gate costs ~0.15s. NB it bounds starvation but does not prioritise — a
   background pass that arrives first holds the slot for its whole generation.

6. **Measured idle budget.** The flat inter-token timeout is replaced per
   (model, prompt-size bucket) by a budget derived from genuinely observed *inter-token
   gaps* — never time-to-first-token, which governs a different quantity — with a floor,
   an env ceiling, and a cold start equal to the flat constant. `FABULA_IDLE_BASELINE=0`
   restores the constant.

7. **Cache-break classification.** The break telemetry states *why* the prefix broke:
   `position-shift` (bit-identical content that merely moved — our own injection ordering,
   and the offending volatile block is named) versus `content-break` versus growth/shrink.
   `FABULA_CACHE_BREAK_CLASS=0` restores the previous line.

**Chat streaming passes through token-by-token** (now watchdog-guarded); only the
*non-streaming* structured responses are additionally buffered and rewritten. An optional
**cloud provider — NVIDIA** (OpenAI-compatible) — is available for the opt-in heavy-step
router (see §4).

### 1.3 App — native Swift / WKWebView wrapper

`app/FabulaApp.swift` is a native macOS wrapper built on **Swift + WKWebView**. It hosts
the engine's web UI inside its own application window — its own icon, no browser chrome — so
FABULA presents as a standalone desktop app rather than a page in a browser.

### 1.4 Plugins — the capability layer

The agent's actual capabilities (web/file tools, orchestration, multimodal, ops,
reliability, security) are delivered as a layer of TypeScript **plugins** under
`plugin/`, loaded by the engine and executed with **bun**. These are detailed in §2 and §3.

---

## 2. The Engine Plugin Model

The engine discovers and loads plugin files and invokes the functions they export. Plugins
participate in the agent loop in two ways:

- **Tool registration** — a plugin returns a `tool` map; each entry (`name: tool({…})`)
  becomes a callable tool the model can invoke.
- **Lifecycle hooks** — a plugin returns hook callbacks that the engine fires at defined
  points in the loop. The hooks used across this codebase include:
  - `tool.execute.before` — inspect/rewrite/abort a tool call before it runs (throwing
    here **aborts** the tool — this is the universal security/loop-guard gate).
  - `tool.execute.after` — inspect/wrap a tool's result (e.g. wrap untrusted output).
  - `chat.message` / `chat.params` — adjust messages or request params before the model
    is called (e.g. collapse system messages, inject curated memory).
  - `event` — react to engine events (e.g. session idle, chat deletion).

### 2.1 `plugin/` vs `plugin/lib/` — a deliberate split

**Critical rule:** the engine treats **every exported function in a `plugin/fabula-*.ts` file
as a plugin** and will call it. A stray non-plugin export in one of those files breaks
provider/model loading.

Therefore:

- **`plugin/fabula-*.ts`** — each file exports **exactly one** `Fabula*` plugin factory
  (e.g. `FabulaTools`, `FabulaGraph`) and **nothing else**.
- **`plugin/lib/*.ts`** — all shared, pure helper code. The engine does **not** scan `lib/` as
  plugins, so helpers (routing, providers, parsers, guards) live here and are imported by
  the plugin files.

---

## 3. The Plugins

There are 33 plugins. Each file exports one `Fabula*` factory. The table below is a representative
subset (the always-on core); the full, current map of every plugin and tool — including the six
off-by-default **proof-economy** plugins (`registry`, `witness`, `daemon`, `relay`, `coordinator`,
`buddy`) — lives in [`docs/PLUGINS.md`](PLUGINS.md), generated against the manifest.

| Plugin (file)              | Factory             | Responsibility |
|----------------------------|---------------------|----------------|
| `fabula-tools.ts`          | `FabulaTools`       | The **core tool belt**: `web_fetch` (URL→markdown, incl. PDF), `web_search` + `image_search` (via SearXNG MCP), `bash_tool` / `execute_code` (sandboxed shell), `view` / `str_replace` / `create_file` / `note_append` (file ops), `present_files`, `verify_done`, `weather_fetch`, `places_search`, `mixture_of_agents` (fan out to N models + synthesize), `session_search`, `save_skill`, `cost_report`, `batch_run`, `search_mcp_registry`, `suggest_connectors`, `recommend_LLM_apps`, `fetch_sports_data`. |
| `fabula-graph.ts`          | `FabulaGraph`       | The **`workflow_graph`** orchestrator: planner → ≤5 isolated subtasks → synthesize, with an opt-in local→cloud router. See §4. |
| `fabula-handoff.ts`        | `FabulaHandoff`     | Durable structured **handoff artifacts** between steps/sessions: `save_handoff` / `read_handoff` / `list_handoffs`. Threat-scanned and size-capped. |
| `fabula-reliability.ts`    | `FabulaReliability` | **Loop-guard** that hard-stops repeated no-progress tool calls (throws in `tool.execute.before`), tool-arg **repair**, outbound **push notifications via ntfy**, and optional terse role preambles for actor subagents (`FABULA_SOULS=1`). |
| `fabula-security.ts`       | `FabulaSecurity`    | **SSRF guards**, **secret redaction**, **untrusted-result wrapping** (prompt-injection defense, via `tool.execute.after`), and command/approval guards (via `tool.execute.before`). |
| `fabula-context.ts`        | `FabulaContext`     | **Curated-memory injection** and **single-system-message collapse** for strict endpoints (some endpoints reject >1 system message). |
| `fabula-ops.ts`            | `FabulaOps`         | **Scheduling** backed by macOS **launchd**: `schedule_task` / `list_scheduled` / `cancel_scheduled`, a run-ledger with overdue detection, and `send_notification`. |
| `fabula-vision.ts`         | `FabulaVision`      | Image input plumbing (`sync_model_vision`) — gates/enables vision capability for the active model. |
| `fabula-multimodal.ts`     | `FabulaMultimodal`  | Multimodal tools: `vision_analyze` (image input), `text_to_speech` (TTS via **piper**), `transcribe_audio` (STT via **faster-whisper**). |
| `fabula-browser.ts`        | `FabulaBrowser`     | **Browser automation**: `browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type` / `browser_scroll` / `browser_vision` / `browser_press` / `browser_get_images` / `browser_console` / `browser_cdp` / `browser_close`, etc. |
| `fabula-readfloor.ts`      | `FabulaReadFloor`   | Raises small **default read limits** so file reads aren't truncated too aggressively. |
| `fabula-distill-guard.ts`  | `FabulaDistillGuard`| **Blocks the harness's auto self-improvement ("distill") pass** on uncensored models. |
| `fabula-purge-hook.ts`     | `FabulaPurgeHook`   | **Full purge** of a deleted chat's artifacts (via the chat-deletion `event` hook). |
| `fabula-manage.ts`         | `FabulaManage`      | **Plugin manager**: `list_plugins` (status + dependency health), `enable_plugin` / `disable_plugin`, `check_deps` / `install_plugin_deps`. Backs the in-app Settings ▸ Plugins panel and the menu-bar Plugins menu; never gated itself. |

---

## 4. The Workflow-Graph Orchestrator

`fabula-graph.ts` exposes a single tool, **`workflow_graph`**, for multi-part tasks that
a single pass handles poorly. Its pipeline:

1. **Plan.** A planner emits a graph of **≤5 isolated subtasks** with declared
   dependencies.
2. **Run in isolation.** Each step runs as a **separate, isolated model call**, seeded
   only by:
   - the outputs of its declared dependencies,
   - a short **role preamble**, and
   - a `STOP` sentinel.
   Because steps are isolated, they don't inherit the full conversation — they get exactly
   the context they need. `/no_think` keeps a local reasoning model's answer in `content`
   (no chain-of-thought leakage).
3. **Parallel fan-out.** Steps run in **dependency levels**: independent steps in the same
   level run in parallel.
4. **Synthesize.** The step outputs are synthesized into a final answer, with a short
   trace appended.

**Local-first by default.** Every step runs against the local model
(`localhost:1235/v1`). Tunables: `FABULA_GRAPH_URL`, `FABULA_GRAPH_MODEL`,
`FABULA_GRAPH_TIMEOUT_MS`.

### 4.1 Opt-in local→cloud router (`FABULA_ROUTER`)

The router (`plugin/lib/router.ts`) is **OPT-IN** and **off by default**
(`FABULA_ROUTER=0`). When enabled (`FABULA_ROUTER=1`) **and** a cloud provider is
configured, the router inspects each step (e.g. via `FABULA_ROUTER_HEAVY_CHARS`) and
**escalates "heavy" steps to the cloud model**, while keeping light steps local. If no
cloud provider is available, everything stays local. The final trace notes whether the
router was ON.

---

## 5. Cross-Cutting Concerns

These run *across* tools rather than being tools themselves, implemented mostly through
lifecycle hooks.

- **Reliability** (`fabula-reliability.ts`): a **loop-guard** detects repeated
  no-progress / failed tool calls and **hard-aborts** them by throwing in
  `tool.execute.before` (the harness's own stop signal is advisory and was being ignored
  by weak local models). Adds **tool-arg repair**, **ntfy** push notifications on
  idle/error, and optional actor role preambles (`FABULA_SOULS=1`).

- **Security** (`fabula-security.ts`): **SSRF guards** on outbound fetches, **secret
  redaction**, **untrusted-result wrapping** in `tool.execute.after` (so tool output is
  treated as data, not instructions — prompt-injection defense), and command/approval
  guards in `tool.execute.before`. The handoff plugin additionally **threat-scans and
  caps** stored artifacts.

- **Ops** (`fabula-ops.ts`): durable **scheduling** via macOS **launchd**
  (`schedule_task` / `list_scheduled` / `cancel_scheduled`), a **run-ledger** with
  overdue detection, and native **notifications**.

---

## 6. Configuration & Requirements

### Configuration

- Copy **`fabula.config.example.json` → `fabula.config.json`** (engine/model/MCP/plugin wiring).
- Copy **`.env.example` → `.env`** and fill it in.
- **Secrets live only in `.env` / `*.key`** (both gitignored) — never in committed config.
- Key environment variables are **`FABULA_*`**, documented in `.env.example`, e.g.:
  `FABULA_ROUTER`, `FABULA_ROUTER_HEAVY_CHARS`, `FABULA_GRAPH_URL`, `FABULA_GRAPH_MODEL`,
  `FABULA_GRAPH_TIMEOUT_MS`, `FABULA_SOULS`, `FABULA_NTFY_TOPIC` / `FABULA_NTFY_URL`,
  `FABULA_VISION_*`, `FABULA_PIPER_*`, `FABULA_WHISPER_PYTHON`, `FABULA_CODE_SANDBOX`,
  `FABULA_MOA_ENDPOINTS`, `FABULA_SKILLS_DIR`.

### Requirements

- **macOS**
- **The engine CLI** (`fabula` — built by `build.sh` into the repo-local `bin/fabula`; `setup.sh` installs a `fabula` wrapper that runs it)
- **LM Studio** (local models) **+ the `:1235` adapter** (`proxy/lmstudio-adapter.py`)
- **bun** — to run the TypeScript plugins
- *Optional:* **Docker** — sandboxed code execution
- *Optional:* **Python** — the adapter and some MCP servers
- *Optional:* a **SearXNG** instance — for `web_search` / `image_search`
- *Optional:* a **cloud provider (NVIDIA)** — only for the opt-in heavy-step router
