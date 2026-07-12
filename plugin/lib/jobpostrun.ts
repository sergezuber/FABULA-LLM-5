// Scheduled-job POST-RUN harness. Runs as a CLI INSIDE the launchd job (via bun), reading
// the captured `fabula run` output on stdin. Closes two holes: (1) the unattended output (web-fetch in
// a 3am sweep = peak injection risk) reaches the phone WRAPPED as untrusted + threat-flagged — the in-process
// wrapUntrusted/scanThreats in fabula-security.ts only cover the interactive process, never this background
// one; (2) it stamps the run-ledger so a silent failure becomes visible. NOT a plugin (lib/ is never scanned
// as one); the import.meta.main tail fires only when run as a script, so importing buildJobMessage is safe.

import { wrapUntrusted } from "./untrusted"
import { scanThreats, threatBanner } from "./threatscan"
import { postNtfy } from "./notify"
import { stampLedger } from "./heartbeat"

// Pure + unit-testable: turn a raw unattended run output into the (untrusted-wrapped, threat-flagged) phone body.
export function buildJobMessage(raw: string, label: string, ok: boolean, offline: boolean): string {
  if (offline) return `job ${label}: model endpoint offline — did NOT run`
  const scan = scanThreats(raw || "")
  const banner = scan.injection ? threatBanner(scan.markers) : undefined
  const body = wrapUntrusted(raw && raw.length ? raw : "(no output)", "scheduled-job", banner)
  const head = ok ? `job ${label} done` : `job ${label} FAILED (rc≠0)`
  return (head + "\n\n" + body).slice(0, 3500)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const label = get("--label") || "job"
  const rc = parseInt(get("--rc") || "0", 10)
  const offline = argv.includes("--offline")
  const ledger = get("--ledger")
  const topic = get("--topic") || process.env.FABULA_NTFY_TOPIC
  let raw = ""
  if (!offline) { try { for await (const chunk of process.stdin) raw += chunk } catch {} }
  const ok = !offline && rc === 0
  const message = buildJobMessage(raw, label, ok, offline)
  if (topic) {
    try { await postNtfy({ topic, server: process.env.FABULA_NTFY_URL, title: "FABULA", message, priority: ok ? "default" : "high", tags: ok ? "robot" : "warning" }) } catch {}
  }
  if (ledger) { try { await stampLedger(ledger, label, { ranAt: Date.now(), ok }) } catch {} }
}
