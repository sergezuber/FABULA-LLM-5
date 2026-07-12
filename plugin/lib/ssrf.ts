// SSRF / cloud-metadata floor.
// Pure IP classification (sync, unit-testable) + async URL check with DNS resolve (fail-closed,
// anti-rebinding). Called from web_fetch/web_search/image_search and the native `webfetch` gate.

import { promises as dns } from "node:dns"
import { containsHardSecret } from "./redact"

export interface UrlVerdict { blocked: boolean; reason: string; code: string }
const OK: UrlVerdict = { blocked: false, reason: "", code: "allow" }

// Cloud metadata endpoints — ALWAYS blocked (AWS/GCP/Azure/Alibaba/OpenStack).
const METADATA_IPS = new Set([
  "169.254.169.254", // AWS/GCP/Azure/OpenStack IMDS
  "169.254.170.2",   // AWS ECS task metadata
  "100.100.100.200", // Alibaba Cloud
  "fd00:ec2::254",   // AWS IPv6 IMDS
])
const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
])

// Allow only http/https. file:, gopher:, ftp:, data:, dict: etc. are SSRF vectors.
const ALLOWED_SCHEMES = new Set(["http:", "https:"])

/** Parse an IPv4 dotted string → 32-bit int, or null. */
function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const o = m.slice(1).map(Number)
  if (o.some((n) => n > 255)) return null
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0
}
function inCidr(ipInt: number, netStr: string, bits: number): boolean {
  const net = ipv4ToInt(netStr)!
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ipInt & mask) === (net & mask)
}

/** Classify a literal IP (v4 or v6) as private/loopback/link-local/metadata → blocked. */
export function isBlockedIp(ip: string): { blocked: boolean; code: string } {
  const host = ip.replace(/^\[|\]$/g, "").toLowerCase()
  if (METADATA_IPS.has(host)) return { blocked: true, code: "cloud_metadata" }

  // IPv4-mapped / -embedded IPv6 (::ffff:169.254.169.254, ::ffff:a.b.c.d) → classify the v4 part
  const mapped = host.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/)
  const v4 = ipv4ToInt(host) !== null ? host : mapped ? mapped[1] : null

  if (v4) {
    const n = ipv4ToInt(v4)
    if (n === null) return { blocked: false, code: "" }
    if (METADATA_IPS.has(v4)) return { blocked: true, code: "cloud_metadata" }
    if (inCidr(n, "127.0.0.0", 8)) return { blocked: true, code: "loopback" }
    if (inCidr(n, "10.0.0.0", 8)) return { blocked: true, code: "rfc1918" }
    if (inCidr(n, "172.16.0.0", 12)) return { blocked: true, code: "rfc1918" }
    if (inCidr(n, "192.168.0.0", 16)) return { blocked: true, code: "rfc1918" }
    if (inCidr(n, "169.254.0.0", 16)) return { blocked: true, code: "link_local" }
    if (inCidr(n, "100.64.0.0", 10)) return { blocked: true, code: "cgnat" }
    if (inCidr(n, "0.0.0.0", 8)) return { blocked: true, code: "this_host" }
    if (inCidr(n, "192.0.0.0", 24)) return { blocked: true, code: "ietf_special" }
    return { blocked: false, code: "" }
  }

  // IPv6 specials
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return { blocked: true, code: "loopback" }
  if (host === "::" ) return { blocked: true, code: "this_host" }
  if (/^fe80:/.test(host)) return { blocked: true, code: "link_local" }       // link-local
  if (/^f[cd][0-9a-f][0-9a-f]:/.test(host)) return { blocked: true, code: "ula" } // fc00::/7 unique-local
  return { blocked: false, code: "" }
}

