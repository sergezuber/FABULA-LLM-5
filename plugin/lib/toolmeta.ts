// Per-tool metadata: coding-relevance (drives the coding-profile schema mask) + belt prompt snippet
// + guidelines shown only while the tool is active. Single source of truth for the tool belt; keep in
// sync with plugin/lib/manifest.ts tool lists. `coding: false` tools are masked from the request in the
// coding profile — that is the prefill win (~24 non-coding schemas dropped). Tools not listed default
// to coding (visible) so nothing new silently disappears.
import type { ToolMeta } from "./toolbelt"

export const TOOL_META: Record<string, ToolMeta> = {
  // ── coding-core (fabula-tools) — kept, with belt snippets ──
  view: { snippet: "read a file (whole files, with line numbers)", guidelines: ["Read whole files, not snippets, before editing."] },
  str_replace: { snippet: "exact-match file edit", guidelines: ["Keep the matched text minimal but unique; include enough context to match exactly once."] },
  create_file: { snippet: "create a new file" },
  bash_tool: { snippet: "run a shell command (guarded)" },
  execute_code: { snippet: "run python/js in a sandbox" },
  web_fetch: { snippet: "fetch a URL as clean markdown" },
  web_search: { snippet: "private web search" },
  session_search: { snippet: "search past sessions for prior work" },
  mixture_of_agents: { snippet: "cross-review with several models" },
  verify_done: { snippet: "run the project's checks and prove the task is done" },

  // ── coding meta / supervision (kept) ──
  workflow_graph: { snippet: "decompose a big task into isolated parallel substeps" },
  reference_hunt: { snippet: "read analogous source as the spec" },
  surface_unknowns: { snippet: "surface blindspots for a task" },
  interview_me: { snippet: "triage a task's unknowns" },
  change_quiz: { snippet: "comprehension check on your own diff" },
  brainstorm_prototypes: { snippet: "generate throwaway design variations" },
  implementation_note: { snippet: "record a decision/deviation" },
  pitch_packager: { snippet: "write a reviewer buy-in doc from the diff" },
  create_plugin: { snippet: "author a new tool/plugin for yourself when one is missing" },
  expand_tools: { snippet: "use a tool hidden by the active belt (execute it or get its schema)" },
  save_handoff: { snippet: "persist a durable handoff note" },
  read_handoff: {}, list_handoffs: {},
  list_checkpoints: { snippet: "list edit checkpoints" },
  restore_checkpoint: { snippet: "undo the agent's edits" },
  diff_checkpoints: {},
  set_permission_mode: {}, allow_command: {},
  list_plugins: {}, check_deps: {}, install_plugin_deps: {}, enable_plugin: {}, disable_plugin: {},

  // ── NON-CODING (masked in the coding profile) ──
  image_search: { coding: false },
  weather_fetch: { coding: false },
  places_search: { coding: false },
  vision_analyze: { coding: false },
  text_to_speech: { coding: false },
  transcribe_audio: { coding: false },
  sync_model_vision: { coding: false },
  schedule_task: { coding: false },
  list_scheduled: { coding: false },
  cancel_scheduled: { coding: false },
  send_notification: { coding: false },
  browser_navigate: { coding: false },
  browser_snapshot: { coding: false },
  browser_click: { coding: false },
  browser_type: { coding: false },
  browser_scroll: { coding: false },
  browser_vision: { coding: false },
  browser_back: { coding: false },
  browser_press: { coding: false },
  browser_get_images: { coding: false },
  browser_console: { coding: false },
  browser_dialog: { coding: false },
  browser_cdp: { coding: false },
  browser_close: { coding: false },
}
