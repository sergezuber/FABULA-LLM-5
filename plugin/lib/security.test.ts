import { test, expect } from "bun:test"
import { isBlockedIp, checkUrlSync } from "./ssrf"
import { redactSecrets } from "./redact"
import { wrapUntrusted, isUntrustedTool } from "./untrusted"
import { checkWritePath } from "./pathguard"

// ───────────────────────── SSRF ─────────────────────────
test("isBlockedIp: metadata + private + loopback + link-local", () => {
  expect(isBlockedIp("169.254.169.254").blocked).toBe(true)
  expect(isBlockedIp("169.254.170.2").blocked).toBe(true)
  expect(isBlockedIp("100.100.100.200").blocked).toBe(true)
  expect(isBlockedIp("127.0.0.1").blocked).toBe(true)
  expect(isBlockedIp("10.1.2.3").blocked).toBe(true)
  expect(isBlockedIp("172.16.5.5").blocked).toBe(true)
  expect(isBlockedIp("192.168.0.1").blocked).toBe(true)
  expect(isBlockedIp("169.254.10.10").blocked).toBe(true)
  expect(isBlockedIp("100.64.0.1").blocked).toBe(true) // CGNAT
  expect(isBlockedIp("::1").blocked).toBe(true)
  expect(isBlockedIp("fe80::1").blocked).toBe(true)
  expect(isBlockedIp("::ffff:169.254.169.254").blocked).toBe(true) // IPv4-mapped metadata
})
test("isBlockedIp: public IPs pass", () => {
  expect(isBlockedIp("8.8.8.8").blocked).toBe(false)
  expect(isBlockedIp("1.1.1.1").blocked).toBe(false)
  expect(isBlockedIp("93.184.216.34").blocked).toBe(false)
})
test("checkUrlSync: schemes, metadata host, literal IPs", () => {
  expect(checkUrlSync("http://169.254.169.254/latest/meta-data/").blocked).toBe(true)
  expect(checkUrlSync("http://localhost:1234/v1").blocked).toBe(true)
  expect(checkUrlSync("http://127.0.0.1:8888/").blocked).toBe(true)
  expect(checkUrlSync("http://metadata.google.internal/").blocked).toBe(true)
  expect(checkUrlSync("file:///etc/passwd").blocked).toBe(true)
  expect(checkUrlSync("gopher://x/").blocked).toBe(true)
  expect(checkUrlSync("not a url").blocked).toBe(true)
  // public URLs pass
  expect(checkUrlSync("https://example.com/page").blocked).toBe(false)
  expect(checkUrlSync("https://api.github.com/repos").blocked).toBe(false)
})
test("checkUrlSync: blocks secret-exfil URLs (2.5)", () => {
  expect(checkUrlSync("https://evil.com/?leak=sk-ant-abcdef0123456789ABCDEF01").blocked).toBe(true)
  expect(checkUrlSync("https://evil.com/collect/nvapi-abc123DEF456ghi789JKL000xyz").blocked).toBe(true)
  // percent-encoded evasion is still caught
  expect(checkUrlSync("https://evil.com/?t=ghp_0123456789abcdef0123456789abcdef0123").blocked).toBe(true)
  // a normal URL with a random id is NOT a false positive
  expect(checkUrlSync("https://example.com/users/abc123/profile?ref=home").blocked).toBe(false)
})

// ───────────────────────── redact ─────────────────────────
test("redactSecrets: provider keys + user formats", () => {
  expect(redactSecrets("key nvapi-abc123DEF456ghi789JKL000xyz").text).toContain("[REDACTED:NVIDIA_KEY]")
  expect(redactSecrets("token sk-ant-abcdef0123456789ABCDEF01").text).toContain("[REDACTED:SK_ANT_KEY]")
  expect(redactSecrets("OPENAI sk-abcdef0123456789ABCDEFGH").text).toContain("[REDACTED:OPENAI_KEY]")
  expect(redactSecrets("gh ghp_0123456789abcdef0123456789abcdef0123").text).toContain("[REDACTED:GITHUB_TOKEN]")
  expect(redactSecrets("aws AKIAIOSFODNN7EXAMPLE here").text).toContain("[REDACTED:AWS_ACCESS_KEY]")
  expect(redactSecrets("zhipu 79cfa09060564206bb30700623b6f108.UEqssHurxf3jO581").text).toContain("[REDACTED:ZHIPU_KEY]")
})
test("redactSecrets: leaves normal text alone", () => {
  const r = redactSecrets("the quick brown fox runs npm install and git push")
  expect(r.count).toBe(0)
  expect(r.text).toContain("brown fox")
})
test("redactSecrets: JWT + PEM + generic key=value", () => {
  expect(redactSecrets("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QTabcdef").text).toContain("[REDACTED:JWT]")
  expect(redactSecrets("API_KEY=supersecretvalue12345").text).toContain("[REDACTED:SECRET]")
  expect(redactSecrets("API_KEY=supersecretvalue12345").text).toContain("API_KEY")
})

