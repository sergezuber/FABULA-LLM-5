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

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null if it is not one.
 *
 * MEASURED 2026-08-01, and this is why a parser replaced a regex. `isBlockedIp` had an explicit branch
 * for `::ffff:<dotted-ipv4>` — and it was UNREACHABLE from every URL, because
 * `new URL("http://[::ffff:169.254.169.254]/").hostname` returns `[::ffff:a9fe:a9fe]`: the WHATWG parser
 * canonicalises the embedded v4 into HEX before any guard sees it. So the branch only ever fired when
 * called directly with the dotted spelling, which `checkUrlSync` never does. Proven exploitable to this
 * machine's own services: `safeFetch("http://127.0.0.1:9/")` refused, `safeFetch("http://[::ffff:127.0.0.1]:9/")`
 * dialled out — and the engine on :4096, the adapter on :1235 and SearXNG all sit behind that spelling.
 *
 * A spelling-based test can only ever cover the spellings someone thought of. Sixteen bytes of address
 * have one meaning however they are written, so they are parsed once and every rule reads the bytes.
 */
export function ipv6Groups(host: string): number[] | null {
  let s = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "") // drop any zone id
  if (!s.includes(":")) return null
  // A trailing dotted quad is legal in every IPv6 spelling (::ffff:1.2.3.4) — fold it into two groups.
  const dotted = s.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/)
  if (dotted) {
    const n = ipv4ToInt(dotted[1])
    if (n === null) return null
    s = s.slice(0, s.length - dotted[1].length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16)
  }
  const halves = s.split("::")
  if (halves.length > 2) return null
  const parse = (part: string): number[] | null => {
    if (!part) return []
    const out: number[] = []
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const head = parse(halves[0] ?? "")
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : []
  if (head === null || tail === null) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const gap = 8 - head.length - tail.length
  if (gap < 1) return null
  return [...head, ...new Array(gap).fill(0), ...tail]
}

/** The IPv4 address an IPv6 literal embeds, in every shape that carries one, or null. */
function embeddedV4(groups: readonly number[]): string | null {
  const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
  const zeroTo = (n: number) => groups.slice(0, n).every((g) => g === 0)
  // ::ffff:a.b.c.d — IPv4-mapped, the form the URL parser produces.
  if (zeroTo(5) && groups[5] === 0xffff) return v4
  // ::a.b.c.d — IPv4-compatible (deprecated, still resolvable). ::0 and ::1 are their own specials.
  if (zeroTo(6) && !(groups[6] === 0 && groups[7] <= 1)) return v4
  // 64:ff9b::a.b.c.d and 64:ff9b:1::/48 — the well-known NAT64 prefixes carry a real v4 destination.
  if (groups[0] === 0x64 && groups[1] === 0xff9b) return v4
  return null
}

/** Classify a literal IP (v4 or v6) as private/loopback/link-local/metadata → blocked. */
export function isBlockedIp(ip: string): { blocked: boolean; code: string } {
  const host = ip.replace(/^\[|\]$/g, "").toLowerCase()
  if (METADATA_IPS.has(host)) return { blocked: true, code: "cloud_metadata" }

  const groups = ipv6Groups(host)
  const v4 = ipv4ToInt(host) !== null ? host : groups ? embeddedV4(groups) : null

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

  // IPv6 specials, read off the parsed bytes so every spelling of one address gets one answer.
  if (groups) {
    if (groups.every((g, i) => (i < 7 ? g === 0 : g === 1))) return { blocked: true, code: "loopback" }
    if (groups.every((g) => g === 0)) return { blocked: true, code: "this_host" }
    if ((groups[0] & 0xffc0) === 0xfe80) return { blocked: true, code: "link_local" } // fe80::/10
    if ((groups[0] & 0xfe00) === 0xfc00) return { blocked: true, code: "ula" }        // fc00::/7
    if ((groups[0] & 0xffc0) === 0xfec0) return { blocked: true, code: "site_local" } // fec0::/10, deprecated but routable on real internal networks
  }
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
export type HostLookup = (host: string) => Promise<string[]>

const realLookup: HostLookup = async (host) => (await dns.lookup(host, { all: true })).map((r) => r.address)

/**
 * How a name becomes addresses. Injectable, and the default is the real resolver.
 *
 * The rule this function exists for — a name that resolves to an internal address is refused, whatever
 * it is called — CANNOT be exercised against the real network: no public name resolves to 127.0.0.1, so
 * the anti-rebinding floor had no test at all. What the network did contribute was a verdict that
 * depended on whether DNS answered — MEASURED elsewhere: two checks failed on resolution timeouts while
 * this code was fine. A check whose answer comes from the network is not a check of this code.
 */
export async function checkUrl(rawUrl: string, lookup: HostLookup = realLookup): Promise<UrlVerdict> {
  const structural = checkUrlSync(rawUrl)
  if (structural.blocked) return structural
  let host: string
  try { host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "") } catch { return structural }
  // If host is already a literal IP, checkUrlSync covered it.
  if (ipv4ToInt(host) !== null || host.includes(":")) return structural
  let addrs: string[] = []
  try {
    addrs = await lookup(host)
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
