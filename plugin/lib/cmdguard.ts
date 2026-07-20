// Hardline shell-command blocklist (pure, unit-testable).
// HARDLINE = catastrophic / irreversible / remote-code-execution. These are ALWAYS denied,
// no prompt. The broader "ask" tier (47-ish risky patterns, ~/.ssh, chmod 777, sudo, etc.)
// is the full approval engine — NOT here.
//
// We normalize a COPY of the command for matching only; the ORIGINAL is what would execute.
// Aggressive match-normalization is therefore safe: worst case is a false-positive block on an
// exotic-but-legit command (safe direction), never a missed destructive one being run.

export interface CmdVerdict {
  blocked: boolean
  reason: string
  code: string
}

const ALLOW: CmdVerdict = { blocked: false, reason: "", code: "allow" }

// Strip ANSI escapes, NFKC-fold unicode lookalikes, drop obfuscation backslashes (r\m → rm),
// collapse whitespace. Used ONLY to test patterns.
export function normalizeForMatch(cmd: string): string {
  if (typeof cmd !== "string") return ""
  let s = cmd
  try { s = s.normalize("NFKC") } catch {}
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")  // ANSI CSI
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ") // other control chars → space
  s = s.replace(/\\(?=[A-Za-z])/g, "")          // de-obfuscate r\m, r\f → rm, rf
  s = s.replace(/[^\S\n]+/g, " ")               // collapse horizontal whitespace, KEEP newlines
  s = s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n")  // newlines stay as segment separators
  return s
}

