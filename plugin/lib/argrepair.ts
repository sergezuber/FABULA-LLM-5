// Tool-call argument repair (pure, unit-testable).
// The engine hands us ALREADY-PARSED args (an object), so JSON-text repair (trailing commas,
// truncation) is not applicable here — the engine's parser handled that. What we DO fix:
//   1. Strip keys not in a tool's strict whitelist (the `actor.timeout_ms` → unrecognized_keys bug).
//   2. Sanitize string values: drop lone UTF-16 surrogates that crash JSON re-encode / providers.
//
// NOTE: for NATIVE strict tools
// (actor/task) the engine validates the args against the tool's strict zod schema and returns an
// `unrecognized_keys` error to the model BEFORE `tool.execute.before` runs — so argrepair CANNOT
// repair a native-tool call (it never reaches us). It still runs for our OWN plugin tools. Two
// details matter here: (a) the real `actor`/`task` schema is NESTED — the only valid
// top-level key is `operation` (`{operation:{action, subagent_type, description, prompt}}`), NOT a
// flat `{description,prompt,subagent_type}`; the old flat whitelist would have STRIPPED the required
// `operation` had the hook ever run. We now whitelist `operation` (correct if it ever runs first,
// harmless no-op otherwise). (b) The real backstop for native tools is the addendum guidance + the
// model's own retry — not this strip.

// tool → allowed top-level keys. Only enforced for tools listed here; all others pass through.
export const STRICT_TOOL_KEYS: Record<string, string[]> = {
  actor: ["operation"],
  task: ["operation"],
}

/** Remove lone surrogates (unpaired \uD800-\uDFFF) which break JSON re-encode / many providers. */
export function sanitizeString(s: string): string {
  // Replace any surrogate code unit that isn't part of a valid pair with U+FFFD.
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
}

/** Deep-sanitize all string values in an args object (in place is avoided; returns a copy). */
export function sanitizeArgsDeep(v: any): any {
  if (typeof v === "string") return sanitizeString(v)
  if (Array.isArray(v)) return v.map(sanitizeArgsDeep)
  if (v && typeof v === "object") {
    const out: Record<string, any> = {}
    for (const k of Object.keys(v)) out[k] = sanitizeArgsDeep(v[k])
    return out
  }
  return v
}

export interface RepairResult {
  args: any
  /** keys that were stripped (for logging); empty if nothing changed structurally */
  stripped: string[]
  changed: boolean
}

/**
 * Repair a parsed args object for a given tool.
 * - strips non-whitelisted keys for STRICT tools
 * - sanitizes string values everywhere
 */
export function repairArgs(tool: string, args: any): RepairResult {
  const stripped: string[] = []
  let work = args
  const whitelist = STRICT_TOOL_KEYS[tool]
  if (whitelist && work && typeof work === "object" && !Array.isArray(work)) {
    const allow = new Set(whitelist)
    const next: Record<string, any> = {}
    for (const k of Object.keys(work)) {
      if (allow.has(k)) next[k] = work[k]
      else stripped.push(k)
    }
    work = next
  }
  const sanitized = sanitizeArgsDeep(work)
  // changed if we stripped keys or sanitization altered the serialized form
  let changed = stripped.length > 0
  if (!changed) {
    try { changed = JSON.stringify(sanitized) !== JSON.stringify(args) } catch { changed = true }
  }
  return { args: sanitized, stripped, changed }
}

/**
 * Normalize a mis-shaped actor/task call into the required `{ operation: {...} }` wrapper. Weak local
 * models often OMIT the wrapper (send action/prompt FLAT — a common local-model failure ("expected object at path operation,
 * received undefined" error), send `operation` as a JSON string, or otherwise mis-nest. The engine validates the
 * model's args against the tool's zod schema BEFORE `tool.execute.before` runs, so the ONLY way to RESCUE a
 * wrong-shape call (instead of erroring + forcing a retry) is to wrap the schema in
 * `z.preprocess(normalizeActorArgs, schema)` inside `tool.definition` — this runs during the engine's own
 * `parse()`, fixing the input so it validates. A correct nested call passes through untouched (idempotent).
 */
/**
 * Fields valid PER ACTION in the engine's REAL actor schema (actor.ts): each action is a `z.strictObject`, so ANY
 * extra key → `unrecognized_keys` rejection, and `operation` itself is REQUIRED (root strictObject). We keep
 * ONLY the safe simple fields per action (dropping enum/object fields `context`/`output_schema` and
 * `command`/`timeout_ms` that the model rarely sends and that risk strict enum/type rejection).
 */
