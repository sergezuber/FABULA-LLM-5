# Credits

The FABULA engine is derived from the **MiMoCode** harness (an OpenCode fork). Everything on top of it —
the `fabula-*` plugins and their tools — is a **local-first implementation** expressed through the engine's
plugin hooks, built to run on your own machine and models.

This document maps each capability to **what** it is, **where** it lives in this repo, and — most
importantly — **how to see that it actually exists in the running app.**

---

## How to see these features in the app

Features show up in four ways. Some are visible; some are behavioral (you observe what the agent does,
not a button).

| Where | What you see | Example |
|---|---|---|
| **Plugins panel** (top bar → *Plugins* tab) | Every loaded `fabula-*` plugin, green = healthy | the `13 Plugins` list — `fabula-graph`, `fabula-handoff`, `fabula-ops`, … are live |
| **Tool calls in chat** | The model invoking a tool, by name | `workflow_graph`, `save_handoff`, `schedule_task`, `mixture_of_agents`, `vision_analyze`, `text_to_speech` |
| **Workflow trace** | The tail of a `workflow_graph` answer | `workflow: 2 isolated step(s)` → `s1(research, cloud) → s2(synthesize, local)` |
| **Behavioral (hooks / opt-in)** | The agent *behaving* differently — no UI element | the model gets hard-stopped from re-reading a file; web results arrive wrapped in `<untrusted_tool_result>`; a phone push arrives when a run finishes |

**Opt-in features are loaded but dormant until you set an env var** (in `.env`): `FABULA_ROUTER`,
`FABULA_SOULS`, `FABULA_NTFY_TOPIC`. Until then the plugin is present (green in the panel) but the behavior is off.

---

## MiMoCode / OpenCode — the engine FABULA is derived from

**What:** the foundation FABULA-LLM-5 runs on — the agent loop, the plugin system (the `tool.execute.*`,
`chat.*`, `experimental.chat.system.transform` hooks every `fabula-*` plugin wires into), the multi-provider
model layer (100+ OpenAI-compatible providers), the web UI, and MCP support.
**Why:** building an agent loop from scratch is a year of work; MiMoCode is a mature OpenCode fork with exactly
the extension points we need — so the FABULA engine builds on it.
**Where:** all of it — `fabula.config.json`, the `plugin/fabula-*.ts` files, and the embedded web UI the macOS app hosts.
**See it:** the app hosts the engine's web UI; the top bar's *Servers / MCP / LSP / Plugins* panels come with it.

---

## pi — supervision mechanisms we studied and adapted

