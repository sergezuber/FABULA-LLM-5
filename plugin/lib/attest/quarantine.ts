// fabula-attest — untrusted-evidence quarantine (design H, the P0 the review found both layers missed).
// A verification gate FETCHES evidence and feeds it to an LLM oracle/critic; a poisoned page would
// otherwise turn the gate into a lie-attestation machine. So any evidence that is not the user's own
// local source is HTML-stripped (arXiv:2604.27202 — ~70% of injections hide in non-rendered HTML),
// threat-scanned, and wrapped (arXiv:2607.05277 UCM quarantine boundary) before it can reach the oracle.
// Reuses the shipped anti-injection primitives; adds only the strip + the trust gate. Pure, unit-tested.

import { wrapUntrusted } from "../untrusted"
import { scanThreats, threatBanner } from "../threatscan"

/** local-source = the user's own files, trusted verbatim. fetched/untrusted-file = attacker-influenceable. */
export type EvidenceTrust = "local-source" | "fetched" | "untrusted-file"

/** Remove content the model would never see rendered but an injection can still hide in: comments,
 *  <script>/<style>/<head>, and elements explicitly hidden via display:none / hidden / aria-hidden. */
export function stripNonRenderedHtml(html: string): string {
  if (typeof html !== "string" || !html) return ""
  return html
    .replace(/<!--[\s\S]*?-->/g, " ") // HTML comments
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ")
    // an element carrying display:none / hidden / aria-hidden — drop the whole element body
    .replace(/<([a-z][\w-]*)\b[^>]*(?:\bhidden\b|aria-hidden\s*=\s*["']?true|display\s*:\s*none)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/[ \t\f\v]{2,}/g, " ")
}

/**
 * Quarantine evidence BEFORE it reaches an LLM entailment oracle or critic.
 *  - local-source (the user's own files that the deterministic grep already ran over): passed through
 *    verbatim — grounding must compare against the real bytes, and the user's source is trusted.
 *  - fetched / untrusted-file: strip non-rendered HTML → threat-scan (strips invisible/bidi, flags
 *    injection markers) → wrap so its bytes are framed as data the oracle must not obey.
 * The wrapper defangs any attempt by the content to forge/close the boundary (see wrapUntrusted).
 */
export function quarantine(evidence: string, trust: EvidenceTrust, sourceLabel?: string): string {
  if (typeof evidence !== "string" || !evidence) return ""
  if (trust === "local-source") return evidence
  const stripped = stripNonRenderedHtml(evidence)
  const scan = scanThreats(stripped) // cleaned strips invisible/bidi even when no marker fired
  const banner = scan.injection ? threatBanner(scan.markers) : undefined
  return wrapUntrusted(scan.cleaned, sourceLabel ?? trust, banner)
}

/** True if this evidence must be quarantined before the oracle sees it. Local source is exempt. */
export function needsQuarantine(trust: EvidenceTrust): boolean {
  return trust !== "local-source"
}