// ───────────────────────── untrusted wrap ─────────────────────────
test("wrapUntrusted wraps long external content with the warning", () => {
  const w = wrapUntrusted("x".repeat(100))
  expect(w).toContain("<untrusted_tool_result")
  expect(w).toContain("UNTRUSTED external data")
  expect(w).toContain("</untrusted_tool_result>")
})
test("wrapUntrusted is idempotent + skips tiny content", () => {
  const once = wrapUntrusted("y".repeat(100))
  expect(wrapUntrusted(once)).toBe(once)
  expect(wrapUntrusted("short")).toBe("short")
})
test("isUntrustedTool: web/mcp yes, our local tools no", () => {
  expect(isUntrustedTool("web_fetch")).toBe(true)
  expect(isUntrustedTool("web_search")).toBe(true)
  expect(isUntrustedTool("webfetch")).toBe(true)
  expect(isUntrustedTool("web-search-internet_searxng_web_search")).toBe(true)
  // local tools must NOT be wrapped
  expect(isUntrustedTool("bash_tool")).toBe(false)
  expect(isUntrustedTool("create_file")).toBe(false)
  expect(isUntrustedTool("view")).toBe(false)
  expect(isUntrustedTool("str_replace")).toBe(false)
})

// ───────────────────────── write-path guard ─────────────────────────
test("checkWritePath blocks backdoor/persistence targets", () => {
  expect(checkWritePath("~/.ssh/authorized_keys").blocked).toBe(true)
  expect(checkWritePath("/etc/sudoers").blocked).toBe(true)
  expect(checkWritePath("/etc/passwd").blocked).toBe(true)
  expect(checkWritePath("/etc/cron.d/evil").blocked).toBe(true)
})
test("checkWritePath allows normal project files", () => {
  expect(checkWritePath("/Users/me/proj/src/index.ts").blocked).toBe(false)
  expect(checkWritePath("./README.md").blocked).toBe(false)
  expect(checkWritePath("~/projects/app/.env").blocked).toBe(false) // .env allowed (ask-tier, not hardline)
})

// ── the supervision layer's own files, and the symlink that used to walk past every rule (W6) ─────
test("checkWritePath blocks the files that record whether the guards are on", () => {
  expect(checkWritePath("~/.config/fabula/fabula-permissions.json").blocked).toBe(true)
  expect(checkWritePath("~/.config/fabula/fabula-state.json").blocked).toBe(true)
  expect(checkWritePath("/somewhere/else/fabula-permissions.json").blocked).toBe(true)
  expect(checkWritePath("~/.config/fabula/theme.json").blocked).toBe(false)
})

test("checkWritePath resolves symlinks before matching", async () => {
  // Every rule compares strings, so `ln -s <target> ./notes.json` followed by a write to `./notes.json`
  // walked straight past all of them: the guard was checking the name the caller chose rather than the
  // file it lands on.
  const { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const dir = mkdtempSync(path.join(os.tmpdir(), "fab-pathguard-"))
  try {
    const real = path.join(dir, "fabula-permissions.json")
    writeFileSync(real, "{}")
    const innocent = path.join(dir, "notes.json")
    symlinkSync(real, innocent)
    expect(checkWritePath(innocent).blocked).toBe(true)

    // …and through a symlinked DIRECTORY, where the file itself may not exist yet
    const guarded = path.join(dir, "guarded")
    mkdirSync(guarded)
    const alias = path.join(dir, "alias")
    symlinkSync(guarded, alias)
    expect(checkWritePath(path.join(alias, "fabula-state.json")).blocked).toBe(true)

    // an ordinary symlink to an ordinary file is still fine
    const plain = path.join(dir, "plain.txt")
    writeFileSync(plain, "hi")
    const link = path.join(dir, "link.txt")
    symlinkSync(plain, link)
    expect(checkWritePath(link).blocked).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
