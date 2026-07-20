// W8 — a proof must not assert more than its verification checks.
//
// The Proof-of-Done receipt makes two very different kinds of claim, and until now only one of them was
// ever checked. The EXPENSIVE claim — "this patch makes this project's own tests pass" — is genuinely
// re-run: the patch is materialised in a throwaway worktree at the base commit and the recorded command
// executes for real. The CHEAP claims — which model, which weights, which context — were printed straight
// out of the same JSON the verification was supposed to be checking. So the half that is hard to forge was
// verified and the half that is trivial to forge was echoed back, in the same breath, with nothing in the
// output distinguishing the two. That asymmetry is exactly backwards from where forgery is easy, and it is
// what this module exists to remove.
//
// THREE STATES, and there is no fourth. Every identity claim a receipt makes ends up in exactly one:
//
//   re-verified here   — recomputed on THIS machine and it agrees
//   not checkable here — the receipt claims it, and this machine genuinely cannot derive it
//   contradicted here  — recomputed and it DISAGREES
//
// A claim the receipt never made is none of those and stays silent: announcing "weights digest: not
// claimed" on every receipt would be noise wearing the costume of rigour.
//
// WHAT A MISMATCH MEANS, which is the wave's most consequential decision. A contradicted identity fails
// the IDENTITY claim and never the WORK claim. Recomputing a descriptor proves what is being served *now,
// on this machine* — so a verifier elsewhere can only ever say "I cannot check this here". Failing a whole
// receipt because the verifying box currently serves a different quantisation would be this mechanism
// committing precisely the overclaim it was built to remove. The verdict is therefore two-dimensional,
// and the renderer must show both halves.

import { createHash } from "node:crypto"

export type ClaimState = "re-verified here" | "not checkable here" | "contradicted here"

export interface ClaimCheck {
  field: string
  state: ClaimState
  /** what the receipt asserted (truncated for display) */
  claimed?: string
  /** what this machine derived, when it could derive anything */
  observed?: string
  /** why, in one line — a reader must never have to guess which of the three this is */
  reason: string
}

export interface IdentityVerdict {
  claims: ClaimCheck[]
  reVerified: number
  notCheckable: number
  contradicted: number
  /** true when nothing was contradicted — NOT a claim that anything was proven */
  ok: boolean
  /** the one-line summary a header can carry without overstating */
  summary: string
}

const short = (s: unknown, n = 16): string => {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? "")
  return t.length > n ? t.slice(0, n) + "…" : t
}

/** The identity fields a receipt can carry. Order is the display order. */
export const IDENTITY_FIELDS = [
  "modelDescriptorHash",
  "weightsDigest",
  "bundlePrefixHash",
  "inputHash",
  "routerProfile",
  "midTurnBreaks",
] as const

/** What a caller can supply as "what this machine currently observes". Every entry is OPTIONAL, and an
 *  absent entry means "this machine cannot derive it" — never "it matched". */
export interface Observed {
  modelDescriptorHash?: string
  weightsDigest?: { digest: string; files: number; bytes: number }
  bundlePrefixHash?: string
  inputHash?: string
  routerProfile?: string
  midTurnBreaks?: number
  /** why a field could not be derived, keyed by field — surfaces in the reason rather than a blank */
  unavailable?: Record<string, string>
}

function claimedValue(prov: any, field: string): unknown {
  const v = prov?.[field]
  if (v === undefined || v === null) return undefined
  if (field === "weightsDigest") return typeof v === "object" ? v.digest : v
  return v
}

function observedValue(obs: Observed | undefined, field: string): unknown {
  const v = (obs as any)?.[field]
  if (v === undefined || v === null) return undefined
  if (field === "weightsDigest") return typeof v === "object" ? v.digest : v
  return v
}

/**
 * Compare what a receipt CLAIMS against what this machine OBSERVES, field by field.
 *
 * Deliberately takes the observations as an argument rather than gathering them itself: gathering is
 * environment-dependent and slow, comparison is neither, and a pure comparator is the part that has to be
 * right. It also means a caller can be honest about *why* a field is unavailable instead of the comparator
 * inventing a reason.
 */
