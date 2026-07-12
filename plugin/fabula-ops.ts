// FABULA-LLM-5 — ops (separate plugin per rule #4).
//   send_notification — ntfy push to the user's phone.
//   schedule_task / list_scheduled / cancel_scheduled — self-scheduling via macOS launchd. The
//       scheduled prompt is threat-scanned (injection guard) before any job is written.

import { tool } from "@mimo-ai/plugin"
import { gate } from "./lib/manage"
import type { Plugin } from "@mimo-ai/plugin"
import { promises as fs, existsSync, realpathSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { buildNtfy } from "./lib/notify"
import { sanitizeJobId, parseTime, buildPlist, buildJobCommand, LABEL_PREFIX } from "./lib/schedule"
import { scanThreats, threatBanner } from "./lib/threatscan"
import { readLedger, annotate } from "./lib/heartbeat"
import { isUncensoredModel, uncensoredPattern } from "./lib/distillguard"

const z = tool.schema
const ENGINE = process.env.FABULA_ENGINE_BIN ||
  ["/opt/homebrew/bin/fabula", "/usr/local/bin/fabula", path.join(os.homedir(), ".local", "bin", "fabula"),
   "/opt/homebrew/bin/mimo"].find((p) => existsSync(p)) || "fabula"
const DOTENV = process.env.FABULA_DOTENV || path.join(os.homedir(), "GitHub", "FABULA-LLM-5", ".env")
const AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents")
// Under the engine data dir (app id "fabula"), namespaced in an ops/ subdir so scheduled-job logs don't
// mix with the engine's own ~/.local/share/fabula/log.
const OPS_DATA = process.env.FABULA_OPS_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "fabula", "ops")
const LOG_DIR = path.join(OPS_DATA, "log")
// Scheduled-job post-run harness wiring.
const LEDGER = path.join(OPS_DATA, "schedule-state.json")
const PLUGIN_DIR = (() => { try { return path.dirname(realpathSync(fileURLToPath(import.meta.url))) } catch { return path.dirname(fileURLToPath(import.meta.url)) } })()
const JOBPOSTRUN = path.join(PLUGIN_DIR, "lib", "jobpostrun.ts")
const BUN_BIN = process.env.FABULA_BUN_BIN ||
  [path.join(os.homedir(), ".bun", "bin", "bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"].find((p) => existsSync(p)) || "bun"
const PREFLIGHT_URL = process.env.FABULA_PREFLIGHT_URL || "http://localhost:1235/v1/models"
const UNCENSORED_PAT = uncensoredPattern(process.env)

function run(bin: string, args: string[], input?: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(bin, args)
    let out = ""
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d))
    if (input) { c.stdin.write(input); c.stdin.end() }
    c.on("close", (code) => resolve({ code, out }))
    c.on("error", (e) => resolve({ code: -1, out: e.message }))
  })
}

