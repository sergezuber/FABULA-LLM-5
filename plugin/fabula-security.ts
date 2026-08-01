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
import { checkWritePath, writeBlockedMessage, isWriteToolName, writeTargets } from "./lib/pathguard"
import { shellWriteTargets, shellUrls } from "./lib/shelltargets"
import { redactSecrets } from "./lib/redact"
import { wrapUntrusted, isUntrustedTool } from "./lib/untrusted"
import { scanThreats, threatBanner } from "./lib/threatscan"
import { recordSessionAgent, isReadOnlyViolation, readOnlyBlockMessage } from "./lib/roles"
import { isPlanBlocked, planBlockMessage, shouldBypassGuards, editsPreApproved,
  permissionMode, setPermissionMode, commandSignature, allowCommand, revokeCommand,
  commandAllowanceOrigin } from "./lib/permissions"
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

      // THE SHELL IS A DOOR ONTO THE SAME ROOMS, so it asks the same rules.
      //
      // MEASURED 2026-08-01 through the LIVE app: the write guard refused `create_file` on
      // `~/Library/LaunchAgents/…plist` and the SSRF guard refused `web_fetch` on
      // `http://[::ffff:127.0.0.1]:4096/…` — and the model then did BOTH ANYWAY via `bash_tool`, with a
      // redirect and with curl, reporting each as completed. Not an attack: an agent routing around a
      // refusal to finish its task, which is the behaviour a guard has to survive. The rules were always
      // right; the shell simply never consulted them.
      for (const p of shellWriteTargets(cmd)) {
        const wv = checkWritePath(p)
        if (wv.blocked && (wv.code === "supervision_state" || !editsPreApproved())) {
          throw new Error(writeBlockedMessage(wv, p) + `\n(via the shell: ${String(cmd).slice(0, 160)})`)
        }
      }
      for (const u of shellUrls(cmd)) {
        const uv = await checkUrl(u)
        if (uv.blocked) throw new Error(ssrfBlockedMessage(uv, u) + `\n(via the shell: ${String(cmd).slice(0, 160)})`)
      }
    }

    // SSRF / cloud-metadata floor (async DNS resolve, fail-closed)
    if (FETCH_TOOLS.has(tool) && typeof args.url === "string") {
      const v = await checkUrl(args.url)
      if (v.blocked) throw new Error(ssrfBlockedMessage(v, args.url))
    }

    // write-path guard — backdoor/persistence targets.
    //
    // `acceptEdits` softens this for ordinary edits, which is its purpose. It must NOT soften the
    // supervision layer's own state: `acceptEdits` is a mode the agent can set on itself, so treating it
    // as blanket pre-approval let two sanctioned calls re-open every guard here — including the
    // authorized_keys / sudoers / cron / LaunchAgents rules that predate this wave. Pre-approving your
    // edits is not the same as pre-approving the file that says whether your edits are checked.
    // EVERY write, and every path it lands on — not five names and one argument. See isWriteToolName /
    // writeTargets in lib/pathguard.ts for what the old shape let through (apply_patch among them, which
    // for a gpt-class model is the ONLY write tool the engine exposes).
    if (WRITE_TOOLS.has(tool) || isWriteToolName(tool)) {
      for (const p of writeTargets(args)) {
        const v = checkWritePath(p)
        if (v.blocked && (v.code === "supervision_state" || !editsPreApproved())) {
          throw new Error(writeBlockedMessage(v, p))
        }
      }
    }
  },

  tool: {
    set_permission_mode: tool({
      description: "Set the permission mode (persists across restarts): default (normal guards), plan " +
        "(read-only — writes blocked), acceptEdits (file edits pre-approved). NOTE: 'bypass' (guards off) " +
        "is an OWNER setting — asking for it here is recorded but does NOT disable the guards; the owner " +
        "sets it in the app or via FABULA_PERMISSION_MODE.",
      args: { mode: z.string().describe("default | plan | acceptEdits") },
      async execute(args: any) {
        // origin "agent": this call came from the model. A bypass asked for here is stored and reported
        // but never honoured — supervision that its subject can switch off is not supervision.
        const r = setPermissionMode(String(args.mode), "agent")
        if (!r.ok) return `set_permission_mode: ${r.error}`
        return r.note ? `Permission mode "${r.mode}" ${r.note}` : `Permission mode set to "${r.mode}".`
      },
    }),
    allow_command: tool({
      description: "Record a request to pre-approve a specific command/tool call (a shell command, or a " +
        "file path/URL). NOTE: an allowance asked for here is RECORDED but NOT honoured — skipping the " +
        "guards for a call is an OWNER decision, exactly like 'bypass'. The owner approves it in the app " +
        "(Settings ▸ Permissions). Use revoke=true to remove one.",
      args: {
        tool_name: z.string().describe("The tool, e.g. bash_tool"),
        value: z.string().describe("The command string, or the path/url"),
        revoke: z.boolean().nullish().describe("true to remove the allowance"),
      },
      async execute(args: any) {
        const isBash = args.tool_name === "bash" || args.tool_name === "bash_tool"
        const sig = commandSignature(args.tool_name, isBash ? { command: args.value } : { path: args.value })
        if (args.revoke) { revokeCommand(sig); return `Revoked allowance for ${sig}.` }
        // origin "agent": this came from the model, so it is stored and reported but never honoured —
        // the same rule set_permission_mode applies to bypass. An allow-list its own subject can extend
        // is not an allow-list; it is a bypass switch with extra steps, and it was measured working as
        // one (`rm -rf /` blocked, then allowed, after a single call from inside a run).
        // Report the truth about what is already on the record before adding to it: if the owner has
        // ALREADY approved this exact signature, saying "not in effect" would be a lie in the other
        // direction, and the model would work around a guard that is not actually in its way.
        if (commandAllowanceOrigin(sig) === "owner") {
          return `${sig} is already allowed by the owner — the guards skip this exact call. Current mode: ${permissionMode()}.`
        }
        allowCommand(sig, "agent")
        return `Recorded a request to allow ${sig}, but it is NOT in effect: skipping the guards for a ` +
          `call is an owner decision. Ask the owner to approve it in Settings ▸ Permissions. ` +
          `Current mode: ${permissionMode()}.`
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
