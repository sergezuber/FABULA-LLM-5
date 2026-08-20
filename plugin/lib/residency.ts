// ONE MODEL RESIDENT AT A TIME. Not a preference — a hard rule, because the alternative was measured:
// switching the session from one model to another while the first was still held produced
//   "Cannot load kat-coder-v2.5-dev-optiq: projected memory 44.97GB would exceed the metal_cap memory
//    ceiling 37.44GB (current: 23.52GB, model: 21.45GB)"
// and the turn simply failed. The serving runtime advertises LRU memory management, but its memory guard
// refuses BEFORE the pool evicts, so nothing on that side will ever make room. The harness must.
//
// The rule is model- and runtime-agnostic (RULE #14): whatever is in the socket, the model a request
// needs becomes the ONLY resident one, and the eviction happens BEFORE the request goes out — never as a
// reaction to a failure the reader has already seen.
//
// State is OURS, not inferred: the id we last sent to a runtime is recorded, because no public endpoint
// reports which model is actually held (the runtime's health says how many, never which). An unknown
// past is treated as a DIFFERENT model — evicting once costs a reload, believing wrongly costs the turn.

export interface ResidencyState {
  /** the model id this harness last dispatched to the runtime, if it knows */
  lastServed?: string
  /** how many models the runtime reports holding right now */
  residentCount: number
  /** the model this request needs */
  target: string
}

export interface ResidencyDecision {
  evict: boolean
  reason: string
}

export function residencyDecision(s: ResidencyState): ResidencyDecision {
  if (!s.target) return { evict: false, reason: "no target model named — nothing to make room for" }
  if (s.residentCount <= 0) return { evict: false, reason: "the runtime holds nothing" }
  if (s.lastServed === s.target)
    return { evict: false, reason: `already serving ${s.target} — evicting would drop a warm model` }
  if (s.lastServed === undefined)
    return {
      evict: true,
      reason: `the runtime holds ${s.residentCount} model(s) and this process does not know which — treating it as another model`,
    }
  return { evict: true, reason: `switching from ${s.lastServed} to ${s.target} — the old one must go first` }
}

/** Where the record lives. Honours the engine's own data root so it moves with everything else. */
export function residencyFile(env: NodeJS.ProcessEnv = process.env, runtime = "dflash"): string {
  const home = env.MIMOCODE_HOME
  const base =
    home && home.startsWith("/")
      ? home
      : `${env.XDG_DATA_HOME || `${env.HOME}/.local/share`}/fabula`
  return `${base}/residency-${runtime}.json`
}

export function parseServed(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const v = JSON.parse(raw)
    const id = typeof v?.lastServed === "string" ? v.lastServed.trim() : ""
    return id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}
