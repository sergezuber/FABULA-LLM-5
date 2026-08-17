// ONE definition of "this call is HARNESS META-WORK — do not spend a reasoning pass on it".
//
// MEASURED 2026-08-16 from the serving runtime's OWN per-request accounting, 1 136 requests of a
// real agent workload. In the best configuration measured, the harness's own aux generations were
// 46% of the wall clock and 54% of every token produced — MORE than the agent's actual work:
//
//   caller                        thinking ON              thinking OFF          n
//   change_quiz author            1 172 tok / 49.5s        144 tok /  9.1s       76
//   change_quiz grader              802 tok / 27.0s         89 tok /  6.1s      100
//   goal judge                      552 tok / 20.0s        151 tok /  9.4s       74
//
// Both arms are present in that log (the operator ran one window with thinking globally off), so
// this is a comparison of the SAME prompts on the SAME machine, not an extrapolation. Per task the
// three calls cost ~72s of pure decode, and decode was 75% of the run — on the one task where no
// quiz fired the 27B beat the incumbent model outright (98s vs 108s).
//
// THE SCOPE IS THE WHOLE POINT, and the same log is what draws the line. The window where thinking
// was turned off GLOBALLY produced 403/598/454/900s against 276/381/321/306s with it on: without a
// reasoning pass the agent needs more steps and loses far more time than the tokens save
// (independently: ThinKV arXiv:2510.01290 tab. 13, code solve-rate 55.6% -> 21.8%). So reasoning
// stays ON for the agent's own work and goes off ONLY for meta-work whose answer is short and
// structured — write three questions about a diff, grade three answers, say whether a stopping
// condition holds. Nothing here decides for a caller; a caller declares what kind of call it is.
//
// WHY A HEADER AND NOT A BODY FIELD. Every FABULA caller reaches the model through the :1235
// adapter, which already owns a declarative model -> level -> body-patch table
// (`proxy/reasoning-map.json`, selected by exactly this header). Naming the LEVEL keeps the
// per-runtime dialect in that one config file instead of spreading `enable_thinking` /
// `chat_template_kwargs` / `reasoning_effort` spellings across the plugins — and an unknown header
// is ignored by every HTTP server, so a caller that bypasses the adapter degrades to today's
// behaviour rather than to a 400. Fail-open in every direction (RULE #14: any model in the socket).

/** The adapter's per-request reasoning-level header (`proxy/lmstudio-adapter.py::resolve_level`). */
export const REASONING_HEADER = "X-Fabula-Reasoning"

/** Level asking the socketed runtime for no reasoning pass at all. */
export const REASONING_OFF = "off"

/**
 * The level a HARNESS META call should ask for, or `undefined` to leave the request untouched.
 * `FABULA_AUX_NO_REASONING=0` restores the pre-2026-08-16 behaviour byte-for-byte — the switch is
 * read at CALL time so it can be flipped without a restart.
 */
export function metaReasoningLevel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["FABULA_AUX_NO_REASONING"] === "0" ? undefined : REASONING_OFF
}

/** Header map for a level; empty when there is no level to declare (never sends an empty header). */
export function reasoningHeaders(level?: string | null): Record<string, string> {
  const v = typeof level === "string" ? level.trim() : ""
  return v ? { [REASONING_HEADER]: v } : {}
}
