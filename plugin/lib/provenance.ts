// Context OS Phase 3 — plugin-side reader of the engine's prefix-provenance channel.
// The engine (session/llm.ts) hashes the FINAL request prefix (system + wire tools) at the
// stream boundary and publishes per session into __FABULA_SESSION_PROVENANCE__; the router
// plugin keeps its decision in __FABULA_SESSION_BELT__. This module joins the two into the
// ReceiptProvenance stamped into Proof-of-Done receipts (metadata only — old receipts stay
// valid; the field never enters any content-addressed identity).

import type { ReceiptProvenance } from "./receipt"

const PROVENANCE_KEY = "__FABULA_SESSION_PROVENANCE__"
const BELT_KEY = "__FABULA_SESSION_BELT__"

type EngineEntry = {
  bundlePrefixHash: string
  systemHash: string
  toolsHash: string
  toolCount: number
  modelID: string
  engineVersion: string
  at: number
  step: number
  inputHash?: string
  midTurnBreaks?: number
}

type BeltEntry = { profileId: string; watermark?: string; hide?: readonly string[] }

function mapAt<T>(key: string): Map<string, T> | undefined {
  const g = globalThis as Record<string, unknown>
  return g[key] instanceof Map ? (g[key] as Map<string, T>) : undefined
}

/** The exact wire model id the engine published for this session (for descriptor lookups). */
export function engineModelIDFor(sessionID: string | undefined): string | undefined {
  if (!sessionID) return undefined
  const entry = mapAt<EngineEntry>(PROVENANCE_KEY)?.get(sessionID)
  return typeof entry?.modelID === "string" && entry.modelID ? entry.modelID : undefined
}

/** Join the engine's prefix digest with the router's decision for a session.
 *  Returns undefined when the engine never published (e.g. no request ran) — the
 *  receipt then simply omits the provenance block, exactly like a pre-Phase-3 receipt. */
export function contextProvenanceFor(sessionID: string | undefined): ReceiptProvenance | undefined {
  if (!sessionID) return undefined
  const entry = mapAt<EngineEntry>(PROVENANCE_KEY)?.get(sessionID)
  if (!entry || typeof entry.bundlePrefixHash !== "string") return undefined
  const belt = mapAt<BeltEntry>(BELT_KEY)?.get(sessionID)
  return {
    bundlePrefixHash: entry.bundlePrefixHash,
    systemHash: entry.systemHash,
    toolsHash: entry.toolsHash,
    toolCount: entry.toolCount,
    engineVersion: entry.engineVersion,
    step: entry.step,
    ...(typeof entry.inputHash === "string" ? { inputHash: entry.inputHash } : {}),
    ...(typeof entry.midTurnBreaks === "number" ? { midTurnBreaks: entry.midTurnBreaks } : {}),
    ...(belt?.profileId ? { routerProfile: belt.profileId } : {}),
    ...(belt?.watermark ? { routerWatermark: belt.watermark } : {}),
  }
}
