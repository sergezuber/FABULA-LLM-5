// Push notification (ntfy). Pure request builder (unit-testable); the HTTP POST lives in
// the tool. Default server ntfy.sh; topic from arg or FABULA_NTFY_TOPIC. Lets a long task ping the phone.

export interface NtfyRequest { url: string; headers: Record<string, string>; body: string }

export function buildNtfy(opts: {
  topic?: string; server?: string; title?: string; message: string; priority?: string; tags?: string
}): NtfyRequest | null {
  const topic = (opts.topic || "").trim()
  if (!topic) return null
  const server = (opts.server || "https://ntfy.sh").replace(/\/+$/, "")
  const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8" }
  if (opts.title) headers["Title"] = sanitizeHeader(opts.title)
  if (opts.priority) headers["Priority"] = sanitizeHeader(opts.priority)
  if (opts.tags) headers["Tags"] = sanitizeHeader(opts.tags)
  return { url: `${server}/${encodeURIComponent(topic)}`, headers, body: String(opts.message ?? "") }
}

// HTTP headers can't contain CR/LF (header-injection) — strip them.
function sanitizeHeader(v: string): string {
  return String(v).replace(/[\r\n]+/g, " ").slice(0, 256)
}

// Build + POST in one call. NEVER throws (fire-and-forget friendly) and self-times-out at 3s so it can
// never hang a hook. Used by both the send_notification tool and the event-driven pings in
// fabula-reliability.ts (loopguard-abort / session.idle / session.error). Returns a result for testing.
export async function postNtfy(opts: Parameters<typeof buildNtfy>[0]): Promise<{ sent: boolean; status?: number; reason?: string }> {
  const req = buildNtfy(opts)
  if (!req) return { sent: false, reason: "no-topic" }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3000)
  try {
    const r = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: ctrl.signal })
    return { sent: r.ok, status: r.status }
  } catch (e: any) {
    return { sent: false, reason: String(e?.message || e).slice(0, 120) }
  } finally {
    clearTimeout(timer)
  }
}
