/**
 * Which of a provider's declared models may be offered, given what `/global/fabula/models-served`
 * said about that provider.
 *
 * Three answers, and the middle one is the whole point:
 *   · a LIST — the provider answered; offer exactly what it named.
 *   · an EMPTY list — the provider answered by refusing the connection on this machine's own
 *     loopback, i.e. it is not running; offer nothing of it.
 *   · null / absent — we could not ask; offer everything it declares (fail open, because a menu
 *     emptied by a network blip is no product).
 *
 * A file of its own, with no framework imports, for two reasons. It is a rule rather than a view,
 * and it must be askable WITHOUT starting the application — inline in the context it could only be
 * exercised through a router. And inline it rested on the empty array being TRUTHY in JavaScript:
 * an unstated subtlety that one defensive `ids?.length` would erase in silence, taking the whole
 * distinction with it. Here the three cases are spelled out and pinned by `models-served.test.ts`.
 */
export function servedModelFilter(ids: string[] | null | undefined): ((modelID: string) => boolean) | undefined {
  if (!Array.isArray(ids)) return undefined
  const set = new Set(ids)
  return (modelID) => set.has(modelID)
}

/**
 * What an empty model list should SAY.
 *
 * Before providers could be hidden, an empty list meant "your search matched nothing" and the plain
 * message was the whole truth. Now it can also mean "the runtime that has your models is not
 * running" — a different fact, with a different thing for the reader to do — so the message names
 * the provider. One definition, because three surfaces render this list and three copies of a
 * sentence drift apart.
 */
export function emptyModelsMessage(
  hiddenProviders: string[],
  t: (key: string, params?: Record<string, string>) => string,
): string {
  if (hiddenProviders.length === 0) return t("dialog.model.empty")
  return t("dialog.model.empty.notRunning", { provider: hiddenProviders.join(", ") })
}
