// fabula-attest — claim typing (design C) + load-bearing binding (F) + decomposition reconcile (G).
// typeClaim assigns a claim's type from SURFACE FORM, deterministically and STICKILY: a hard type
// (citation/measurement/execution/process/world-state) wins over a soft one, so a fabrication cannot
// escape the deterministic check by being phrased as an "inference" (the review's BUG-3 hole). Pure.

import type { Claim, ClaimType, Contract } from "./types"

// Surface-form signals. Order in typeClaim is precedence: hard types first, soft last.
const RX = {
  quote: /[«"“„'']{1}[^«»"“”„'']{6,}[»"”'']{1}/u, // a substantial quoted span
  execution:
    /\b(tests?\s+(pass|passed|are\s+green)|passes\b|compiles?\b|builds?\s+(clean|ok)|exit\s+(code\s+)?0|returns?\s+2\d\d|\bno\s+regress)/i,
  // NB: JS \b is ASCII-only, so a leading \b never fires before a Cyrillic word — RU patterns must not
  // use it (search-anywhere .test is fine; the phrases are specific enough not to mis-fire mid-word).
  executionRu: /(тесты?\s+(проход|зелён|зелен)|компилирует|сборка\s+(ок|чист)|прошл[аио]\s+тест|без\s+регресс)/i,
  process:
    /\b(read|checked|reviewed|went\s+through|processed|opened)\s+(all|every|each|the\s+(whole|entire|full))\b|\ball\s+\d+\s+(files?|chapters?|records?|pages?)\b/i,
  processRu:
    /(прочит(ал|ан[ыо])|проверил|просмотрел|обработал)\s+(все|кажд|весь|всю|полност)|все\s+\d+\s+(файл|глав|запис|страниц)/i,
  // a number that is a QUANTITY: currency, percent, decimal, a number+unit (incl. money "per night" /
  // ms / km), OR a bare number sitting next to a quantity word (budget/total/cost/mean/rate/p95…). A bare
  // integer with NO quantity context (e.g. "Office 519", "chapter 9") is NOT a measurement (identifier).
  measurement:
    /(?:\$|€|£)\s?\d|\d+(?:\.\d+)?\s?%|\d+\.\d+|\b\d[\d.,]*\s+(?:files?|chapters?|records?|analysts?|years?|steps?|tests?|words?|lines?|per\s+\w+|dollars?|euros?|pounds?|nights?|days?|hours?|minutes?|seconds?|percent|лет|глав|файл(?:ов)?|запис|аналитик|шаг|строк|слов|ноч(?:ь|ей)|тыс|млн|gb|mb|kb|ms|мс|сек|км|кг)|(?:budget|total|cost|price|sum|amount|mean|median|average|rate|latency|p\d{2}|бюджет|итог|цена|стоимост|средн)[\s\S]{0,25}?\d/i,
  worldstate:
    /\b(exists?|is\s+(live|reachable|deployed|running|up|online)|was\s+(deployed|created|pushed|published)|is\s+located)\b/i,
  analogy: /\b(like|as\s+in|reminiscent\s+of|recalls|echoes|à\s+la|in\s+the\s+vein\s+of)\s+[A-ZА-Я]/,
  analogyRu: /(как\s+(у|в)|подобно|напоминает|в\s+духе|сродни)\s+["«A-ZА-Я]/,
  inference: /\b(therefore|thus|hence|consequently|it\s+follows|this\s+(indicates|suggests|shows|means|implies|proves))\b/i,
  inferenceRu: /(следовательно|таким\s+образом|отсюда|это\s+(указывает|означает|говорит|показывает|доказывает)|значит,)/i,
  judgment:
    /\b(beautiful|profound|masterful|brilliant|stunning|remarkable|the\s+(best|greatest|finest)|unlike\s+any(thing)?|no\s+(other|predecessor))\b/i,
  // stems stop before the fleeting vowel so short forms match too (великолепен, восхитителен, гениален)
  judgmentRu:
    /(прекрас|гениал|великолеп|потрясающ|восхитител|шедевр|лучш(ий|ая|ее|его)|не\s+делал\s+ни\s+один|как\s+никто)/i,
}

/** Assign a claim's type by SURFACE FORM, sticky (design C). Hard types (citation/measurement/execution/
 *  process/world-state) take precedence over soft (inference/analogy/judgment) so a claim carrying a
 *  quote/number/behavior signal cannot be downgraded to a soft, evadable type. */
export function typeClaim(text: string): ClaimType {
  const t = typeof text === "string" ? text : ""
  if (RX.quote.test(t)) return "citation"
  if (RX.execution.test(t) || RX.executionRu.test(t)) return "execution"
  if (RX.process.test(t) || RX.processRu.test(t)) return "process"
  if (RX.measurement.test(t)) return "measurement"
  if (RX.worldstate.test(t)) return "world-state"
  if (RX.analogy.test(t) || RX.analogyRu.test(t)) return "analogy"
  if (RX.inference.test(t) || RX.inferenceRu.test(t)) return "inference"
  if (RX.judgment.test(t) || RX.judgmentRu.test(t)) return "judgment"
  return "inference" // an unanchored assertion is soft (audit-replayable) — never a false hard confirm
}

const HARD: ReadonlySet<ClaimType> = new Set(["citation", "measurement", "execution", "process", "world-state"])

function salientTokens(s: string): Set<string> {
  return new Set((typeof s === "string" ? s.toLowerCase() : "").match(/[\p{L}\p{N}]{4,}/gu) || [])
}

/** Bind each claim to whether it is LOAD-BEARING (design F): it supports a contract-required conclusion.
 *  Bound post-hoc by lexical support (shares a salient token with a conclusion). With no conclusions
 *  declared, the hard-typed (checkable) claims are treated as load-bearing. This resolves the review's
 *  BUG-5 chicken/egg: contract conclusions come from Ход-1 (pre-deliverable); the binding is over the
 *  ACTUAL claims (post-hoc). */
export function bindLoadBearing(claims: Claim[], c: Contract | undefined): Claim[] {
  const conclTokens = (c?.conclusions || []).map(salientTokens).filter((s) => s.size > 0)
  return (claims || []).map((cl) => {
    const tok = salientTokens(cl.text)
    const supports = conclTokens.some((ct) => [...tok].some((x) => ct.has(x)))
    const loadBearing = conclTokens.length ? supports : HARD.has(cl.type)
    return { ...cl, loadBearing }
  })
}

function normText(s: string): string {
  return (typeof s === "string" ? s : "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

/** Merge two independent decompositions by UNION, deduped by normalized text (design G). A claim phrased
 *  differently in only one pass is KEPT — coverage of load-bearing claims is the gate's only safety axis,
 *  and intersection (the v2 design) would silently drop exactly those, degrading coverage at double cost. */
export function reconcileDecompositions(a: Claim[], b: Claim[]): Claim[] {
  const seen = new Map<string, Claim>()
  for (const cl of [...(a || []), ...(b || [])]) {
    const k = normText(cl?.text)
    if (k && !seen.has(k)) seen.set(k, cl)
  }
  return [...seen.values()]
}
