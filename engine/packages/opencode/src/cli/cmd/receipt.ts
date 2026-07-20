import { createHash } from "node:crypto"
// FABULA — `fabula receipt`: the CLI surface of the Proof-of-Done receipt (Greenpaper contract).
// Receipts are minted by the receipt plugin into <project>/.fabula/receipts/; this command lets anyone
// show, list and — the point of the protocol — RE-VERIFY them: `fabula receipt verify` replays the
// ARTIFACT deterministically (throwaway git worktree at the recorded base commit, the shipped patch
// applied, the same verification command run) and reports VERIFIED or NOT DONE. No trust required.
// Deliberately DB-free and bootstrap-free: it must work in any checkout, wedged installs included.
import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { spawnSync } from "child_process"
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "fs"
import path from "path"
import os from "os"

interface ReceiptFile {
  version?: string
  mintedAt?: number
  model?: { id?: string; host?: string }
  task?: string
  base?: string
  gates?: { id: string; forced: string }[]
  artifact?: { files?: number; bytes?: number; patch?: string }
  verification?: { cmd?: string; passed?: boolean; exitCode?: number | null; cwd?: string }
  replay?: string
}

function receiptsDir(dir: string) {
  return path.join(dir, ".fabula", "receipts")
}

function readReceipt(file: string): ReceiptFile | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function resolveReceiptPath(dir: string, file?: string): string | null {
  if (file) {
    const p = path.isAbsolute(file) ? file : path.join(dir, file)
    return existsSync(p) ? p : null
  }
  const latest = path.join(receiptsDir(dir), "latest.json")
  return existsSync(latest) ? latest : null
}

function verdictLine(r: ReceiptFile): string {
  const v = r.verification?.passed ? "VERIFIED ✓" : "NOT DONE"
  const model = r.model?.id ? `${r.model.id} (${r.model.host || "host unknown"})` : "model unknown"
  const when = r.mintedAt ? new Date(r.mintedAt).toISOString() : "time unknown"
  return `${v} · ${model} · ${r.artifact?.files ?? 0} file(s) · minted ${when}`
}

// Single-quote shell escaping: JSON.stringify yields double quotes, inside which bash still expands $(...)/$VAR/backticks.
function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

// Cap on the replayed verification command; FABULA_REPLAY_TIMEOUT (seconds) raises it for long suites.
function replayTimeoutMs(): number {
  const s = Number(process.env["FABULA_REPLAY_TIMEOUT"])
  return Number.isFinite(s) && s > 0 ? s * 1000 : 300_000
}

