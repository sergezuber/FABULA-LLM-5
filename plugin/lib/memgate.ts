// W7 — what is allowed to become a memory, and the two halves that must stay apart.
//
// THE SIGNALS THAT LOOK RIGHT AND ARE FALSIFIED. Each of these was tried in published work and each
// fails for a different reason, so none of them may open this gate on its own:
//
//   RECURRENCE — "the agent concluded this three times, so it must be right." The three observations are
//   not independent: one model with one system prompt repeating one wrong belief is a single sample
//   copied three times. Dependency-aware measurement puts false promotion from correlated traces at 0.371
//   before governance.
//
//   AGREEMENT VOTES — measured to ENTRENCH confabulations rather than filter them: a fabricated rule with
//   two agreeing votes enters the shared library and is then applied everywhere. In one study 0 of 121
//   reflections named the correct object, and the votes did not notice.
//
//   AN LLM AUDIT — defeated by construction. A poison built from genuinely CORRECT but non-transferable
//   edge cases passes any content filter and any model auditor, because nothing in it is false. Over 50%
//   attack success against a strong model under exactly this defense.
//
//   SELF-REPORTED CONFIDENCE — an LLM-judged trust scorer was measured accepting 82 entries of which 54
//   were malicious, all at maximum trust.
//
// What is left is the thing none of them are: an EXTERNAL OUTCOME. Did the project's own verifier go
// green on the work this memory came from? That is a fact produced outside the model, and it is the only
// signal here that a model cannot talk its way into.
//
// It is necessary and NOT sufficient — the same OEP poison above is locally correct, so it would carry a
// green outcome. This gate does not claim to solve poisoning; it claims to refuse the four signals that
// are known to be gameable, and to require one that is not.
//
// ── THE SECOND HALF: DECIDING IS NOT ACTING ────────────────────────────────────────────────────────
// `decideAdmission` always runs and always returns a verdict. `promotionEnabled` decides whether anything
// happens as a result, and it is OFF by default. Two independent production systems converged on exactly
// this — a three-valued switch shipping in shadow, writing decisions to a log while promoting nothing —
// and this project reached the same conclusion the hard way one wave ago: a default has to be earned by
// evidence, and you cannot have the evidence before you have logged the decisions.
//
// They are separate FUNCTIONS rather than one function with a flag, because a shadow mode sharing a code
// path with promotion is one typo away from promoting.

export type AdmissionVerdict = "admit" | "refuse"

export interface AdmissionDecision {
  decision: AdmissionVerdict
  /** one line, for the shadow log and for the human reading it later */
  reason: string
  /** what actually decided it, so a shadow log can be audited rather than trusted */
  basis: "verified-outcome" | "no-outcome" | "red-outcome" | "no-origin" | "empty"
}

export const PROMOTION_ENV = "FABULA_MEM_PROMOTE"
export const SHADOW_LOG = "promotion_decisions.jsonl"

/** The gameable signals, named here so the refusal message can say WHICH one was offered. */
const FALSIFIED_SIGNALS = ["recurrence", "votes", "vote", "audit", "llmAudit", "confidence", "score", "agreement"] as const

function outcomeOf(c: any): boolean | null {
  if (!c || typeof c !== "object") return null
  for (const k of ["outcome", "verified", "green", "passed", "verifyGreen", "testsPassed"]) {
    const v = c[k]
    if (typeof v === "boolean") return v
    if (typeof v === "string") {
      const s = v.trim().toLowerCase()
      if (/^(green|pass|passed|true|ok|resolved)$/.test(s)) return true
      if (/^(red|fail|failed|false)$/.test(s)) return false
      if (/^(unknown|pending|none|n\/a)$/.test(s)) return null
    }
  }
  for (const k of ["verdict", "status", "result"]) {
    const v = c[k]
    if (typeof v === "string") {
      const s = v.trim().toLowerCase()
      if (/^(green|pass|passed|ok|resolved)$/.test(s)) return true
      if (/^(red|fail|failed|false|broken)$/.test(s)) return false
    }
  }
  return null
}

function hasOrigin(c: any): boolean {
  // The store and the gate must mean the SAME thing by "origin", or B2 has two definitions and the
  // weaker one is whichever runs first tomorrow. A truthy object was not enough: `origin: {}` and
  // `origin: []` passed here while `appendRaw` correctly refused them.
  const o = c?.origin
  return !!o && typeof o === "object" && !Array.isArray(o) && typeof (o as any).kind === "string" && !!(o as any).kind
}