export const FabulaOps: Plugin = async () => gate("ops", ({
  tool: {
    // ────────────────────────────────────────────────────────────────
    send_notification: tool({
      description: "Send a push notification to the user's phone via ntfy (e.g. when a long task finishes). " +
        "Set FABULA_NTFY_TOPIC (subscribe to it in the ntfy app) or pass `topic`.",
      args: {
        message: z.string().describe("Notification body"),
        title: z.string().nullish().describe("Notification title"),
        priority: z.string().nullish().describe("min|low|default|high|urgent"),
        tags: z.string().nullish().describe("Comma-separated emoji tags, e.g. white_check_mark"),
        topic: z.string().nullish().describe("ntfy topic (else FABULA_NTFY_TOPIC)"),
      },
      async execute(args: any) {
        const req = buildNtfy({
          topic: args.topic || process.env.FABULA_NTFY_TOPIC, server: process.env.FABULA_NTFY_URL,
          title: args.title, message: args.message, priority: args.priority, tags: args.tags,
        })
        if (!req) return "send_notification: no ntfy topic. Set FABULA_NTFY_TOPIC (and subscribe in the ntfy app), or pass `topic`."
        try {
          const r = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body })
          return r.ok ? { output: `Notification sent to ${req.url}.`, metadata: { status: r.status } } : `send_notification: HTTP ${r.status}.`
        } catch (e: any) { return `send_notification error: ${e.message}` }
      },
    }),

    // ────────────────────────────────────────────────────────────────
    schedule_task: tool({
      description: "Schedule a prompt to run later via a headless engine run (`fabula run`) at a daily time (macOS launchd). Use to set " +
        "reminders or recurring jobs. The prompt is injection-scanned before scheduling. one_shot removes the job after first run.",
      args: {
        name: z.string().describe("Short job name (kebab-case)"),
        at_time: z.string().describe("Daily run time, 24h HH:MM"),
        prompt: z.string().describe("The prompt the engine will run"),
        model: z.string().nullish().describe("Model id (else config default)"),
        one_shot: z.boolean().nullish().describe("Run once then self-remove"),
        notify_on_done: z.boolean().nullish().describe("Push the run's result to your phone (ntfy) when it finishes — wrapped as untrusted + threat-scanned — and record run-state for list_scheduled. Needs FABULA_NTFY_TOPIC."),
      },
      async execute(args: any, ctx: any) {
        const scan = scanThreats(args.prompt)
        if (scan.injection) return `[BLOCKED] schedule_task refused: the prompt shows injection signals (${scan.markers.join(", ")}). ${threatBanner(scan.markers)}`
        const slug = sanitizeJobId(args.name)
        if (!slug) return `schedule_task: invalid name "${args.name}".`
        const time = parseTime(args.at_time)
        if (!time) return `schedule_task: invalid time "${args.at_time}" (use 24h HH:MM).`
        // Refuse a RECURRING (not one-shot) UNATTENDED job on an uncensored model: an uncensored agent
        // looping with no human in the loop is exactly what we gate distill on. one-shot stays allowed.
        if (!args.one_shot && args.model && isUncensoredModel(args.model, UNCENSORED_PAT)) {
          return `[BLOCKED] schedule_task refused: recurring unattended jobs are not allowed on the uncensored model "${args.model}". Use one_shot, or schedule on the aligned default model.`
        }
        const label = LABEL_PREFIX + slug
        const plistPath = path.join(AGENTS_DIR, `${label}.plist`)
        const logPath = path.join(LOG_DIR, `schedule-${slug}.log`)
        // Opt-in post-run notify+ledger. Preflight only for a LOCAL model (cloud is always up).
        const local = !args.model || /^lmstudio\//.test(args.model)
        const notify = args.notify_on_done
          ? { bun: BUN_BIN, helper: JOBPOSTRUN, ledger: LEDGER, label: slug, preflightUrl: local ? PREFLIGHT_URL : undefined }
          : undefined
        const command = buildJobCommand({
          workspace: ctx.directory, dotenv: DOTENV, engine: ENGINE, model: args.model, prompt: args.prompt,
          oneShot: !!args.one_shot, plistPath, label, notify,
        })
        const plist = buildPlist({ label, command, hour: time.hour, minute: time.minute, logPath })
        try {
          await fs.mkdir(AGENTS_DIR, { recursive: true }); await fs.mkdir(LOG_DIR, { recursive: true })
          await fs.writeFile(plistPath, plist, "utf8")
          await run("launchctl", ["unload", plistPath]) // idempotent: drop a prior version
          const r = await run("launchctl", ["load", plistPath])
          if (r.code !== 0) return `schedule_task: wrote ${plistPath} but launchctl load failed: ${r.out.slice(-200)}`
          return { output: `Scheduled "${slug}" daily at ${args.at_time}${args.one_shot ? " (one-shot)" : ""}. Logs → ${logPath}. Cancel with cancel_scheduled.`, metadata: { label, plistPath } }
        } catch (e: any) { return `schedule_task error: ${e.message}` }
      },
    }),

    list_scheduled: tool({
      description: "List FABULA scheduled jobs (launchd LaunchAgents created by schedule_task).",
      args: { description: z.string().nullish().describe("Why") },
      async execute() {
        try {
          if (!existsSync(AGENTS_DIR)) return "No scheduled jobs."
          const jobs = (await fs.readdir(AGENTS_DIR)).filter((f) => f.startsWith(LABEL_PREFIX) && f.endsWith(".plist"))
          if (!jobs.length) return "No scheduled jobs."
          const led = await readLedger(LEDGER)
          const now = Date.now()
          const lines = jobs.map((j) => { const slug = j.slice(LABEL_PREFIX.length, -6); return "  - " + annotate(slug, LABEL_PREFIX + slug, led, now) })
          return { output: "Scheduled jobs:\n" + lines.join("\n"), metadata: { count: jobs.length } }
        } catch (e: any) { return `list_scheduled error: ${e.message}` }
      },
    }),

    cancel_scheduled: tool({
      description: "Cancel a scheduled job by name (created via schedule_task).",
      args: { name: z.string().describe("Job name to cancel") },
      async execute(args: any) {
        const slug = sanitizeJobId(args.name)
        if (!slug) return `cancel_scheduled: invalid name "${args.name}".`
        const plistPath = path.join(AGENTS_DIR, `${LABEL_PREFIX}${slug}.plist`)
        if (!existsSync(plistPath)) return `cancel_scheduled: no job named "${slug}".`
        await run("launchctl", ["unload", plistPath])
        try { await fs.rm(plistPath, { force: true }) } catch {}
        return `Cancelled scheduled job "${slug}".`
      },
    }),
  },
}))