// Quote-aware: split a command line into independently-executed segments on shell separators that are
// OUTSIDE quotes (so `echo "; rm -rf /"` stays one segment and isn't mis-parsed).
function segments(cmd: string): string[] {
  const out: string[] = []; let cur = "", q = ""
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (q) { cur += c; if (c === q) q = ""; continue }
    if (c === "'" || c === '"') { q = c; cur += c; continue }
    if (c === ";" || c === "|" || c === "&" || c === "\n") {
      if (cur.trim()) out.push(cur.trim()); cur = ""
      while (i + 1 < cmd.length && /[;|&\n]/.test(cmd[i + 1])) i++
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

// Quote-aware tokenizer: splits on unquoted whitespace, strips quotes, and JOINS adjacent quoted/
// unquoted runs into one token — so `r"m"` / `"rm"` / `'rm'` / `r''m` all become the single token `rm`
// (de-obfuscation), while a standalone quoted string like `"fix rm -rf / bug"` stays ONE argument token.
function tokenize(seg: string): string[] {
  const toks: string[] = []; let cur = "", started = false, i = 0
  while (i < seg.length) {
    const c = seg[i]
    if (c === " " || c === "\t") { if (started) { toks.push(cur); cur = ""; started = false } ; i++; continue }
    started = true
    if (c === "'") { i++; while (i < seg.length && seg[i] !== "'") cur += seg[i++]; i++ }
    else if (c === '"') { i++; while (i < seg.length && seg[i] !== '"') cur += seg[i++]; i++ }
    else { cur += c; i++ }
  }
  if (started) toks.push(cur)
  return toks
}

// Blank the CONTENTS of single-quoted spans (shell single quotes are 100% literal — no expansion, no
// substitution), so a dangerous-LOOKING string passed as data (`grep 'curl | bash' .`) is not matched
// as live execution. Double-quoted spans are left intact because `$( )` inside them DOES execute.
function blankSingleQuotes(s: string): string { return s.replace(/'[^']*'/g, "''") }

const SYS_ROOTS = "bin|etc|usr|var|lib|lib64|boot|sys|proc|dev|sbin|root|opt|srv|Users|home|System|Library|Applications|cores|private|Network|Volumes"
const RM_WRAPPERS = new Set(["sudo", "doas", "env", "command", "nice", "time", "exec", "setsid", "stdbuf", "nohup", "ionice"])

function isCatastrophicRmTarget(x: string): boolean {
  if (x === "/" || x === "/*" || x === "/.") return true
  if (x === "." || x === ".." || x === "*" || x === "./*" || x === "../*") return true
  if (/^(~|\$HOME|\$\{HOME\})\/?\*?$/.test(x)) return true
  if (new RegExp(`^/(${SYS_ROOTS})/?(\\*)?$`).test(x)) return true
  if (/^\/(Users|home)\/[^/]+\/?\*?$/.test(x)) return true
  return false
}

// True iff this segment is a destructive recursive `rm` of a catastrophic path — determined by the
// COMMAND word (after skipping sudo/env wrappers and VAR=val prefixes), not by scanning string args.
function isDestructiveRm(seg: string): boolean {
  const toks = tokenize(seg).filter((t) => t.length)
  let k = 0
  while (k < toks.length && (RM_WRAPPERS.has(toks[k].replace(/.*\//, "")) || /^[A-Za-z_]\w*=/.test(toks[k]))) k++
  if (k >= toks.length || toks[k].replace(/.*\//, "") !== "rm") return false
  const rest = toks.slice(k + 1)
  if (rest.includes("--no-preserve-root")) return true
  const flagStr = rest.filter((t) => /^-[^-]/.test(t)).join("")
  const hasR = /r/i.test(flagStr) || rest.includes("--recursive")
  const hasF = /f/i.test(flagStr) || rest.includes("--force")
  if (!(hasR && hasF)) return false
  return rest.filter((t) => !t.startsWith("-")).some(isCatastrophicRmTarget)
}

/** Evaluate a shell command against the hardline blocklist. */
export function checkCommand(rawCmd: string): CmdVerdict {
  const norm = normalizeForMatch(rawCmd)
  if (!norm) return ALLOW
  // For the structural pattern rules, blank single-quoted literals so a dangerous-looking string passed
  // as DATA isn't treated as live execution. (rm detection below is quote-aware via the tokenizer.)
  const m = blankSingleQuotes(norm)

  // 1. Fork bomb — :(){ :|:& };:  and generalized  name(){ … | … & };  name
  if (/(\w*)\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;\s*\1/.test(m) ||
      /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;\s*:/.test(m))
    return { blocked: true, code: "fork_bomb", reason: "fork bomb (self-replicating process) — would exhaust the system." }

  // 2. Pipe a network download straight into a shell — curl|bash / wget|sh / … | sudo bash
  if (/\b(curl|wget|fetch|https?:\/\/\S+)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da|k|c)?sh\b/.test(m) ||
      /\b(curl|wget|fetch)\b[^\n]*\|\s*(sudo\s+)?(python3?|perl|ruby|node)\b/.test(m))
    return { blocked: true, code: "remote_pipe_shell", reason: "piping a remote download directly into a shell/interpreter (arbitrary remote code execution). Download to a file, inspect it, then run it." }

  // 2b. Decode-then-execute — `… base64 -d | bash`, `xxd -r | sh`, `openssl enc -d | python` (obfuscated RCE).
  const DECODER = /\b(base64\s+(-d|--decode|-D)|base32\s+-d|xxd\s+(-p\s+)?-r|openssl\s+enc\b[^|]*-d|uudecode|gunzip|gzip\s+-d|zcat|bunzip2|xz\s+(-d|--decode))\b/
  const PIPE_INTERP = /\|\s*(sudo\s+)?((ba|z|da|k|c)?sh|python3?|perl|ruby|node|osascript)\b/
  if (DECODER.test(m) && PIPE_INTERP.test(m))
    return { blocked: true, code: "decode_pipe_shell", reason: "decoding opaque data and piping it into a shell/interpreter — obfuscated remote/arbitrary code execution. Decode to a file and inspect it first." }

  // 2c. Command-substitution execution of remote/decoded content — `bash -c "$(curl …)"`, `eval "$(… base64 -d)"`.
  if (/\b(eval|(ba|z|da|k|c)?sh\s+-c|python3?\s+-c|source|\.)\b[^\n]*\$\([^)]*\b(curl|wget|fetch)\b/.test(m) ||
      /\b(eval|source)\b[^\n]*\$\([^)]*(base64\s+(-d|--decode|-D)|xxd\s+-r)/.test(m))
    return { blocked: true, code: "cmdsubst_remote_exec", reason: "executing the output of a remote download or decoder via command substitution (RCE). Fetch/decode to a file and inspect it before running." }

  // 2d. Process-substitution of a remote download — `bash <(curl …)`, `source <(wget …)`, `. <(…)`,
  //     `sh <(curl …)`. Feeding remote content as a file via <( ) is essentially always RCE-intent.
  if (/<\(\s*[^)]*\b(curl|wget|fetch)\b/.test(m))
    return { blocked: true, code: "procsubst_remote_exec", reason: "process substitution <(…) of a remote download (RCE). Fetch to a file and inspect it first." }

  // 2e. Writing the SUPERVISION LAYER'S OWN STATE from a shell.
  //
  // `set_permission_mode` and `disable_plugin` refuse to disarm the guards from inside a run, and the
  // write-tool path guard refuses the files — but `bash` reaches neither, and a run that can redirect a
  // shell into those files does not need either tool: one `echo '{"mode":"bypass"}' >` turns every guard
  // off, one `{"disabled":["security"]}` stops the layer loading at all. Guarding the tools while leaving
  // the shell is guarding a door in a wall that is not there.
  //
  // Matched by TARGET rather than by verb, because the verb is the easy part to vary: >, >>, tee, cp, mv,
  // dd, install, python -c, sed -i all write, and enumerating them is a losing game. Reads are untouched —
  // inspecting the state is legitimate and is how a run explains what it is allowed to do.
  // The TARGET is matched against the un-blanked command: `blankSingleQuotes` erases quoted literals so
  // that data cannot look like execution, but here the quoted literal IS the target — a path inside
  // quotes is the same path, and testing the blanked text let `python3 -c "open('…json','w')"` through.
  // The write must REFER to the store, not merely co-occur with it. The first version asked "does the
  // command mention the file AND contain any write verb anywhere", which blocked ordinary reads —
  // `grep mode <store> | tee /tmp/out`, `cat <store> && cp a b` — while its own comment promised reads
  // were untouched. Each pattern below binds the verb to the target.
  const STORE = String.raw`[^\s;|&]*fabula-(?:permissions|state)\.json`
  const WRITES_THE_STORE = new RegExp(
    [
      String.raw`>{1,2}\s*${STORE}`,                                  // … > store   /   … >> store
      String.raw`\b(?:tee)\b[^|;&]*\s${STORE}`,                       // tee store
      String.raw`\b(?:cp|mv|dd|install)\b[^|;&]*\s${STORE}\s*$`,      // cp/mv/… <src> store
      // `ln` is the one verb where the store can be EITHER argument: in `ln -s SOURCE DEST` it is the
      // SOURCE, and the link then makes an innocuous-looking path write it. Binding every verb to the
      // destination lost this — the guard got measurably weaker inside the round meant to strengthen it,
      // and shipped under a count that was one too high. Match the store anywhere in an `ln`.
      String.raw`\bln\b[^|;&]*${STORE}`,
      String.raw`\bdd\b[^|;&]*of=${STORE}`,                           // dd of=store
      String.raw`\bsed\b[^|;&]*-i[^|;&]*${STORE}`,                     // sed -i … store
      String.raw`\btruncate\b[^|;&]*${STORE}`,
      String.raw`\b(?:python3?|perl|ruby|node|deno|bun)\b[^|;&]*\s-(?:c|e|p)\b[^|;&]*${STORE}`,
    ].join("|"),
  )
  if (WRITES_THE_STORE.test(norm))
    return {
      blocked: true,
      code: "supervision_state",
      reason:
        "this command writes the file that records whether FABULA's guards are on and which plugins load. " +
        "Disarming the supervision layer from inside a run is not something a run gets to do — the owner " +
        "changes it in the app (Settings ▸ Permissions / Plugins) or with manage-cli. " +
        "NOTE this is a NAME match: a path reached through a variable, a glob or a helper script is not " +
        "caught here, and the file-level guard is the backstop for those.",
    }

  // 3. mkfs — (re)format a filesystem
  if (/\bmkfs(\.\w+)?\b/.test(m))
    return { blocked: true, code: "mkfs", reason: "mkfs formats a filesystem and destroys all data on the target device." }

  // 4. dd writing to a raw disk device
  if (/\bdd\b[^\n]*\bof=\/dev\/(disk|rdisk|sd|nvme|hd|vd)\w*/.test(m))
    return { blocked: true, code: "dd_to_device", reason: "dd writing to a raw disk device overwrites the disk irrecoverably." }

  // 5. Redirect/overwrite a raw block device
  if (/>\s*\/dev\/(disk|rdisk|sd|nvme|hd|vd)\w*/.test(m))
    return { blocked: true, code: "overwrite_device", reason: "writing directly to a raw block device corrupts the disk." }

  // 6. Destructive recursive rm against root/home/wildcards — quote-aware command detection per segment.
  for (const seg of segments(norm)) {
    if (isDestructiveRm(seg))
      return { blocked: true, code: "rm_rf_root", reason: "recursive force-delete of a root/home/wildcard path — would wipe the system or your home directory." }
  }

  return ALLOW
}

/** Build the model-facing message for a blocked command. */
export function blockedMessage(v: CmdVerdict, command: string): string {
  return (
    `[BLOCKED by FABULA security — ${v.code}] This command was refused and NOT executed: ${v.reason}\n` +
    `Command: ${command.slice(0, 300)}\n` +
    `Do not retry it. If you have a legitimate need, accomplish it a safer, narrower way ` +
    `(specific paths instead of / or ~, download-then-inspect instead of pipe-to-shell), or ask the user.`
  )
}