function offeredFalsified(c: any): string[] {
  if (!c || typeof c !== "object") return []
  return FALSIFIED_SIGNALS.filter((k) => c[k] !== undefined && c[k] !== null).map(String)
}

/**
 * THE DECISION. Always runs, never acts.
 *
 * Note what is deliberately absent: there is no branch anywhere below that reads recurrence, votes, an
 * audit result or a confidence number. They are read in exactly one place — to name them in the refusal —
 * so that offering them cannot change the answer even by accident.
 */
export function decideAdmission(candidate: any, _opts: Record<string, any> = {}): AdmissionDecision {
  if (!candidate || typeof candidate !== "object") {
    return { decision: "refuse", reason: "nothing to admit.", basis: "empty" }
  }
  if (!hasOrigin(candidate)) {
    // Bound at write time or not at all: provenance attached later can be laundered by the agent's own
    // summary, by a tool echoing the content back, or by manufactured corroboration.
    return {
      decision: "refuse",
      reason: "no origin bound at write time — provenance added later can be laundered, so this is not stored.",
      basis: "no-origin",
    }
  }
  const outcome = outcomeOf(candidate)
  if (outcome === true) {
    return {
      decision: "admit",
      reason: "the project's own verifier went green on the work this came from — an outcome produced outside the model.",
      basis: "verified-outcome",
    }
  }
  const offered = offeredFalsified(candidate)
  const tail = offered.length
    ? ` ${offered.join(", ")} ${offered.length === 1 ? "was" : "were"} offered and ${offered.length === 1 ? "does" : "do"} not count: ` +
      `repetition of one model's belief is one sample copied, agreement entrenches confabulation, an audit passes a locally-correct poison, ` +
      `and self-reported confidence has been measured at maximum on malicious entries.`
    : ""
  if (outcome === false) {
    return { decision: "refuse", reason: `the verifier went red on the work this came from.${tail}`, basis: "red-outcome" }
  }
  return { decision: "refuse", reason: `no external verifier outcome — nothing outside the model vouches for this.${tail}`, basis: "no-outcome" }
}

/** Is acting on a decision enabled? OFF unless explicitly turned on. */
export function promotionEnabled(env: Record<string, string | undefined> = process.env as any): boolean {
  const raw = String(env[PROMOTION_ENV] ?? "").trim().toLowerCase()
  return raw === "1" || raw === "on" || raw === "true" || raw === "governed" || raw === "promote"
}

export interface PromotionOutcome {
  decision: AdmissionVerdict
  /** did anything actually happen? false in shadow, which is the default */
  promoted: boolean
  shadow: boolean
  reason: string
  basis: AdmissionDecision["basis"]
}

/**
 * ACT on a decision — or, by default, do not.
 *
 * In shadow the decision is still computed and still recorded; only the effect is withheld. A shadow mode
 * that logs nothing is indistinguishable from a disabled mechanism, and would leave the eventual "turn it
 * on" decision resting on no evidence at all — which is the failure this split exists to prevent.
 */
export function admitMemory(candidate: any, opts: Record<string, any> = {}): PromotionOutcome {
  const d = decideAdmission(candidate, opts)
  const enabled = opts.promote === true ? true : opts.promote === false ? false : promotionEnabled(opts.env)
  const shadow = !enabled
  recordDecision(d, candidate, shadow, opts)
  return {
    decision: d.decision,
    promoted: enabled && d.decision === "admit",
    shadow,
    basis: d.basis,
    reason: shadow ? `${d.reason} (shadow mode: recorded, not promoted — set ${PROMOTION_ENV}=1 to act on it)` : d.reason,
  }
}

/** Append the decision to the shadow log. Never throws: a mechanism that cannot write its journal must
 *  still return its verdict, and a failed log line must not take a turn down with it. */
export function recordDecision(d: AdmissionDecision, candidate: any, shadow: boolean, opts: Record<string, any> = {}): void {
  try {
    const fs = require("node:fs") as typeof import("node:fs")
    const path = require("node:path") as typeof import("node:path")
    const { storeDir } = require("./memstore") as typeof import("./memstore")
    const dir = opts.dir || storeDir(opts.env)
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      path.join(dir, SHADOW_LOG),
      JSON.stringify({
        id: candidate?.id ?? null,
        decision: d.decision,
        basis: d.basis,
        reason: d.reason,
        shadow,
        at: Date.now(),
      }) + "\n",
      "utf8",
    )
  } catch { /* the verdict stands whether or not the journal took it */ }
}
