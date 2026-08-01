// Does this ask need the WEB? One definition, two consumers.
//
// WHY IT IS ONE DEFINITION. `fabula-context` already decides this deterministically on every turn, to
// append the freshness steer ("web_search first, answer with links") — a mechanism built because the
// model fabricated today's news from memory. The tool ROUTER has to answer the same question for a
// different reason: if the harness is about to order a web search, the belt must not have hidden
// `web_search`. Two modules answering one question in two places is this repository's most-repeated
// defect (the store-vs-gate origin, the panel-vs-gate enabled state, the two `visibleUserMessages`), and
// here the two copies would disagree in the worst possible way — steering the model toward a tool the
// same turn had just masked away.
//
// MEASURED 2026-08-01, which is what made the second consumer necessary. Profile selection was an argmax
// over BM25 sums, and the profiles are NESTED — coding keeps 50 of 74 cards, web-research 51 — so the
// shared 50 dominated and the handful of tools that actually distinguish them were noise on top.
// Explicit web asks routed to `coding`, which HIDES web_fetch/web_search/image_search: "search the web
// for the latest papers on prefix caching" scored coding 0.1913 against web-research 0.1895, 0.9% apart,
// and 29 of 29 live decisions came out `coding`.

/** Time-sensitive: the answer changes with the date, so memory is not a source. EN + RU. */
export const FRESHNESS_RE =
  /\b(today|todays|current|currently|latest|recent|recently|breaking|this week|right now|as of|news|headlines|who won|score|price of|stock|weather)\b|сегодня|сейчас|последн|свеж|новост|актуальн|на данный момент|за неделю|кто выиграл|курс|погода|цена/i

/** Explicitly asking to go OUT: browse, search the web, look something up online. EN + RU.
 *  Separate from freshness because "search the web for the RFC" is not time-sensitive and still needs
 *  the web tools visible. */
export const WEB_INTENT_RE =
  /\b(web[- ]?search|search (?:the )?(?:web|internet|online)|google|browse|browsing|surf|look (?:it |this |that )?up (?:on|online|in)?|online|on the internet|find .{0,30}\b(?:online|on the web)|url|website|web page|webpage|link to|give me links?|цитируй источник)\b|найди в интернете|поиск в интернете|в интернете|погугли|загугли|в сети|источник|ссылк/i

/** Should the web tools be VISIBLE for this ask? Never guesses from an empty string. */
export function needsWeb(text: unknown): boolean {
  const t = String(text ?? "")
  if (t.trim().length < 3) return false
  return WEB_INTENT_RE.test(t) || FRESHNESS_RE.test(t)
}