function sh(cmdline: string, cwd: string, timeoutMs = replayTimeoutMs()): { code: number; out: string; timedOut: boolean; killed: boolean } {
  const r = spawnSync("bash", ["-lc", cmdline], { cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  const errCode = (r.error as NodeJS.ErrnoException | undefined)?.code
  // ONLY ETIMEDOUT is a timeout. A signal kill can also be maxBuffer overflow (ENOBUFS) or an OOM
  // SIGKILL — reporting those as "timed out, raise the cap" sends the user down a dead-end retry loop.
  const timedOut = errCode === "ETIMEDOUT"
  const killed = !timedOut && (r.status === null && r.signal != null)
  return { code: r.status ?? 1, out: ((r.stdout || "") + (r.stderr || "")).trim(), timedOut, killed }
}

function timeoutVerdict(vcmd: string, timeoutMs: number): string {
  return `\nNOT DONE — \`${vcmd}\` timed out after ${Math.round(timeoutMs / 1000)}s (set FABULA_REPLAY_TIMEOUT, in seconds, to raise the cap).`
}

/** Deterministic replay: worktree at the recorded base → apply the shipped patch → run the same check. */
function verifyReceipt(dir: string, file: string): number {
  const r = readReceipt(file)
  if (!r) {
    console.error(`fabula receipt: cannot parse ${file}`)
    return 1
  }
  const vcmd = r.verification?.cmd
  const patch = r.artifact?.patch
  // Exact-match the plugin's placeholders only — legit commands may start with '(' (subshells).
  if (!vcmd || vcmd === "(run verify_done)" || vcmd === "(verify command)") {
    console.error("fabula receipt: this receipt has no captured verification command — re-mint it from a green verify_done.")
    return 1
  }
  console.log(`Receipt:  ${file}`)
  console.log(`Claim:    ${verdictLine(r)}`)
  // Context provenance (Phase 3): which exact prompt-prefix produced this work.
  const prov = (r as { provenance?: { bundlePrefixHash?: string; routerProfile?: string; midTurnBreaks?: number } }).provenance
  // These describe the context of the ORIGINAL run and cannot be reconstructed from a receipt on another
  // machine — so they are ASSERTED, not checked, and this line now says so. Printing them beside a
  // genuinely re-run verification, in identical formatting, let a reader take the whole block as
  // verified: the expensive claim was checked and the cheap ones were echoed, with nothing telling them
  // apart. `FABULA_RECHECK=0` restores the pre-W8 line exactly.
  const w8 = String(process.env.FABULA_RECHECK ?? "1").trim() !== "0"
  if (prov?.bundlePrefixHash)
    console.log(
      `Context:  prefix ${prov.bundlePrefixHash.slice(0, 16)}` +
        (prov.routerProfile ? ` · profile ${prov.routerProfile}` : "") +
        (typeof prov.midTurnBreaks === "number"
          ? ` · byte-stability ${prov.midTurnBreaks === 0 ? "held" : `BROKEN ×${prov.midTurnBreaks}`}`
          : "") +
        (w8 ? `  [asserted by the receipt — NOT checkable here: describes the original run's context]` : ""),
    )
  // SELF-CONSISTENCY, here too. This costs no network, no config and no model: the receipt prints a
  // descriptor and the hash that is supposed to cover it, so a disagreement is the document contradicting
  // ITSELF and is detectable on any machine, forever. It was wired into `verify_receipt` and not here —
  // and this surface printed a plain `VERIFIED ✓` for a receipt that contradicts itself, which is the
  // wave's own failure mode surviving on the wave's own command.
  let identityContradicted = false
  if (w8) {
    const p2 = (r as any).provenance
    if (p2?.modelDescriptorHash && p2?.modelDescriptor) {
      try {
        // BYTE-IDENTICAL to `plugin/lib/modeldigest.ts descriptorHash`. The engine cannot import from
        // plugin/, so this is a duplicate by necessity — and the first duplicate silently diverged twice
        // over: it dropped null-valued entries the original keeps, and used a bare `.sort()` on [k,v]
        // pairs where the original sorts by KEY. The two surfaces then returned OPPOSITE verdicts on the
        // same document: an honest receipt was accused of contradicting itself while a forged one passed.
        // Receipt JSON is untrusted input, so the descriptor's keys are the forger's to choose. Any edit
        // here must be made in both places and pinned by the cross-surface fixture test.
        const canon = JSON.stringify(
          Object.fromEntries(Object.entries(p2.modelDescriptor).sort(([a], [b]) => (a < b ? -1 : 1))),
        )
        const selfHash = createHash("sha256").update(canon, "utf8").digest("hex")
        if (selfHash !== String(p2.modelDescriptorHash)) {
          console.log(
            `Identity: ❌ MISMATCH — this receipt's modelDescriptorHash does not match the descriptor printed beside it; ` +
              `the document contradicts itself (claims ${String(p2.modelDescriptorHash).slice(0, 16)}, its own descriptor hashes to ${selfHash.slice(0, 16)})`,
          )
          // A line nobody's script reads is not a verdict. `verify_receipt` already refuses to head a
          // contradicted receipt with a bare VERIFIED; this surface printed the objection and still exited
          // 0, so `fabula receipt verify && deploy` deployed it. The comment further down this file exists
          // for exactly that reason.
          identityContradicted = true
        }
      } catch { /* an unhashable descriptor is reported by verify_receipt, not guessed at here */ }
    } else if (p2?.modelDescriptorHash) {
      // A hash with no descriptor beside it cannot be checked by anyone, ever — that is a property of the
      // receipt, not of this machine, and it is worth saying out loud rather than passing over.
      console.log(
        `Identity: • modelDescriptorHash is asserted with no descriptor beside it — unverifiable here and everywhere, by construction`,
      )
    }
  }

  const vcmdTimeoutMs = replayTimeoutMs()

  // Without a base commit the artifact can't be replayed deterministically — verify in place instead.
  // Deliberately never says VERIFIED and NEVER exits 0: an in-place pass proves the current tree, not
  // the receipt's artifact, so `fabula receipt verify && deploy` must not treat it as a proven replay.
  if (!r.base || !patch) {
    console.log(`Replay:   no recorded base commit/patch — running the verification in place (weaker than a full replay)`)
    const res = sh(vcmd, dir, vcmdTimeoutMs)
    console.log(res.out.slice(-2000))
    if (res.timedOut) { console.log(timeoutVerdict(vcmd, vcmdTimeoutMs)); return 1 }
    if (res.killed) { console.log(`\nINCONCLUSIVE — \`${vcmd}\` was killed by a signal (out of memory, or output exceeded the buffer) — not an artifact verdict.`); return 1 }
    console.log(
      res.code === 0
        ? `\nCHECK PASSED IN PLACE (exit 2) — \`${vcmd}\` exited 0 in the current tree. The artifact was NOT replayed; this is weaker than a replay verdict.`
        : `\nNOT DONE — \`${vcmd}\` failed (exit ${res.code}).`,
    )
    return res.code === 0 ? 2 : 1
  }

  // r.base comes from untrusted JSON and is interpolated into a shell line — accept only a git SHA.
  if (!/^[0-9a-f]{7,40}$/.test(r.base)) {
    console.error(`fabula receipt: invalid base commit ${JSON.stringify(r.base)} — expected an abbreviated or full lowercase git SHA.`)
    return 1
  }
  const tmp = path.join(os.tmpdir(), `fabula-replay-${process.pid}-${Math.floor(Math.random() * 1e6)}`)
  const patchAbs = path.isAbsolute(patch) ? patch : path.join(dir, patch)
  if (!existsSync(patchAbs)) {
    console.error(`fabula receipt: patch file not found: ${patchAbs} — the receipt's artifact is incomplete.`)
    return 1
  }
  console.log(`Replay:   worktree @ ${r.base.slice(0, 12)} + ${path.basename(patchAbs)} + \`${vcmd}\``)
  try {
    let wt = sh(`git worktree add --detach ${shq(tmp)} ${r.base}`, dir, 60_000)
    if (wt.code !== 0) {
      // The recorded base can be absent from THIS clone when the repo's history was squashed or
      // rewritten after the mint (a single-commit release policy does exactly that). Falling back to
      // HEAD is still a real verification — the patch must apply cleanly and the same check must
      // pass — just against the current tree instead of the exact recorded commit. Say so honestly.
      const head = sh(`git worktree add --detach ${shq(tmp)} HEAD`, dir, 60_000)
      if (head.code !== 0) {
        console.error(`fabula receipt: cannot create replay worktree (is ${r.base.slice(0, 12)} present?):\n${wt.out.slice(-800)}`)
        return 1
      }
      console.log(`Base:     recorded base ${r.base.slice(0, 12)} is absent from this clone (history rewritten after mint) — replaying against HEAD instead`)
      wt = head
    }
    // A 0-byte patch is only legitimate when the receipt itself claims no file edits. If it claims
    // edits (files > 0) but the patch is empty, the artifact is corrupt or forged — skipping apply and
    // running on the bare base is a fail-open path to a false VERIFIED. Fail closed.
    if (statSync(patchAbs).size === 0) {
      if ((r.artifact?.files ?? 0) > 0) {
        console.error(`NOT DONE — the receipt claims ${r.artifact!.files} changed file(s) but the recorded patch is empty; the artifact is incomplete or tampered.`)
        return 1
      }
      console.log(`Patch:    empty diff (receipt records no file edits) — running the verification on the bare base`)
    } else {
      const ap = sh(`git apply ${shq(patchAbs)}`, tmp, 60_000)
      if (ap.code !== 0) {
        console.error(`NOT DONE — the shipped patch does not apply cleanly to base ${r.base.slice(0, 12)}:\n${ap.out.slice(-800)}`)
        return 1
      }
    }
    // Re-run the check from the SAME repo-root-relative directory it was recorded in — a bare
    // `bun test` minted in a subproject must not sweep the whole worktree here.
    const vcwd = r.verification?.cwd ? path.join(tmp, r.verification.cwd) : tmp
    const res = sh(vcmd, existsSync(vcwd) ? vcwd : tmp, vcmdTimeoutMs)
    console.log(res.out.slice(-2000))
    if (res.timedOut) {
      console.log(timeoutVerdict(vcmd, vcmdTimeoutMs))
      return 1
    }
    if (res.killed) {
      console.log(`\nINCONCLUSIVE — \`${vcmd}\` was killed by a signal (out of memory, or output exceeded the buffer) — not an artifact verdict.`)
      return 1
    }
    if (res.code === 0) {
      if (identityContradicted) {
        // The work replayed and passed — say so, because it did. But the document contradicts itself
        // about WHO produced it, and a bare VERIFIED here would be this command asserting more than it
        // checked. Non-zero so `fabula receipt verify && deploy` stops, which is the whole reason this
        // file refuses to exit 0 on any weaker verdict.
        console.log(
          `\n❌ IDENTITY MISMATCH — the work replayed and \`${vcmd}\` passed, but this receipt's own descriptor ` +
            `does not hash to the value it claims. The tests are not in question; the document's account of itself is.`,
        )
        return 1
      }
      console.log(`\nVERIFIED ✓ — the artifact replayed deterministically: base ${r.base.slice(0, 12)} + patch → \`${vcmd}\` passed.`)
      return 0
    }
    console.log(`\nNOT DONE — replay failed: \`${vcmd}\` exited ${res.code} on base+patch.`)
    return 1
  } finally {
    sh(`git worktree remove --force ${shq(tmp)}`, dir, 30_000)
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

export const ReceiptCommand = cmd({
  command: "receipt [action] [file]",
  describe: "Proof-of-Done receipts: show, list, or deterministically re-verify (replay) a run's artifact",
  builder: (yargs: Argv) =>
    yargs
      .positional("action", {
        describe: "show (default) · list · verify",
        type: "string",
        default: "show",
        choices: ["show", "list", "verify"],
      })
      .positional("file", { describe: "receipt file (defaults to .fabula/receipts/latest)", type: "string" })
      .option("dir", { describe: "project directory (defaults to cwd)", type: "string" }),
  handler: async (args) => {
    const dir = path.resolve((args.dir as string) || process.cwd())
    const action = args.action as string

    if (action === "list") {
      const rd = receiptsDir(dir)
      const files = existsSync(rd)
        ? readdirSync(rd).filter((f) => f.endsWith(".json") && f !== "latest.json").sort().reverse()
        : []
      if (!files.length) {
        console.log(`No receipts in ${rd} yet. A green verify_done mints one; mint_receipt mints by hand.`)
        return
      }
      for (const f of files) {
        const r = readReceipt(path.join(rd, f))
        console.log(r ? `${f}  ${verdictLine(r)}` : `${f}  (unreadable)`)
      }
      return
    }

    const jsonPath = resolveReceiptPath(dir, args.file as string | undefined)
    if (!jsonPath) {
      console.error(`fabula receipt: no receipt found${args.file ? ` at ${args.file}` : ` in ${receiptsDir(dir)}`}. A green verify_done mints one.`)
      process.exitCode = 1
      return
    }

    if (action === "verify") {
      process.exitCode = verifyReceipt(dir, jsonPath)
      return
    }

    // show: prefer the human-readable .md next to the .json
    const md = jsonPath.replace(/\.json$/, ".md")
    if (existsSync(md)) {
      console.log(readFileSync(md, "utf8"))
      return
    }
    const shown = readReceipt(jsonPath)
    if (!shown) {
      console.error(`fabula receipt: cannot parse ${jsonPath} — the receipt file is corrupt or truncated.`)
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify(shown, null, 2))
  },
})