/** Synchronous structural check: scheme, credentials, literal-IP host, metadata hostnames. */
export function checkUrlSync(rawUrl: string): UrlVerdict {
  let u: URL
  try { u = new URL(rawUrl) } catch { return { blocked: true, reason: `malformed URL: ${String(rawUrl).slice(0, 80)}`, code: "malformed" } }
  if (!ALLOWED_SCHEMES.has(u.protocol))
    return { blocked: true, reason: `scheme ${u.protocol} is not allowed (only http/https) — SSRF vector.`, code: "bad_scheme" }
  const host = decodeURIComponent(u.hostname).toLowerCase().replace(/\.$/, "")
  if (METADATA_HOSTS.has(host))
    return { blocked: true, reason: `${host} is a cloud metadata endpoint.`, code: "cloud_metadata" }
  if (host === "localhost" || host.endsWith(".localhost"))
    return { blocked: true, reason: `${host} is a loopback alias.`, code: "loopback" }
  const ipv = isBlockedIp(host)
  if (ipv.blocked)
    return { blocked: true, reason: `host ${host} is a ${ipv.code} address (internal/SSRF-sensitive).`, code: ipv.code }
  // 2.5 — secret exfiltration: a fetch URL that embeds an API key/token is data exfil. Check the
  // raw URL AND a URL-decoded copy (attackers percent-encode to evade).
  let decoded = rawUrl
  try { decoded = decodeURIComponent(rawUrl) } catch {}
  if (containsHardSecret(rawUrl) || containsHardSecret(decoded))
    return { blocked: true, reason: "the URL embeds what looks like an API key/token — refusing to exfiltrate a secret to a remote host.", code: "secret_exfil" }
  return OK
}

/**
 * Full async check: structural + DNS resolve (fail-closed) so a hostname that resolves to an
 * internal/metadata IP is blocked too (anti-DNS-rebinding floor). Returns OK only if EVERY
 * resolved address is public.
 */
export async function checkUrl(rawUrl: string): Promise<UrlVerdict> {
  const structural = checkUrlSync(rawUrl)
  if (structural.blocked) return structural
  let host: string
  try { host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "") } catch { return structural }
  // If host is already a literal IP, checkUrlSync covered it.
  if (ipv4ToInt(host) !== null || host.includes(":")) return structural
  let addrs: string[] = []
  try {
    const res = await dns.lookup(host, { all: true })
    addrs = res.map((r) => r.address)
  } catch {
    return { blocked: true, reason: `DNS resolution failed for ${host} (fail-closed).`, code: "dns_fail" }
  }
  for (const a of addrs) {
    const v = isBlockedIp(a)
    if (v.blocked) return { blocked: true, reason: `${host} resolves to ${a}, a ${v.code} address (SSRF).`, code: v.code }
  }
  return OK
}

export function ssrfBlockedMessage(v: UrlVerdict, url: string): string {
  return `[BLOCKED by FABULA security — ssrf:${v.code}] Refused to fetch ${String(url).slice(0, 200)}: ${v.reason} ` +
    `Internal/metadata addresses are off-limits. Use a public URL.`
}

// SSRF-safe fetch for ARBITRARY (model-supplied) URLs — validates the initial URL AND every redirect hop,
// following redirects manually. Lives in lib/ (NOT a plugin file) because the engine treats every exported
// function in a plugin file as a plugin and calls it; helpers must therefore live here. Self-contained.
export async function safeFetch(url: string, opts: any = {}, ms = 40000, maxRedirects = 5): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const v = await checkUrl(current)
    if (v.blocked) throw new Error(`web_fetch refused (SSRF ${v.code}): ${v.reason}`)
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms)
    let r: Response
    try { r = await fetch(current, { ...opts, redirect: "manual", signal: ctl.signal, headers: { "User-Agent": "FABULA-LLM-5/1.0 (local research agent)", ...(opts.headers || {}) } }) }
    finally { clearTimeout(t) }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location")
      if (!loc) return r
      current = new URL(loc, current).toString()
      continue
    }
    return r
  }
  throw new Error("web_fetch refused: too many redirects (possible redirect loop / SSRF).")
}
