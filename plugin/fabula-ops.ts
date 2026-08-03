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
import { dataPath, findProgram } from "./lib/platform/paths"
import { jobDir, jobFile, planInstall, parseKnownJobs } from "./lib/platform/scheduler"
import { shellBin } from "./lib/platform/shell"

/** argv that asks THIS platform's scheduler what it knows. */
function schedulerListArgv(): string[] {
  return planInstall({ id: "probe", command: "", hour: 0, minute: 0, logPath: "" }, { shell: shellBin() }).listArgv
}

/** The labels the system scheduler is actually running, or null when launchd could not be asked. `null` is NOT an
 *  empty set: reporting every job as an orphan because a probe failed would be its own false claim. */
async function loadedLabels(): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    try {
      const listArgv = schedulerListArgv()
      const c = spawn(listArgv[0]!, listArgv.slice(1))
      let out = ""
      const t = setTimeout(() => { try { c.kill() } catch {} ; resolve(null) }, 4000)
      c.stdout.on("data", (d) => { out += d.toString() })
      c.on("error", () => { clearTimeout(t); resolve(null) })
      c.on("close", (code) => {
        clearTimeout(t)
        if (code !== 0 && !out) return resolve(null)
        // Every scheduler prints the label somewhere on its line and formats the rest differently;
        // only "does it know this label" is being asked, so only that is parsed.
        resolve(new Set(parseKnownJobs(out).map((id) => LABEL_PREFIX + id)))
      })
    } catch { resolve(null) }
  })
}

const z = tool.schema
const ENGINE = process.env.FABULA_ENGINE_BIN || findProgram("fabula")
const DOTENV = process.env.FABULA_DOTENV || path.join(os.homedir(), "GitHub", "FABULA-LLM-5", ".env")
// WHERE job definitions live is the scheduler's business, not this file's: a LaunchAgents directory on
// macOS, `~/.config/systemd/user` on Linux, and NOTHING on Windows (Task Scheduler owns its own store,
// which is also why there is no orphan file to mistake for a job there).
const AGENTS_DIR = jobDir()
// Under the engine data dir (app id "fabula"), namespaced in an ops/ subdir so scheduled-job logs don't
// mix with the engine's own ~/.local/share/fabula/log.
const OPS_DATA = process.env.FABULA_OPS_DIR ||
  dataPath("ops")