export function checkIdentity(provenance: any, observed?: Observed): IdentityVerdict {
  const claims: ClaimCheck[] = []
  for (const field of IDENTITY_FIELDS) {
    const claimed = claimedValue(provenance, field)
    if (claimed === undefined) continue // the receipt made no such claim — silence is honest here
    const obs = observedValue(observed, field)
    if (obs === undefined) {
      const why = observed?.unavailable?.[field]
      claims.push({
        field,
        state: "not checkable here",
        claimed: short(claimed),
        reason: why
          ? `not checkable here — ${why}`
          : `not checkable here — this machine cannot derive ${field}; the receipt asserts it and nothing confirms it`,
      })
      continue
    }
    const same = String(claimed) === String(obs)
    claims.push({
      field,
      state: same ? "re-verified here" : "contradicted here",
      claimed: short(claimed),
      observed: short(obs),
      reason: same
        ? `re-verified here — recomputed on this machine and it matches`
        // Say MISMATCH, in the word a reader and a grep both recognise. "Contradicted here" was the first
        // wording and it was a private coinage: precise to whoever wrote it, invisible to anyone scanning
        // for the ordinary vocabulary of failure. A state nobody can find is a state nobody acts on.
        : `MISMATCH — does not match: the receipt claims ${short(claimed)}, this machine derived ${short(obs)} — the recomputed value disagrees`,
    })
  }

  const reVerified = claims.filter((c) => c.state === "re-verified here").length
  const notCheckable = claims.filter((c) => c.state === "not checkable here").length
  const contradicted = claims.filter((c) => c.state === "contradicted here").length
  return {
    claims,
    reVerified,
    notCheckable,
    contradicted,
    ok: contradicted === 0,
    summary:
      contradicted > 0
        ? `identity MISMATCH — ${contradicted} of ${claims.length} claim(s) disagree with this machine and do not match what it derived`
        : claims.length === 0
          ? "identity: the receipt makes no identity claim"
          : reVerified === 0
            ? `identity asserted, NOT checkable here (${notCheckable} claim(s) — this machine cannot derive any of them)`
            : `identity: ${reVerified} re-verified here, ${notCheckable} not checkable here`,
  }
}

/** Render the per-claim states for a human. Every line says which of the three it is, by name: a reader
 *  must never have to infer from formatting whether something was checked. */
export function renderIdentity(v: IdentityVerdict): string {
  if (!v.claims.length) return ""
  const lines = [`identity — ${v.summary}`]
  for (const c of v.claims) {
    const mark = c.state === "re-verified here" ? "✅" : c.state === "contradicted here" ? "❌" : "•"
    lines.push(`  ${mark} ${c.field}: ${c.reason}`)
  }
  return lines.join("\n")
}

// ── the gate's own verdict, carried into the artifact ──────────────────────────────────────────────
//
// `reprogate` produces an exact vocabulary — validated, fake (passes on base), post-fails,
// sibling-failed, and not-validated(<reason>) when the fail-to-pass probe could not run at all — and no
// receipt module read a word of it. A receipt minted after the strict probe degraded to its permissive
// fallback was byte-indistinguishable from one where the probe ran and passed: the gate was honest with
// itself and silent to the artifact that outlives it.
//
// ABSENCE IS ITS OWN STATE. Hook order here is a glob scan, so the receipt can mint BEFORE the gate has
// stamped anything — in which case there is no verdict to carry and the old code minted a plain green.
// "No mark" therefore renders as UNKNOWN, explicitly, and never as validated. The rendering must not
// depend on winning a race.

export type GateClaim = "validated" | "degraded" | "failed" | "unknown"

export interface GateVerdict {
  claim: GateClaim
  /** the raw mark, kept verbatim so an auditor sees what the gate actually said */
  mark?: string
  reason: string
}