const FIELDS_BY_ACTION: Record<string, readonly string[]> = {
  run: ["action", "subagent_type", "description", "prompt", "model", "actor_id", "task_id"],
  spawn: ["action", "subagent_type", "description", "prompt", "model", "actor_id", "task_id"],
  status: ["action", "actor_id"],
  wait: ["action", "actor_id", "timeout_ms"],
  cancel: ["action", "actor_id"],
  send: ["action", "to_actor_id", "content", "to_session_id", "type"],
}
const ALL_OP_FIELDS = Array.from(new Set(Object.values(FIELDS_BY_ACTION).flat()))

/** Coerce a value the model sent for a string field into a string (object→JSON, primitive→String). */
function toText(v: any): string {
  if (typeof v === "string") return v
  if (v && typeof v === "object") { try { return JSON.stringify(v) } catch { return String(v) } }
  return String(v)
}

/**
 * RECOVER a field's value from a GARBLED key. Weak models sometimes break tool-call formatting and emit
 * XML-style tool-call syntax INTO the JSON — e.g. a key literally named `prompt="Explore the repo…"\n</parameter`
 * (the prompt text is trapped inside the key name). Scan keys for `field = "<value>"` / `field=<value></parameter>`
 * and pull the value back out. Returns undefined if nothing matches.
 */
function recoverField(keys: string[], field: string): string | undefined {
  const head = new RegExp("^\\s*" + field + "\\s*=\\s*", "i")
  for (const k of keys) {
    if (typeof k !== "string" || !head.test(k)) continue
    let v = k.replace(head, "")
    v = v.replace(/<\/?\s*parameter[^>]*>?\s*$/i, "")  // strip trailing `</parameter>` leakage
    v = v.replace(/\s+$/g, "").replace(/^["'`]|["'`]$/g, "") // trim + strip one layer of surrounding quotes
    v = v.replace(/\\n/g, "\n").replace(/\\"/g, '"').trim()
    if (v.length > 0) return v
  }
  return undefined
}

export function normalizeActorArgs(raw: any): any {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {}
  // Collect operation-field values from EVERY place the model might stash them, in priority order.
  const merged: Record<string, any> = {}
  const take = (obj: any) => { if (obj && typeof obj === "object" && !Array.isArray(obj)) for (const k of ALL_OP_FIELDS) if (merged[k] == null && obj[k] != null) merged[k] = obj[k] }
  // (a) operation as a nested object  (b) operation as a JSON string  (c) flat fields at the top level
  if (raw.operation && typeof raw.operation === "object" && !Array.isArray(raw.operation)) take(raw.operation)
  else if (typeof raw.operation === "string") { try { take(JSON.parse(raw.operation)) } catch {} }
  take(raw)
  // (d) RECOVER prompt/description trapped inside a garbled key (XML tool-call leakage)
  const allKeys = Object.keys(raw).concat(raw.operation && typeof raw.operation === "object" ? Object.keys(raw.operation) : [])
  if (merged.prompt == null) { const p = recoverField(allKeys, "prompt"); if (p) merged.prompt = p }
  if (merged.description == null) { const d = recoverField(allKeys, "description"); if (d) merged.description = d }
  // Decide the action. Default "run" (the common delegation). If a management action lacks its required handle,
  // fall back to "run" so we ALWAYS emit a SCHEMA-VALID operation (never raw) — the engine validates with the ORIGINAL
  // strict discriminatedUnion at tool.ts (AFTER this hook), so the operation MUST be present and conform.
  let action = typeof merged.action === "string" && FIELDS_BY_ACTION[merged.action] ? merged.action : "run"
  if ((action === "status" || action === "wait" || action === "cancel") && merged.actor_id == null) action = "run"
  if (action === "send" && (merged.to_actor_id == null || merged.content == null)) action = "run"
  // Build the operation with ONLY the fields valid for THIS action (each action is a strictObject).
  const op: Record<string, any> = { action }
  for (const k of FIELDS_BY_ACTION[action]) if (k !== "action" && merged[k] != null) op[k] = merged[k]
  for (const k of ["description", "prompt", "task_id", "content"]) if (op[k] != null && typeof op[k] !== "string") op[k] = toText(op[k])
  for (const k of Object.keys(op)) if (typeof op[k] === "string") op[k] = sanitizeString(op[k]) // lone surrogates → U+FFFD
  if (typeof op.prompt === "string" && op.prompt.trim() === "") delete op.prompt
  if (action === "run" || action === "spawn") {
    // subagent_type is a DYNAMIC enum from the agent registry (actor.ts: z.enum(spawnableNames) — e.g.
    // explore/general/plan/build/compose). TRUST any non-empty string the model chose (it came from the enum it
    // was shown) — do NOT clobber a valid `plan`/`build` to `general`. Default only when missing/blank; `general`
    // is a confirmed registry member.
    if (typeof op.subagent_type !== "string" || op.subagent_type.trim() === "") op.subagent_type = "general"
    if (!op.description) op.description = "subtask"
    if (!op.prompt) op.prompt = op.description
  }
  return { operation: op } // ALWAYS a valid, strict-conforming { operation } — never raw
}
