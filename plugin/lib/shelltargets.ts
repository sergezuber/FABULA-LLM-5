// What a shell command WRITES TO and DIALS OUT TO — so the same rules that guard the tools can guard
// the shell.
//
// MEASURED 2026-08-01, and it was found by testing rather than by reading. Driven through the LIVE app,
// the write-path guard correctly refused `create_file` on `~/Library/LaunchAgents/com.example.hourly.plist`
// ("write:launchagent — writing LaunchAgents installs persistence") and the SSRF guard correctly refused
// `web_fetch` on `http://[::ffff:127.0.0.1]:4096/…`. The model then did BOTH ANYWAY, through `bash_tool`:
// it wrote the plist with a shell redirect and fetched the address with curl, and reported both as
// completed. Neither was an attack — it was an agent routing around a block to finish its task, which is
// precisely the behaviour a guard has to survive.
//
// The rules were never the problem: `checkWritePath` and `checkUrlSync` already answer correctly for both
// targets. The shell simply never asked them. This module extracts the targets so it can, which keeps ONE
// definition of what is dangerous and adds a second door onto it — rather than a second, drifting copy of
// the rules written in shell syntax.
//
// DELIBERATELY CONSERVATIVE. Everything here is a best-effort read of an arbitrary shell string: a
// command can compute a path (`$(cat which)`), glob it, split it across variables, or write through a
// helper script, and no extractor sees any of that. The point is not to be a sandbox — `lib/sandbox.ts`
// is the kernel-enforced layer for that. The point is that the OBVIOUS spellings, which are what an agent
// actually reaches for when a tool call is refused, no longer walk straight past a guard that already
// knows the answer.

/** Strip one layer of shell quoting from a token. */
function unquote(t: string): string {
  const s = t.trim()
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1)
  }
  return s
}

/** Split a command into rough tokens, honouring quotes so a quoted path stays one token. */
function tokenize(cmd: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: '"' | "'" | null = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'"
      continue
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** Commands whose LAST path-shaped argument is the destination. */
const LAST_ARG_WRITERS = new Set(["cp", "mv", "install", "ln", "rsync"])
/** Commands whose EVERY path-shaped argument is written. */
const ALL_ARG_WRITERS = new Set(["touch", "mkdir", "chmod", "chown", "truncate", "unlink", "rm", "rmdir"])

/** Every path this command plausibly writes to. Empty when nothing is recognisable. */
export function shellWriteTargets(command: unknown): string[] {
  const cmd = String(command ?? "")
  if (!cmd.trim() || cmd.length > 100_000) return []
  const out: string[] = []
  const push = (p: string) => {
    const v = unquote(p)
    // A path-shaped token only. A flag, a URL or a bare word is not a write target.
    if (v && !v.startsWith("-") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) out.push(v)
  }

  // Redirections: `> path`, `>> path`, `2> path`, `&> path`. The redirect operator can abut its target.
  for (const m of cmd.matchAll(/(?:^|[\s;|&])(?:\d*|&)>>?\s*("[^"]+"|'[^']+'|[^\s;|&()<>]+)/g)) push(m[1]!)
  // `tee [-a] path…` and `dd of=path`
  for (const m of cmd.matchAll(/\btee\s+((?:-\S+\s+)*)("[^"]+"|'[^']+'|[^\s;|&()<>]+)/g)) push(m[2]!)
  for (const m of cmd.matchAll(/\bdd\b[^;|&]*?\bof=("[^"]+"|'[^']+'|[^\s;|&()<>]+)/g)) push(m[1]!)
  // `sed -i … path` / `perl -i -pe … path`: the in-place flag makes every later path a write target.
  for (const seg of cmd.split(/[;|&\n]+/)) {
    const toks = tokenize(seg)
    if (!toks.length) continue
    // Skip a leading `sudo`/`env`/`command` wrapper so the real verb is seen.
    let i = 0
    while (i < toks.length && /^(sudo|env|command|nohup|nice|time)$/.test(toks[i]!)) i++
    const verb = (toks[i] ?? "").split("/").pop() ?? ""
    const rest = toks.slice(i + 1)
    if (/^(sed|perl|ruby|gsed)$/.test(verb) && rest.some((t) => /^-.*i/.test(t))) {
      for (const t of rest) if (!t.startsWith("-")) push(t)
      continue
    }
    if (LAST_ARG_WRITERS.has(verb)) {
      const paths = rest.filter((t) => !t.startsWith("-"))
      if (paths.length) push(paths[paths.length - 1]!)
      continue
    }
    if (ALL_ARG_WRITERS.has(verb)) {
      for (const t of rest) if (!t.startsWith("-")) push(t)
      continue
    }
  }
  return [...new Set(out)]
}

/** Every URL this command plausibly dials. Only the fetchers — a URL in an echo is not a request. */
export function shellUrls(command: unknown): string[] {
  const cmd = String(command ?? "")
  if (!cmd.trim() || cmd.length > 100_000) return []
  const out: string[] = []
  for (const seg of cmd.split(/[;|&\n]+/)) {
    // A FETCHER as its own token — not the scheme. Gating on `\bhttp\b` matched the URL itself, so
    // `echo "http://169.254.169.254 is the metadata address"` was blocked as if it were a request.
    // Printing an address is not dialling it, and a guard that cannot tell the difference gets removed.
    if (!/(?:^|[\s;|&(=])(?:sudo\s+|env\s+)*(curl|wget|xh|httpie|http|aria2c|lwp-request)(?=\s|$)/.test(seg)) continue
    for (const m of seg.matchAll(/(?:^|[\s"'=(])((?:https?):\/\/[^\s"'`;|&()<>]+)/gi)) out.push(m[1]!)
    // A bracketed IPv6 host is the spelling the guard was blind to for a year; keep it whole.
    for (const m of seg.matchAll(/(?:^|[\s"'=(])((?:https?):\/\/\[[^\]]+\][^\s"'`;|&()<>]*)/gi)) out.push(m[1]!)
  }
  return [...new Set(out)]
}
