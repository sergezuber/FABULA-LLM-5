// The receipt CLI's identity check — the wave's most-corrected surface, and until now its least covered.
//
// An independent verifier found that NOTHING drove `cli/cmd/receipt.ts`: `grep -rl "cmd/receipt"` over the
// engine tests returned empty. Three separate corrections landed here and each could be deleted with every
// other suite green.
//
// The defect that makes this file necessary is worth stating in full, because it is the one that keeps
// recurring in this project: the CLI **reimplemented** the descriptor canonicalisation instead of
// importing it (the engine cannot import from plugin/), and the copy diverged twice — it dropped
// null-valued entries the original keeps, and sorted [key,value] PAIRS instead of sorting by KEY. The two
// surfaces then returned OPPOSITE verdicts on the same document: an honest receipt was accused of
// contradicting itself, and a forged one passed. Receipt JSON is untrusted input, so the descriptor's keys
// are the forger's to choose.
//
// Two definitions of one rule in two modules is the failure; whichever runs first wins, and that changes.
// This file is the pin that keeps the duplicate honest.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

/** The project's canonicalisation, READ FROM `plugin/lib/modeldigest.ts` — not transcribed.
 *
 *  This was the last hand-written twin in the file, and it was the most dangerous one: the pin held the
 *  CLI to the TEST'S idea of the reference rather than to the project's actual definition, so a one-line
 *  edit to the real canonicaliser silently re-created the very inversion this file exists to prevent,
 *  with all three suites green. The engine cannot IMPORT from plugin/ — but it can read it, exactly as it
 *  reads the CLI. The rule stated in this header applies to every layer that holds a copy, including the
 *  one the test itself owns. */
function referenceExpressions(): { canon: string; hash: string } {
  const src = require("node:fs").readFileSync(
    new URL("../../../../../../plugin/lib/modeldigest.ts", import.meta.url), "utf8",
  ) as string
  // Same refusal the CLI extractor has, and it should have been written here in the same breath: this
  // function was ADDED in the round that gave `cliCanonicalExpression` its multi-match refusal, and did
  // not get it. An identical decoy above a divergent `descriptorHash` then passed the whole pin — the
  // wave's own headline finding, occurring inside the fix for that finding. A fix that creates a new
  // layer creates a new place for the copy to hide, so the rule has to be applied to the layer being
  // born, not only to the ones already known.
  const cs = [...src.matchAll(/const canonical = JSON\.stringify\(\s*([\s\S]*?)\s*,?\s*\)\n/g)]
  const hs = [...src.matchAll(/return (createHash\([\s\S]*?\)\.digest\("hex"\))/g)]
  if (!cs.length || !hs.length) throw new Error("could not read modeldigest's canonicalisation/hash — re-pin it here")
  if (cs.length > 1) throw new Error(`${cs.length} canonicalisation expressions in modeldigest.ts — one of them is not the reference; collapse them`)
  if (hs.length > 1) throw new Error(`${hs.length} digest expressions in modeldigest.ts — first-match would pick the wrong reference; collapse them`)
  return { canon: cs[0]![1]!, hash: hs[0]![1]! }
}
function referenceHash(d: Record<string, unknown>): string {
  const { canon, hash } = referenceExpressions()
  const expr = canon.replace(/\bd\b/g, "__d")
  const hashExpr = hash.replace(/\bcanonical\b/g, "__canon")
  // eslint-disable-next-line no-new-func
  return new Function("__d", "createHash", `const __canon = JSON.stringify(${expr}); return ${hashExpr}`)(d, createHash) as string
}

/** What the CLI computes — EXTRACTED FROM THE SOURCE, never hand-copied.
 *
 *  The first version of this helper was a hand-written twin of the CLI's expression, which reproduced in
 *  the test the very defect the test exists to catch: reverting the CLI to its old, divergent
 *  canonicalisation left this file green, because the twin never changed with it. A pin that carries its
 *  own copy of the thing it pins is not a pin. This reads the real line and evaluates it. */
