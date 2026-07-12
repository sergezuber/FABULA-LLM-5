// FABULA-LLM-5 — security layer (separate plugin file per the one-plugin-per-file rule).
// Single chokepoint design: THROWING in `tool.execute.before`
// ABORTS the tool and surfaces a clean tool-error to the model (execute() never runs). So one
// before-hook gates BOTH native and plugin tools uniformly — no need to disable native tools or
// rely on `permission.ask` (which doesn't fire for plugin tools).
//
//   command blocklist  (lib/cmdguard) — bash / bash_tool
//   SSRF / metadata     (lib/ssrf)     — web_fetch / native webfetch
//   write-path guard    (lib/pathguard)— write/edit/patch / create_file / str_replace
//   secret redaction    (lib/redact)   — every tool output, before it enters context
//   untrusted-wrap      (lib/untrusted)— external web/MCP results (anti prompt-injection)

import type { Plugin } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import { checkCommand, blockedMessage } from "./lib/cmdguard"
import { checkUrl, ssrfBlockedMessage } from "./lib/ssrf"
import { checkWritePath, writeBlockedMessage } from "./lib/pathguard"
import { redactSecrets } from "./lib/redact"
import { wrapUntrusted, isUntrustedTool } from "./lib/untrusted"
import { scanThreats, threatBanner } from "./lib/threatscan"
import { recordSessionAgent, isReadOnlyViolation, readOnlyBlockMessage } from "./lib/roles"
import { isPlanBlocked, planBlockMessage, shouldBypassGuards, editsPreApproved,
  permissionMode, setPermissionMode, commandSignature, allowCommand, revokeCommand } from "./lib/permissions"
import { tool } from "@mimo-ai/plugin"

const z = tool.schema

const SHELL_TOOLS = new Set(["bash", "bash_tool"])
const FETCH_TOOLS = new Set(["web_fetch", "webfetch"])
const WRITE_TOOLS = new Set(["write", "edit", "patch", "create_file", "str_replace"])

// Throwing here aborts the tool. The Error message becomes the model-visible result.
export const FabulaSecurity: Plugin = async () => gate("security", ({
  // Record which agent each session runs under, so the before-hook (which only gets sessionID) can
  // tell whether the caller is a read-only agent. Cheap, side-effect-free.
  "chat.message": async (input: any) => {
    recordSessionAgent(input?.sessionID, input?.agent)
  },

  "tool.execute.before": async (input: any, output: any) => {
    const tool = input?.tool
    const args = output?.args || {}

    // permission mode: plan = read-only planning (block writes). Checked first, before the guards.
    if (isPlanBlocked(tool, args)) throw new Error(planBlockMessage(tool))

    // read-only agent contract — an explore/research subagent (or FABULA_READONLY=1) may not write.
    if (isReadOnlyViolation(input?.sessionID, tool, args)) throw new Error(readOnlyBlockMessage(tool))

    // bypass mode OR a pre-allowed command → skip the guards below (still ran the read-only/plan gates
    // above, which are policy intent, not the catastrophic-command floor). Explicit user opt-in.
    if (shouldBypassGuards(tool, args)) return

    // Shell command hardline blocklist
    if (SHELL_TOOLS.has(tool)) {
      const cmd = args.command ?? args.cmd ?? ""
      const v = checkCommand(cmd)
      if (v.blocked) throw new Error(blockedMessage(v, cmd))
    }

    // SSRF / cloud-metadata floor (async DNS resolve, fail-closed)
    if (FETCH_TOOLS.has(tool) && typeof args.url === "string") {
      const v = await checkUrl(args.url)
      if (v.blocked) throw new Error(ssrfBlockedMessage(v, args.url))
    }

    // write-path guard — backdoor/persistence targets (softened when edits are pre-approved)
    if (WRITE_TOOLS.has(tool) && !editsPreApproved()) {
      const p = args.filePath ?? args.path ?? args.file ?? ""
      if (p) {
        const v = checkWritePath(p)
        if (v.blocked) throw new Error(writeBlockedMessage(v, p))
      }
    }
  },

  tool: {
    set_permission_mode: tool({
      description: "Set the permission mode (persists across restarts): default (normal guards), plan " +
        "(read-only — writes blocked), acceptEdits (file edits pre-approved), bypass (skip FABULA guards).",
      args: { mode: z.string().describe("default | plan | acceptEdits | bypass") },
      async execute(args: any) {
        const r = setPermissionMode(String(args.mode))
        return r.ok ? `Permission mode set to "${r.mode}".` : `set_permission_mode: ${r.error}`
      },
    }),
    allow_command: tool({
      description: "Pre-approve a specific command/tool call so the guards skip it in future (without a " +
        "global bypass). Pass the tool name and its key arg (a shell command, or a file path/URL). Use " +
        "revoke=true to remove it.",
      args: {
        tool_name: z.string().describe("The tool, e.g. bash_tool"),
        value: z.string().describe("The command string, or the path/url"),
        revoke: z.boolean().nullish().describe("true to remove the allowance"),
      },
      async execute(args: any) {
        const isBash = args.tool_name === "bash" || args.tool_name === "bash_tool"
        const sig = commandSignature(args.tool_name, isBash ? { command: args.value } : { path: args.value })
        if (args.revoke) { revokeCommand(sig); return `Revoked allowance for ${sig}.` }
        allowCommand(sig)
        return `Allowed ${sig} — the guards will skip this exact call. Current mode: ${permissionMode()}.`
      },
    }),
  },

  // Redact + untrusted-wrap, before the result enters context/history.
  "tool.execute.after": async (input: any, output: any) => {
    if (!output || typeof output.output !== "string") return
    // redact secrets from ANY tool output (bash/file/web could all surface one)
    const r = redactSecrets(output.output)
    let text = r.text
    // wrap attacker-controlled web/MCP results as untrusted data + threat-scan
    if (isUntrustedTool(input?.tool)) {
      const scan = scanThreats(text)                       // strips invisible/bidi, flags injection
      const banner = scan.injection ? threatBanner(scan.markers) : undefined
      text = wrapUntrusted(scan.cleaned, input.tool, banner)
    }
    output.output = text
  },
}))
