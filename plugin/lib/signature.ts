// Canonical tool-call signature for loop detection (the circuit-breaker uses this).
// Stable across key order; bounded length. Pure, no deps.
//
// canonicalArgs produces canonical tool args (equivalent to json.dumps sort_keys=True):
// recursively sort object keys so {a:1,b:2} and {b:2,a:1} produce the SAME string.
// Arrays keep order (order is semantically meaningful). Cycles/uns­erializable → fallback.
export function canonicalArgs(args: any): string {
  try {
    const s = JSON.stringify(sortDeep(args))
    return s === undefined ? "" : s   // JSON.stringify(undefined) === undefined
  } catch {
    try { const s = JSON.stringify(args); return s === undefined ? "" : s } catch { return String(args) }
  }
}

// Recursively rebuild objects with sorted keys. Pure; no mutation of the input.
function sortDeep(o: any): any {
  if (Array.isArray(o)) return o.map(sortDeep)
  if (o && typeof o === "object") {
    const out: Record<string, any> = {}
    for (const k of Object.keys(o).sort()) out[k] = sortDeep(o[k])
    return out
  }
  return o
}

export function toolSignature(tool: string, args: any): string {
  const c = canonicalArgs(args)
  return tool + "::" + (c.length > 2000 ? c.slice(0, 2000) : c)
}

// djb2 hash for compact result-identity (no-progress detection).
export function hashResult(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