const LOG_DIR = path.join(OPS_DATA, "log")
// Scheduled-job post-run harness wiring.
const LEDGER = path.join(OPS_DATA, "schedule-state.json")
const PLUGIN_DIR = (() => { try { return path.dirname(realpathSync(fileURLToPath(import.meta.url))) } catch { return path.dirname(fileURLToPath(import.meta.url)) } })()
const JOBPOSTRUN = path.join(PLUGIN_DIR, "lib", "jobpostrun.ts")
const BUN_BIN = process.env.FABULA_BUN_BIN || findProgram("bun")
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
        const plistPath = jobFile(slug)
        const logPath = path.join(LOG_DIR, `schedule-${slug}.log`)
        // Opt-in post-run notify+ledger. Preflight only for a LOCAL model (cloud is always up).
        const local = !args.model || /^lmstudio\//.test(args.model)
        const notify = args.notify_on_done
          ? { bun: BUN_BIN, helper: JOBPOSTRUN, ledger: LEDGER, label: slug, preflightUrl: local ? PREFLIGHT_URL : undefined }
          : undefined
        const command = buildJobCommand({
          workspace: ctx.directory, dotenv: DOTENV, engine: ENGINE, model: args.model, prompt: args.prompt,
          oneShot: !!args.one_shot, plistPath: plistPath ?? undefined, label, notify,
        })
        // Same three steps on every platform: write the definition (if this scheduler keeps one), drop any
        // prior version, register. Which commands those are is the platform's answer, not this file's.
        const plan = planInstall(
          { id: slug, command, hour: time.hour, minute: time.minute, logPath },
          { shell: shellBin() },
        )
        try {
          await fs.mkdir(LOG_DIR, { recursive: true })
          if (plan.filePath && plan.fileBody) {
            await fs.mkdir(path.dirname(plan.filePath), { recursive: true })
            await fs.writeFile(plan.filePath, plan.fileBody, "utf8")
          }
          await run(plan.unregisterArgv[0]!, plan.unregisterArgv.slice(1)) // idempotent: drop a prior version
          const r = await run(plan.registerArgv[0]!, plan.registerArgv.slice(1))
          if (r.code !== 0) return `schedule_task: could not register "${slug}" with the system scheduler (${plan.registerArgv[0]}): ${r.out.slice(-200)}`
          return { output: `Scheduled "${slug}" daily at ${args.at_time}${args.one_shot ? " (one-shot)" : ""}. Logs → ${logPath}. Cancel with cancel_scheduled.`, metadata: { label, plistPath: plan.filePath } }
        } catch (e: any) { return `schedule_task error: ${e.message}` }
      },
    }),

    list_scheduled: tool({
      description: "List FABULA scheduled jobs created by schedule_task, cross-checked against the system scheduler.",
      args: { description: z.string().nullish().describe("Why") },
      async execute() {
        try {
          // A scheduler that keeps no files of ours (Task Scheduler) is asked directly; one that does is
          // read from disk AND cross-checked against the scheduler below, because a file is not a schedule.
          const known0 = await loadedLabels()
          const jobs = AGENTS_DIR && existsSync(AGENTS_DIR)
            ? (await fs.readdir(AGENTS_DIR)).filter((f) => f.startsWith(LABEL_PREFIX) && (f.endsWith(".plist") || f.endsWith(".timer")))
            : [...(known0 ?? [])].map((l) => `${l}.plist`)
          if (!jobs.length) return "No scheduled jobs."
          const led = await readLedger(LEDGER)
          const now = Date.now()
          // ASK LAUNCHD, do not infer from the directory.
          //
          // MEASURED 2026-08-01: `~/Library/LaunchAgents` held two `com.fabula.schedule.*` plists left
          // over from a run three weeks earlier — their command still cd'd into a directory named after
          // that day — and `launchctl list` had never heard of either. This tool nevertheless printed
          // both as "Scheduled jobs", so a user asking what is scheduled was told two jobs are armed
          // that cannot ever fire. A file on disk is a job description; only launchd knows what is
          // LOADED. When launchd cannot be asked at all, nothing is claimed either way rather than the
          // old claim being made silently.
          const loaded = known0
          const lines = jobs.map((j) => {
            const slug = j.replace(/\.(plist|timer)$/, "").slice(LABEL_PREFIX.length)
            const label = LABEL_PREFIX + slug
            const state = !loaded ? "" : loaded.has(label) ? "" : "  ⚠️ NOT LOADED (launchd does not know this job — it cannot fire; cancel_scheduled removes the leftover file)"
            return "  - " + annotate(slug, label, led, now) + state
          })
          const live = loaded ? jobs.filter((j) => loaded.has(LABEL_PREFIX + j.replace(/\.(plist|timer)$/, "").slice(LABEL_PREFIX.length))).length : jobs.length
          return {
            output: "Scheduled jobs:\n" + lines.join("\n"),
            metadata: { count: jobs.length, loaded: live, orphans: jobs.length - live },
          }
        } catch (e: any) { return `list_scheduled error: ${e.message}` }
      },
    }),

    cancel_scheduled: tool({
      description: "Cancel a scheduled job by name (created via schedule_task).",
      args: { name: z.string().describe("Job name to cancel") },
      async execute(args: any) {
        const slug = sanitizeJobId(args.name)
        if (!slug) return `cancel_scheduled: invalid name "${args.name}".`
        const plistPath = jobFile(slug)
        // On a scheduler that keeps no file of ours (Task Scheduler), existence is the scheduler's answer,
        // not the filesystem's — so ask it rather than concluding "no such job" from an empty directory.
        const known = await loadedLabels()
        const exists = plistPath ? existsSync(plistPath) : !!known?.has(LABEL_PREFIX + slug)
        if (!exists && !known?.has(LABEL_PREFIX + slug)) return `cancel_scheduled: no job named "${slug}".`
        const plan = planInstall({ id: slug, command: "", hour: 0, minute: 0, logPath: "" }, { shell: shellBin() })
        await run(plan.unregisterArgv[0]!, plan.unregisterArgv.slice(1))
        if (plistPath) { try { await fs.rm(plistPath, { force: true }) } catch {} }
        return `Cancelled scheduled job "${slug}".`
      },
    }),
  },
}))