**What:** [pi](https://github.com/earendil-works/pi) (by Mario Zechner, MIT) is a minimal coding-agent
harness whose engineering write-ups shaped several FABULA supervision mechanisms. The implementations in
this repo are FABULA's own (different language, different engine, unit-tested here), but the *mechanism
designs* below trace back to pi and deserve the credit:

| Mechanism (pi origin) | FABULA implementation |
|---|---|
| Cross-provider conversation replay — tool-call-id normalization/remap, synthesizing results for orphaned calls, skipping errored turns (pi `transform-messages`) | `plugin/lib/xprovider.ts`, wired into `plugin/fabula-escalate.ts` |
| Context-overflow classification, incl. *silent* truncation (pi `overflow.ts` pattern matrix) | `proxy/adapter_util.py` → `classify_overflow`, wired into the `:1235` adapter |
| Prefix-cache telemetry — detect when the stable prompt prefix broke and the KV cache missed (pi cache-stats) | `proxy/adapter_util.py` → `stable_prefix` / `shared_prefix_len` (`CACHE-BREAK` log) |
| Bounded tool output — cap huge results, spill the full text to a file, return a continuation cursor | `plugin/lib/outputcap.ts`, wired into `bash_tool` |
| Drift-tolerant edits — normalize smart quotes / dashes / unicode spaces / BOM so a near-miss edit still lands | `plugin/lib/fuzzymatch.ts` (`unicode` normalizer) |
| Conversation rewind on failure — pi rewinds the conversation; FABULA extends the idea to an *atomic file rewind* to the last green shadow-git checkpoint | `plugin/fabula-rewind.ts` + `plugin/lib/rewind.ts` |
| Lean per-task tool exposure (a coding "tool belt" that hides irrelevant tools) | `plugin/lib/toolbelt.ts` + `plugin/lib/toolmeta.ts` (`FABULA_PROFILE=coding`) |

**Why:** pi demonstrated, with measurements, that a small set of deterministic harness mechanisms — not a
bigger model — is what makes an agent reliable. That is FABULA's thesis too, so we adopted the strongest
of those mechanisms and extended them (file-atomic rewind, kernel-level sandbox, self-firing gates).

---

## Reliability, security, verified-done, ops

| Capability | Where | How to verify it exists |
|---|---|---|
| **Loop-guard** (hard-stop repeated no-progress tool calls) | `fabula-reliability` + `lib/loopguard.ts` | Ask a weak local model to do something it loops on (e.g. re-reading one file). After a few identical no-progress calls it is **hard-stopped** with guidance instead of looping forever. |
| **Tool-arg repair** (malformed/extra-key tool calls still reach execution) | `fabula-reliability` + `lib/argrepair.ts` | A model that emits a slightly-wrong `actor`/tool argument shape still runs instead of erroring out. |
| **Security layer** (SSRF guard, secret redaction, untrusted-result wrapping, command/approval guards) | `fabula-security` + `lib/*` | Have the agent `web_fetch` a page — the result comes back inside a `<untrusted_tool_result>` wrapper; secrets in tool output/logs are redacted; dangerous shell commands are blocked/approval-gated. |
| **Verified-done** (a step must show evidence it finished) | `verify_done` tool + the graph's per-step `verifyStep` | Build-type steps that don't mention a check/test/verify are flagged, not silently accepted. |
| **Capability + ops tools** | `fabula-ops`, `fabula-multimodal`, `fabula-vision` | The `schedule_task`, `send_notification`, `vision_analyze`, `text_to_speech`, `transcribe_audio` tools appear in chat when used. |

---

## Workflow-graph + local→cloud router (local-first)

The workflow-graph is **local-first**: the local model is the default worker, and the cloud is an opt-in escalator.

| Capability | Where | How to verify it exists |
|---|---|---|
| **Workflow-graph with step isolation** — a planner emits ≤5 subtasks; each runs as an isolated model call seeded *only* by its dependencies' outputs (+ a role + STOP); independent steps run in parallel; results are synthesized | `fabula-graph` → tool **`workflow_graph`**, logic in `lib/graph.ts` | Call `workflow_graph` on a multi-part task. The answer ends with a trace: `workflow: N isolated step(s)` and one line per step (`id(role, local/cloud, needs:[…])`). `fabula-graph` is green in the Plugins panel. |
| **Local→cloud router** — rules decide per step whether it's "heavy" enough to escalate to the cloud model | `plugin/lib/router.ts`, gated `FABULA_ROUTER=1` | Set `FABULA_ROUTER=1` + a cloud key, then run a workflow with a research-type step → the trace shows that step routed `, cloud,` while light steps stay `, local,`. Off by default (local-only). |

---

## Autonomous-agent capabilities

These capabilities are local-first and opt-in.

| Capability | Where | How to verify it exists |
|---|---|---|
| **Outbound ntfy event pings** — phone push on run finished / errored / loop-guard block | `fabula-reliability`, gated `FABULA_NTFY_TOPIC` | Set `FABULA_NTFY_TOPIC=<topic>` and subscribe in the ntfy app. Finish a run / trigger a loop-guard block → a push arrives on your phone. |
| **Curated-memory injection** — your operating notes are injected into the system prompt | `fabula-context` | The model knows your house-rules (from `.fabula/memory/MEMORY.md`) without being told each session. |
| **Scheduler reliability + run-ledger** — recurring/one-off jobs via macOS `launchd`, with overdue detection and result capture | `fabula-ops` + `lib/heartbeat.ts`, `lib/schedule.ts` | Use `schedule_task` then `list_scheduled` — each job is annotated "last ran Xh ago / ⚠️ OVERDUE / never ran". |
| **Role preambles** — terse per-role "who runs this step + STOP" prefix on subagents | `plugin/lib/souls.ts`, gated `FABULA_SOULS=1` | With `FABULA_SOULS=1`, actor subagents get a short role/STOP preamble prepended to keep weak models on-task. |
| **Durable handoff artifacts** — structured, threat-scanned hand-offs between steps/sessions | `fabula-handoff` → `save_handoff` / `read_handoff` / `list_handoffs` | The three tools appear in chat when used; `read_handoff` returns content wrapped/threat-scanned; `fabula-handoff` is green in the Plugins panel. |

---

## A note on the tables above

These tables are **feature documentation** — each capability is a local-first implementation that runs on
your own machine and models. The MiMoCode / OpenCode engine is MIT/Apache-licensed and its terms are followed.