export function gateVerdictOf(marks: any): GateVerdict {
  const ftp = marks?.failToPass
  const p2p = marks?.passToPass
  if (typeof ftp !== "string" || !ftp.trim()) {
    return {
      claim: "unknown",
      reason:
        "reproduce gate: NO verdict recorded — this receipt cannot say whether the fail-to-pass probe ran. " +
        "Absence of a mark is not a pass.",
    }
  }
  if (/^not-validated/i.test(ftp)) {
    return {
      claim: "degraded",
      mark: ftp,
      reason: `reproduce gate DEGRADED: the strict fail-to-pass probe did not run (${ftp}); this fell back to the permissive check, so the reproduction was NOT validated here`,
    }
  }
  if (/^fake/i.test(ftp)) return { claim: "failed", mark: ftp, reason: `reproduce gate: the reproduction is FAKE — ${ftp}` }
  if (/^post-fails/i.test(ftp)) return { claim: "failed", mark: ftp, reason: "reproduce gate: the test does not pass on the patched tree" }
  if (p2p === "sibling-failed") return { claim: "failed", mark: `${ftp} · ${p2p}`, reason: "reproduce gate: a pre-existing sibling test broke (pass-to-pass regression)" }
  if (/^validated/i.test(ftp) || /^no-change \(verified\)/i.test(ftp)) {
    return { claim: "validated", mark: ftp, reason: "reproduce gate VALIDATED: the test fails on the pre-patch tree and passes on the patched one" }
  }
  return { claim: "unknown", mark: ftp, reason: `reproduce gate: unrecognised verdict ${JSON.stringify(ftp)} — treated as unknown, never as a pass` }
}

/** One line for the rendered receipt. A degraded or unknown gate must read as weaker than a validated
 *  one to someone skimming — that is the whole point of carrying the mark at all. */
export function renderGate(v: GateVerdict): string {
  const mark = v.claim === "validated" ? "✅" : v.claim === "failed" ? "❌" : "⚠️"
  return `${mark} ${v.reason}`
}

/** sha256, exposed so a caller recomputing a claim uses the same function the claim was made with. */
export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

// ── gathering what THIS machine can observe ────────────────────────────────────────────────────────
//
// Kept separate from `checkIdentity` on purpose: gathering is environment-dependent, slow, and full of
// reasons a thing might be unavailable; comparison is none of those. Keeping them apart is also what lets
// the comparator report an HONEST reason for an absence instead of inventing one.
//
// BUDGET: the default path must not add more than ~2s to a verification. The descriptor is one local HTTP
// call behind a short timeout; the weights re-hash is minutes on a real model and is therefore opt-in
// (`FABULA_WEIGHTS_DIGEST`), never default. A check nobody can afford is a check nobody runs.

export const IDENTITY_RECHECK_ENV = "FABULA_RECHECK_IDENTITY"

/** The wave's single switch. `FABULA_RECHECK=0` must restore the pre-W8 output BYTE-FOR-BYTE on every
 *  surface — not "approximately", because the only reason to keep a switch is so someone can fall back
 *  cleanly when this misbehaves, and a fallback that changes the output is not a fallback. Read at CALL
 *  time: a switch captured once at import is a build-time constant wearing an env var's name. */
export const RECHECK_ENV = "FABULA_RECHECK"
export function recheckEnabled(env: Record<string, string | undefined> = process.env as any): boolean {
  return String(env?.[RECHECK_ENV] ?? "1").trim() !== "0"
}
export const MODEL_API_ENV = "FABULA_MODEL_API"

