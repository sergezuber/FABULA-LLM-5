// FABULA: usage statistics page (reference-client «Usage» analogue). Reads the engine's local
// session-history aggregator via /global/fabula/usage. Read-only; ranges 7d / 30d / all.
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { fabulaProjectDirs } from "@/pages/layout/sidebar-all-sessions"
import { useLanguage } from "@/context/language"

type Stats = {
  totalSessions: number
  totalMessages: number
  totalTokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  toolUsage: Record<string, number>
  modelUsage: Record<string, { messages: number; tokens: { input: number; output: number } }>
  daily?: { date: string; count: number }[]
  byHour?: number[]
  currentStreak?: number
  longestStreak?: number
  peakHour?: number
  activeDays?: number
  verified?: {
    verifiedRuns: number
    failedVerifies: number
    notDoneVerdicts: number
    autoRewinds: number
    receiptsMinted: number
    secondOpinions: number
  }
}

const fmt = (n: number) => new Intl.NumberFormat().format(Math.round(n || 0))

export const SettingsUsage = () => {
  const language = useLanguage()

  const [range, setRange] = createSignal<7 | 30 | 0>(30)
  const [statsRaw] = createResource(range, async (days) => {
    const qs = new URLSearchParams()
    if (days > 0) qs.set("days", String(days))
    const dirs = fabulaProjectDirs()
    if (dirs.length) qs.set("dirs", JSON.stringify(dirs))
    const res = await fetch(`/global/fabula/usage${qs.size ? `?${qs}` : ""}`).catch(() => undefined)
    if (!res?.ok) return undefined
    return (await res.json()) as Stats
  })
  // Cache-through-signal: range switches must dim, not blank (app-wide anti-flicker pattern).
  const [stats, setStats] = createSignal<Stats | undefined>(undefined)
  createEffect(() => {
    const next = statsRaw()
    if (next) setStats(next)
  })
  const loading = () => statsRaw.loading

  const cards = createMemo(() => {
    const s = stats()
    if (!s) return []
    return [
      { label: language.t("settings.usage.sessions"), value: fmt(s.totalSessions) },
      { label: language.t("settings.usage.messages"), value: fmt(s.totalMessages) },
      { label: language.t("settings.usage.tokensIn"), value: fmt(s.totalTokens?.input ?? 0) },
      { label: language.t("settings.usage.tokensOut"), value: fmt(s.totalTokens?.output ?? 0) },
      { label: language.t("settings.usage.cacheRead"), value: fmt(s.totalTokens?.cache?.read ?? 0) },
      {
        label: language.t("settings.usage.toolCalls"),
        value: fmt(Object.values(s.toolUsage ?? {}).reduce((a, b) => a + b, 0)),
      },
    ]
  })
  const streakCards = createMemo(() => {
    const s = stats()
    if (!s) return []
    return [
      { label: language.t("home.usage.activeDays"), value: String(s.activeDays ?? 0) },
      { label: language.t("home.usage.currentStreak"), value: language.t("home.usage.daysShort", { count: s.currentStreak ?? 0 }) },
      { label: language.t("home.usage.longestStreak"), value: language.t("home.usage.daysShort", { count: s.longestStreak ?? 0 }) },
      { label: language.t("home.usage.peakHour"), value: `${s.peakHour ?? 0}:00` },
    ]
  })
  // Verified-Autonomy telemetry: numbers from the checks themselves (verify_done parts), not claims.
  const verifiedCards = createMemo(() => {
    const v = stats()?.verified
    if (!v) return []
    return [
      { label: language.t("settings.usage.verifiedRuns"), value: fmt(v.verifiedRuns), green: v.verifiedRuns > 0 },
      { label: language.t("settings.usage.notDone"), value: fmt(v.notDoneVerdicts), green: false },
      { label: language.t("settings.usage.autoRewinds"), value: fmt(v.autoRewinds), green: false },
      { label: language.t("settings.usage.receipts"), value: fmt(v.receiptsMinted), green: v.receiptsMinted > 0 },
      { label: language.t("settings.usage.secondOpinions"), value: fmt(v.secondOpinions), green: false },
      { label: language.t("settings.usage.failedVerifies"), value: fmt(v.failedVerifies), green: false },
    ]
  })
  const heatMax = createMemo(() => Math.max(1, ...(stats()?.daily ?? []).map((d) => d.count)))
  const heatColor = (count: number) => {
    if (!count) return "var(--surface-base)"
    const pct = 25 + Math.round(Math.min(1, count / heatMax()) * 75)
    return `color-mix(in srgb, var(--text-interactive-base) ${pct}%, var(--surface-base))`
  }
  const hourMax = createMemo(() => Math.max(1, ...(stats()?.byHour ?? []).map((n) => n || 0)))
  const topTools = createMemo(() =>
    Object.entries(stats()?.toolUsage ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
  )
  const models = createMemo(() =>
    Object.entries(stats()?.modelUsage ?? {}).sort((a, b) => (b[1].messages ?? 0) - (a[1].messages ?? 0)),
  )

  return (
    <div class="flex flex-col gap-4 px-4 py-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-2xl font-semibold tracking-tight text-text-strong">{language.t("settings.usage.title")}</h2>
        <div class="flex h-7 w-fit items-center rounded-full bg-surface-base p-0.5">
          <For each={[{ id: 7 as const, k: "settings.usage.range.7" }, { id: 30 as const, k: "settings.usage.range.30" }, { id: 0 as const, k: "settings.usage.range.all" }]}>
            {(r) => (
              <button
                type="button"
                class="h-6 rounded-full px-2.5 text-[12px] font-medium leading-none transition-colors cursor-pointer"
                classList={{
                  "bg-background-base text-text-strong": range() === r.id,
                  "text-text-weak hover:text-text-strong": range() !== r.id,
                }}
                onClick={() => setRange(r.id)}
              >
                {language.t(r.k as never)}
              </button>
            )}
          </For>
        </div>
      </div>
      <p class="text-[13px] leading-6 text-text-weak">{language.t("settings.usage.subtitle")}</p>

      <Show
        when={stats()}
        fallback={<div class="py-8 text-center text-[13px] text-text-weak">{language.t("common.loading")}</div>}
      >
        <div classList={{ "flex flex-col gap-4 transition-opacity": true, "opacity-60": loading() }}>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
          <For each={cards()}>
            {(card) => (
              <div class="rounded-xl border border-border-weaker-base bg-surface-base px-3 py-3">
                <div class="text-[11px] text-text-weak">{card.label}</div>
                <div class="text-xl font-semibold text-text-strong tabular-nums">{card.value}</div>
              </div>
            )}
          </For>
        </div>

        <Show when={verifiedCards().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-[12px] font-medium uppercase tracking-wide text-text-weak" data-component="usage-verified-title">
              {language.t("settings.usage.verifiedTitle")}
            </div>
            <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
              <For each={verifiedCards()}>
                {(card) => (
                  <div class="rounded-xl border border-border-weaker-base bg-surface-base px-3 py-3">
                    <div class="text-[11px] text-text-weak">{card.label}</div>
                    <div
                      classList={{
                        "text-xl font-semibold tabular-nums": true,
                        "text-text-on-success-base": card.green,
                        "text-text-strong": !card.green,
                      }}
                    >
                      {card.value}
                    </div>
                  </div>
                )}
              </For>
            </div>
            <p class="text-[12px] leading-5 text-text-weaker">{language.t("settings.usage.verifiedSubtitle")}</p>
          </div>
        </Show>

        <Show when={streakCards().length > 0}>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
            <For each={streakCards()}>
              {(card) => (
                <div class="rounded-xl border border-border-weaker-base bg-surface-base px-3 py-3">
                  <div class="text-[11px] text-text-weak">{card.label}</div>
                  <div class="text-xl font-semibold text-text-strong tabular-nums">{card.value}</div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={(stats()?.daily ?? []).length > 0}>
          <div class="flex flex-col gap-1">
            <div class="text-14-medium text-text-strong">{language.t("settings.usage.activity")}</div>
            <div class="rounded-xl border border-border-weaker-base bg-surface-base/40 px-3 py-3 overflow-x-auto">
              <div class="grid grid-flow-col grid-rows-7 gap-[3px] w-fit">
                <For each={stats()?.daily ?? []}>
                  {(day) => (
                    <span
                      class="size-2.5 rounded-[3px]"
                      style={{ "background-color": heatColor(day.count) }}
                      title={`${day.date} — ${day.count}`}
                    />
                  )}
                </For>
              </div>
            </div>
          </div>
        </Show>

        <Show when={(stats()?.byHour ?? []).some((n) => n > 0)}>
          <div class="flex flex-col gap-1">
            <div class="text-14-medium text-text-strong">{language.t("settings.usage.byHour")}</div>
            <div class="rounded-xl border border-border-weaker-base bg-surface-base/40 px-3 pt-3 pb-1">
              <div class="flex items-end gap-[3px] h-20">
                <For each={stats()?.byHour ?? []}>
                  {(count, hour) => (
                    <div
                      class="flex-1 rounded-t-[3px] bg-text-interactive-base/70 min-h-[2px]"
                      style={{ height: `${Math.round(((count || 0) / hourMax()) * 100)}%` }}
                      title={`${hour()}:00 — ${fmt(count || 0)}`}
                    />
                  )}
                </For>
              </div>
              <div class="flex justify-between pt-1 text-[10px] text-text-weak">
                <span>0:00</span>
                <span>12:00</span>
                <span>23:00</span>
              </div>
            </div>
          </div>
        </Show>

        <Show when={topTools().length > 0}>
          <div class="flex flex-col gap-1">
            <div class="text-14-medium text-text-strong">{language.t("settings.usage.topTools")}</div>
            <div class="flex flex-col overflow-hidden rounded-xl border border-border-weaker-base">
              <For each={topTools()}>
                {([tool, count]) => (
                  <div class="flex items-center justify-between border-b border-border-weaker-base px-3 py-2 last:border-b-0">
                    <span class="text-[13px] text-text-strong font-mono truncate">{tool}</span>
                    <span class="text-[13px] text-text-weak tabular-nums">{fmt(count)}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={models().length > 0}>
          <div class="flex flex-col gap-1">
            <div class="text-14-medium text-text-strong">{language.t("settings.usage.byModel")}</div>
            <div class="flex flex-col overflow-hidden rounded-xl border border-border-weaker-base">
              <For each={models()}>
                {([model, usage]) => (
                  <div class="flex items-center justify-between border-b border-border-weaker-base px-3 py-2 last:border-b-0">
                    <span class="text-[13px] text-text-strong truncate">{model}</span>
                    <span class="text-[13px] text-text-weak tabular-nums ml-2 shrink-0">
                      {fmt(usage.messages)} · {fmt((usage.tokens?.input ?? 0) + (usage.tokens?.output ?? 0))} tok
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
        </div>
      </Show>
    </div>
  )
}
