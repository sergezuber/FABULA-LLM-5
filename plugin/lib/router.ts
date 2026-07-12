// Local-default → cloud-ESCALATION router (local-first by design). GATED `FABULA_ROUTER=1`
// (default OFF): FABULA is local-first by design, so cloud escalation is strictly OPT-IN. v1 = cheap
// RULES (no ML): a step is "heavy" if it is broad/web research or carries an unusually long brief; heavy +
// router-on + a cloud provider actually configured → escalate to cloud, otherwise local. Env-tunable.

import type { Step } from "./graph"

export function routerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.FABULA_ROUTER === "1"
}

export function isHeavy(step: Step, env: Record<string, string | undefined> = process.env): boolean {
  const cap = Number(env.FABULA_ROUTER_HEAVY_CHARS || 400)
  return step.role === "research" || (step.description || "").length > cap
}

export function routeStep(step: Step, opts: { routerOn: boolean; cloudAvailable: boolean; env?: Record<string, string | undefined> }): "local" | "cloud" {
  if (!opts.routerOn || !opts.cloudAvailable) return "local"
  return isHeavy(step, opts.env || process.env) ? "cloud" : "local"
}