/** Ask the serving registry what it is running RIGHT NOW, and hash it the same way the claim was made. */
export async function observeDescriptor(
  modelId: string,
  opts: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ hash?: string; why?: string }> {
  const env = opts.env ?? (process.env as any)
  const url = (env[MODEL_API_ENV] || "http://localhost:1234/api/v0/models").trim()
  if (!url) return { why: "no model registry endpoint is configured on this machine" }
  const doFetch = opts.fetchImpl ?? fetch
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 1500)
  try {
    const r = await doFetch(url, { signal: ctl.signal } as any)
    if (!r.ok) return { why: `the model registry answered HTTP ${r.status}` }
    const payload = await r.json()
    const { pickDescriptor, descriptorHash } = require("./modeldigest") as typeof import("./modeldigest")
    const d = pickDescriptor(payload, modelId)
    if (!d) return { why: `this machine is not serving \`${modelId}\`` }
    return { hash: descriptorHash(d) }
  } catch (e) {
    // Unreachable is NOT a mismatch. The whole three-state design exists so that "I could not look"
    // never quietly becomes either "it matched" or "it is forged".
    return { why: `the model registry is unreachable here (${(e as Error)?.message ?? "error"})` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Re-check a whole receipt's identity claims against this machine.
 *
 * `FABULA_RECHECK_IDENTITY=0` restores the pre-W8 behaviour exactly: nothing is recomputed and every
 * claim is reported as not-checkable — which is the honest description of what the old code did, having
 * simply printed the receipt's own numbers back.
 */
export async function recheckIdentity(
  receipt: any,
  opts: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch } = {},
): Promise<IdentityVerdict> {
  const env = opts.env ?? (process.env as any)
  const prov = receipt?.provenance ?? {}
  if (String(env[IDENTITY_RECHECK_ENV] ?? "1").trim() === "0") {
    return checkIdentity(prov, {
      unavailable: Object.fromEntries(
        IDENTITY_FIELDS.map((f) => [f, `identity re-checking is disabled (${IDENTITY_RECHECK_ENV}=0)`]),
      ),
    })
  }

  const unavailable: Record<string, string> = {}
  const observed: Observed = { unavailable }

  // SELF-CONSISTENCY first, because it needs no network, no model and no machine state: the receipt
  // prints a descriptor AND the hash that is supposed to cover it. If those two disagree, the receipt
  // contradicts ITSELF, and that is detectable anywhere, forever, by anyone — including on a machine that
  // can check nothing else. Skipping it would mean the cheapest possible check went unrun while the
  // expensive ones were debated.
  if (prov.modelDescriptorHash && prov.modelDescriptor) {
    try {
      const md = require("./modeldigest") as typeof import("./modeldigest")
      const selfHash = md.descriptorHash(prov.modelDescriptor as any)
      if (selfHash !== String(prov.modelDescriptorHash)) {
        return checkIdentity(prov, {
          ...observed,
          modelDescriptorHash: selfHash,
          unavailable,
        })
      }
    } catch { /* an unhashable descriptor falls through to the normal path rather than failing the run */ }
  }

  if (prov.modelDescriptorHash) {
    const d = await observeDescriptor(String(receipt?.model?.id ?? ""), { env, fetchImpl: opts.fetchImpl })
    if (d.hash) observed.modelDescriptorHash = d.hash
    else unavailable.modelDescriptorHash = d.why ?? "could not be derived here"
  }

  // The weights digest is minutes of hashing and is deliberately NOT recomputed by default. Saying so
  // by name is the point: silence would render identically to a field that had been checked.
  if (prov.weightsDigest) {
    if (String(env.FABULA_WEIGHTS_DIGEST ?? "0").trim() !== "1") {
      // Named, not silent. Rendering nothing here would be indistinguishable from a field that HAD been
      // checked, which is the fourth unstated category this design forbids.
      unavailable.weightsDigest =
        "re-hashing weights is opt-in (FABULA_WEIGHTS_DIGEST=1) because it costs minutes, so it was not attempted here"
    } else {
      try {
        const md = require("./modeldigest") as typeof import("./modeldigest")
        const nodeOs = require("node:os") as typeof import("node:os")
        const nodePath = require("node:path") as typeof import("node:path")
        const root = (env.FABULA_MODELS_ROOT || nodePath.join(nodeOs.homedir(), ".lmstudio", "models")).trim()
        const dir = md.resolveModelDir(String(receipt?.model?.id ?? ""), root, env.FABULA_MODEL_DIR)
        const got = dir ? md.weightsDigestForDir(dir) : undefined
        if (got) observed.weightsDigest = got
        else unavailable.weightsDigest = "the weight files for this model are not present on this machine"
      } catch (e) {
        unavailable.weightsDigest = `the weights could not be hashed here (${(e as Error)?.message ?? "error"})`
      }
    }
  }

  // The prefix, the input hash and the router profile describe a context that existed during THAT run.
  // They cannot be reconstructed from a receipt on another machine, and pretending otherwise would be the
  // fourth, unstated category this design forbids.
  for (const f of ["bundlePrefixHash", "inputHash", "routerProfile", "midTurnBreaks"] as const) {
    if (prov[f] !== undefined && prov[f] !== null) {
      unavailable[f] = "describes the context of the original run and cannot be reconstructed on another machine"
    }
  }

  return checkIdentity(prov, observed)
}