function cliSource(): string {
  return require("node:fs").readFileSync(new URL("../../../src/cli/cmd/receipt.ts", import.meta.url), "utf8") as string
}
function cliCanonicalExpression(): string {
  const src = cliSource()
  // LAST match, not first: an identical decoy placed above a divergent real expression shadowed it, so
  // the pin verified a line the code never consumed. Anchor on the one nearest what actually hashes.
  const all = [...src.matchAll(/const canon = JSON\.stringify\(\s*([\s\S]*?)\s*\)\n/g)]
  if (!all.length) throw new Error("could not find the CLI's canonicalisation — it was renamed or restructured; re-pin it here")
  if (all.length > 1) throw new Error(`${all.length} canonicalisation expressions in the CLI — one of them is not the one that hashes; collapse them`)
  return all[0]![1]!
}
/** The HASH half, also extracted. Pinning the canonicalisation while hardcoding the digest left the hash
 *  function unpinned: switching the CLI to sha1, or to a latin1 encoding, passed this file untouched.
 *  latin1 is the reachable one — byte-identical for ASCII, divergent the moment a descriptor carries a
 *  non-ASCII publisher or model name, which is routine. Half a pin is the half you did not think about. */
function cliHashExpression(): string {
  const src = cliSource()
  const m = src.match(/const selfHash = (createHash\([\s\S]*?\)\.digest\("hex"\))/)
  if (!m) throw new Error("could not find the CLI's hash expression — re-pin it here")
  return m[1]!
}
function cliHash(d: Record<string, unknown>): string {
  const expr = cliCanonicalExpression().replace(/p2\.modelDescriptor/g, "d")
  const hashExpr = cliHashExpression().replace(/\bcanon\b/g, "__canon")
  // eslint-disable-next-line no-new-func
  return new Function("d", "createHash", `const __canon = JSON.stringify(${expr}); return ${hashExpr}`)(d, createHash) as string
}

describe("receipt CLI identity canonicalisation", () => {
  test("agrees with the reference on an ordinary descriptor", () => {
    const d = { id: "m", arch: "qwen", quantization: "Q6_K", publisher: "p" }
    expect(cliHash(d)).toBe(referenceHash(d))
  })

  test("agrees when a field is NULL — the divergence that inverted both verdicts", () => {
    // The first CLI copy filtered these out. An honest receipt carrying `arch: null` hashed to one value
    // under the project's definition and another under the CLI's, so `verify_receipt` said VERIFIED while
    // the CLI said the document contradicts itself.
    const d = { id: "m", arch: null, quantization: "Q6_K", publisher: undefined } as any
    expect(cliHash(d)).toBe(referenceHash(d))
  })

  test("agrees on keys where one is a prefix of another", () => {
    // A bare `.sort()` on [k,v] pairs compares "a,1" against "a!b,2" — the separator decides, not the key.
    // The forger picks the keys, so this is reachable input, not a curiosity.
    const d = { a: "1", "a!b": "2", ab: "3" }
    expect(cliHash(d)).toBe(referenceHash(d))
  })

  test("key ORDER in the object never changes the hash", () => {
    const one = { id: "m", arch: "x", publisher: "p" }
    const two = { publisher: "p", arch: "x", id: "m" }
    expect(cliHash(one)).toBe(cliHash(two))
    expect(cliHash(one)).toBe(referenceHash(two))
  })

  test("agrees on NON-ASCII descriptors — the encoding, not just the algorithm", () => {
    // Every fixture here was ASCII, over which latin1 and utf8 are byte-identical — so switching the CLI
    // to latin1 passed the pin untouched while diverging on any Cyrillic, Chinese, accented or emoji
    // value. Those are ordinary LM Studio publisher and model names, not curiosities.
    for (const d of [
      { id: "m", publisher: "Сообщество" },
      { id: "m", publisher: "阿里巴巴" },
      { id: "m", publisher: "Mistral-Ké" },
      { id: "llama-🦙-8b", publisher: "p" },
    ]) {
      expect(cliHash(d)).toBe(referenceHash(d))
    }
  })

  test("a changed VALUE does change the hash — the check is not vacuous", () => {
    expect(cliHash({ id: "m", arch: "x" })).not.toBe(cliHash({ id: "m", arch: "y" }))
  })
})

