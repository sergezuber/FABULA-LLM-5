// FABULA daemon (KAIROS, § disrupt #2) — the always-on autonomous posture, done honestly.
//
// When FABULA_DAEMON=1, a system-prompt block turns the session into an autonomous worker: it paces
// itself with `sleep`, acts on its own judgment, and — the FABULA twist — anything it lands overnight
// still runs the same gates and mints a replayable receipt, so background "done" can't be a lie.
//
// What's real vs. what the spec imagined:
//   • sleep            — a cache-aware pacing tool (the engine's tick/wakeup loop consumes the duration).
//   • terminal_focus   — read from FABULA_TERMINAL_FOCUS (a real signal), NOT fabricated detection.
//   • check_pr_activity— POLLS GitHub via `gh` and returns NEW comments/check-runs since the last poll.
//                        (True webhooks need an inbound message channel the engine, not a plugin, owns —
//                         so this is honest polling, not a fake subscription.)
// Decision logic (pacing, posture, PR diffing) is the pure lib/daemon.ts; this file is the tool/hook glue.

import { tool } from "@mimo-ai/plugin"
import type { Plugin } from "@mimo-ai/plugin"
import { execFileSync } from "node:child_process"
import { gate } from "./lib/manage"
import { sleepAdvice, daemonSystem, parsePrEvents, newEventsSince, type PrEvent } from "./lib/daemon"

const z = tool.schema

function daemonActive(): boolean {
  return process.env.FABULA_DAEMON === "1" || process.env.FABULA_DAEMON === "true"
}

let tickCounter = 0
const seenByPr = new Map<string, Set<string>>() // "owner/repo#pr" → seen event ids

function gh(args: string[], timeoutMs = 20000): string {
  return execFileSync("gh", args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function pollPr(repo: string, pr: number): { events: PrEvent[] } | { error: string } {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" })
  } catch {
    return { error: "the `gh` CLI is not installed — install GitHub CLI and `gh auth login` to poll PR activity" }
  }
  try {
    const headSha = gh(["api", `repos/${repo}/pulls/${pr}`, "--jq", ".head.sha"])
    const comments = JSON.parse(gh(["api", `repos/${repo}/issues/${pr}/comments`]) || "[]")
    const checks = headSha ? JSON.parse(gh(["api", `repos/${repo}/commits/${headSha}/check-runs`, "--jq", ".check_runs"]) || "[]") : []
    return { events: parsePrEvents(comments, checks) }
  } catch (e) {
    return { error: `gh poll failed for ${repo}#${pr} — ${e instanceof Error ? e.message.slice(0, 200) : String(e)} (is gh authenticated? does the PR exist?)` }
  }
}

export const FabulaDaemon: Plugin = async () =>
  gate("daemon", {
    tool: {
      sleep: tool({
        description:
          "Pace yourself between autonomous ticks: request how long to wait before the next wake-up. If you " +
          "have nothing useful to do on a tick, you MUST call this instead of replying with a status line. " +
          "The wait is cache-aware — staying under 5 minutes reuses the warm prompt cache.",
        args: {
          duration_ms: z.number().nullish().describe("Milliseconds to wait before the next tick (e.g. 120000 = 2 min)."),
        },
        async execute(args: any) {
          const a = sleepAdvice(args?.duration_ms)
          const tick = ++tickCounter
          return `💤 sleep ${a.ms}ms (tick ${tick}) — ${a.note}`
        },
      }),

      check_pr_activity: tool({
        description:
          "Poll a GitHub PR for NEW activity since your last check — new comments and CI/check-run results — " +
          "so an autonomous session can react to review feedback and CI. Uses the `gh` CLI (must be authenticated). " +
          "Returns only events not seen on a prior poll of the same PR.",
        args: {
          repo: z.string().describe('"owner/repo".'),
          pr_number: z.number().describe("The pull request number."),
        },
        async execute(args: any) {
          const repo = String(args?.repo || "")
          const pr = Number(args?.pr_number)
          if (!/^[^/]+\/[^/]+$/.test(repo) || !Number.isInteger(pr) || pr <= 0)
            return "check_pr_activity: pass repo as 'owner/repo' and a positive pr_number."
          const res = pollPr(repo, pr)
          if ("error" in res) return `check_pr_activity: ${res.error}`
          const key = `${repo}#${pr}`
          const seen = seenByPr.get(key) ?? new Set<string>()
          const fresh = newEventsSince(res.events, [...seen])
          res.events.forEach((e) => seen.add(e.id))
          seenByPr.set(key, seen)
          if (fresh.length === 0) return `check_pr_activity: no new activity on ${key} since last check.`
          return `${fresh.length} new event(s) on ${key}:\n` + fresh.map((e) => `• [${e.kind}] ${e.who} ${e.at}\n  ${e.body}`).join("\n")
        },
      }),
    },

    // In daemon mode, inject the KAIROS autonomous-work posture + the current terminal-focus posture.
    // Read (not fabricated): FABULA_TERMINAL_FOCUS = "focused" | "unfocused". Off unless FABULA_DAEMON=1.
    "experimental.chat.system.transform": async (_i: any, output: any) => {
      if (!daemonActive() || !output || !Array.isArray(output.system)) return
      try {
        output.system.push(daemonSystem(process.env.FABULA_TERMINAL_FOCUS))
      } catch {
        /* never break a turn over posture */
      }
    },
  })