describe("what the CLI DOES — the real command, driven end to end", () => {
  // Source `toContain` was the first form of these three, and an independent verifier defeated all of
  // them without touching behaviour: a COMMENT satisfies `identityContradicted = true`, and
  // `if (false && …)` satisfies every one of them while the CLI goes on to print a statement that is
  // FALSE about the document in front of it and exit 0. That is the W4 lesson — already recorded in this
  // project after a mutation replaced a reset with a comment carrying the same text — recurring in the
  // same file, which is why these now run the command instead of reading it.
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require("node:fs") as typeof import("node:fs")
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
  const os = require("node:os") as typeof import("node:os")
  const nodePath = require("node:path") as typeof import("node:path")

  const BIN = nodePath.join(import.meta.dir, "..", "..", "..", "..", "..", "..", "bin", "fabula")
  const haveBin = require("node:fs").existsSync(BIN)
  // `bin/fabula` is gitignored, so on a fresh clone or a CI runner that has not built, the two behavioural
  // cases below simply SKIP — the half added precisely because source-greps were defeatable disappears,
  // and a silent skip reports nothing. Say it out loud; a gap nobody is told about is a gap nobody closes.
  if (!haveBin) {
    console.warn(
      `[W8] bin/fabula is absent — the two behavioural CLI checks are SKIPPED, so this file is currently ` +
        `only pinning source text. Run ./build.sh to get the guarantee they provide.`,
    )
  }
  const DESCRIPTOR = { id: "m", arch: "qwen", quantization: "Q6_K", publisher: "p" }
  const HONEST = referenceHash(DESCRIPTOR)

  function runVerify(descriptorHashValue: string): { out: string; code: number } {
    const dir = mkdtempSync(nodePath.join(os.tmpdir(), "w8-cli-"))
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir })
      writeFileSync(nodePath.join(dir, "f.txt"), "one\n")
      execFileSync("git", ["add", "-A"], { cwd: dir })
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: dir })
      const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()
      // A REAL patch, so the command takes the REPLAY path. Without one it reports "no recorded base
      // commit/patch — running the verification in place" and never reaches the success branch where the
      // identity verdict decides the exit code — so a fixture without a patch cannot tell a working guard
      // from a commented-out one. The test has to create the condition it is testing.
      writeFileSync(nodePath.join(dir, "f.txt"), "two\n")
      const patch = execFileSync("git", ["diff"], { cwd: dir, encoding: "utf8" })
      execFileSync("git", ["checkout", "--", "f.txt"], { cwd: dir })
      mkdirSync(nodePath.join(dir, ".fabula", "receipts"), { recursive: true })
      const rp = nodePath.join(dir, ".fabula", "receipts", "r.json")
      writeFileSync(rp, JSON.stringify({
        version: "fabula-receipt/v0", mintedAt: 1, base,
        model: { id: "m", host: "local" }, task: "t", gates: [],
        artifact: { files: 1, bytes: patch.length, patch: ".fabula/receipts/patch.diff" },
        verification: { cmd: "true", exitCode: 0, passed: true, outputTail: "" },
        provenance: { engineVersion: "0", step: 1, modelDescriptorHash: descriptorHashValue, modelDescriptor: DESCRIPTOR },
      }))
      writeFileSync(nodePath.join(dir, ".fabula", "receipts", "patch.diff"), patch)
      // The DEPLOYED binary, not `bun run src/index.ts`: the CLI cannot start from source in this
      // checkout (`react/jsx-dev-runtime` is absent), and running the shipped artifact is the more honest
      // test anyway — it is what a user's `fabula receipt verify` actually executes. If the binary is
      // stale relative to source, `scripts/verify-deploy.sh` is the guard that says so; this file only
      // asks what the shipped command does.
      try {
        const out = execFileSync(BIN, ["receipt", "verify", rp, "--dir", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
        return { out, code: 0 }
      } catch (e: any) {
        return { out: String(e?.stdout ?? "") + String(e?.stderr ?? ""), code: typeof e?.status === "number" ? e.status : 1 }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test.if(haveBin)("the binary under test was built from the CURRENT source", () => {
    // Targeting the shipped artifact is right — it is what a user runs — but then FRESHNESS has to live
    // in this file. A manual script beside it does not help: in an ordinary edit-then-test loop the guard
    // reported green on code that was never built, so a source regression stayed invisible until someone
    // happened to rebuild. Measured that way once: the comment bypass was live in source and this file
    // still passed 10/0.
    const fs2 = require("node:fs") as typeof import("node:fs")
    const binMtime = fs2.statSync(BIN).mtimeMs
    const srcPath = nodePath.join(import.meta.dir, "..", "..", "..", "src", "cli", "cmd", "receipt.ts")
    const srcMtime = fs2.statSync(srcPath).mtimeMs
    if (srcMtime > binMtime) {
      throw new Error(
        `cli/cmd/receipt.ts is NEWER than bin/fabula — the behavioural checks below are testing a binary ` +
          `that does not contain your change. Run ./build.sh, then re-run. (src ${new Date(srcMtime).toISOString()} > bin ${new Date(binMtime).toISOString()})`,
      )
    }
    // …and mtime alone is not freshness: `touch bin/fabula` satisfies it, and so does a `cp` restore from
    // one of the backups sitting in bin/, a partial build, or a codesign pass. `verify-deploy.sh` already
    // does the stronger half by grepping the BINARY for source strings; taking the mtime half and leaving
    // the content half behind is the same half-a-pin shape as the hash line two rounds ago. So: a marker
    // this file's own subject must contain.
    const marker = "unverifiable here and everywhere, by construction"
    if (!fs2.readFileSync(srcPath, "utf8").includes(marker)) {
      throw new Error(`the source no longer contains the marker this freshness check pins (${marker}) — update it here`)
    }
    if (!fs2.readFileSync(BIN).includes(marker)) {
      throw new Error(
        `bin/fabula does not contain \`${marker}\` — its timestamp is newer than the source but its CONTENT ` +
          `predates this wave. A touched, restored or partially-built binary passes an mtime check and fails this one.`,
      )
    }
  })

  test.if(haveBin)("a SELF-CONTRADICTING receipt is reported and exits non-zero", () => {
    const r = runVerify("f".repeat(64))
    expect(r.out).toContain("MISMATCH")
    expect(r.code).not.toBe(0) // `fabula receipt verify && deploy` must stop here
    // …and it must differ from the honest run, or "non-zero" proves nothing about this fixture
    expect(r.out).not.toBe(runVerify(HONEST).out)
  }, 60_000)

  test.if(haveBin)("an HONEST receipt is NOT accused", () => {
    // The other direction matters as much: a check that fires on everything is not a check — and the
    // round-2 defect was precisely that an honest receipt got accused while a forged one passed.
    //
    // The comment here used to say this fixture carried no patch and therefore exited 2 — true when it
    // was written, false once the same round gave `runVerify` a real commit and diff. `not.toBe(1)` then
    // passed on 0 AND on 2, so it would still have passed if the honest path silently degraded back to
    // the weaker in-place check: the exact fixture defect this round records as fixed.
    const r = runVerify(HONEST)
    expect(r.out).not.toContain("MISMATCH")
    expect(r.code).toBe(0) // a full replay, not the weaker in-place path
  }, 60_000)
})

describe("what the CLI must say", () => {
  const src = () => require("node:fs").readFileSync(new URL("../../../src/cli/cmd/receipt.ts", import.meta.url), "utf8")

  test("a self-contradicting receipt is reported AND changes the exit code", () => {
    // The first version printed the objection and still returned 0, so `fabula receipt verify && deploy`
    // deployed it. A line nobody's script reads is not a verdict.
    const s = src()
    expect(s).toContain("identityContradicted = true")
    expect(s).toContain("IDENTITY MISMATCH")
    // …and the success path must consult it before printing a bare VERIFIED
    const successBlock = s.slice(s.indexOf("if (res.code === 0)"), s.indexOf("NOT DONE — replay failed"))
    expect(successBlock).toContain("identityContradicted")
    expect(successBlock).toContain("return 1")
  })

  test("a hash with no descriptor beside it is named as unverifiable by construction", () => {
    // Omitting `modelDescriptor` while keeping its hash defeats the no-network check for free. Nothing
    // requires a receipt to publish the descriptor it hashed, so that shape has to name itself.
    expect(src()).toContain("unverifiable here and everywhere, by construction")
  })

  test("the whole identity block is behind the wave switch", () => {
    const s = src()
    expect(s).toContain("process.env.FABULA_RECHECK")
    expect(s.slice(s.indexOf("let identityContradicted"), s.indexOf("const vcmdTimeoutMs"))).toContain("if (w8)")
  })
})
