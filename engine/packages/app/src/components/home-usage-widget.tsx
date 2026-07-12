// FABULA: the Home usage widget (reference-client style) — Overview|Models tabs, All/30d/7d ranges,
// stat cells, an activity heatmap and a fun token comparison. Data: /global/fabula/usage.
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { fabulaProjectDirs } from "@/pages/layout/sidebar-all-sessions"
import { useLanguage } from "@/context/language"

type Usage = {
  totalSessions: number
  totalMessages: number
  totalTokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  modelUsage: Record<string, { messages: number; tokens: { input: number; output: number } }>
  daily?: { date: string; count: number }[]
  currentStreak?: number
  longestStreak?: number
  peakHour?: number
  activeDays?: number
  userName?: string
}

const RANGES = [
  { id: "all", days: 0 },
  { id: "30d", days: 30 },
  { id: "7d", days: 7 },
] as const

// "War and Peace" ~ 800k tokens — the reference client compares your usage to a famous book.
const BOOK_TOKENS = 800_000

function formatBig(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function HomeUsageWidget() {
  // Scope stats to FABULA's own projects — the engine DB is shared with CLI runs and importers.

  const language = useLanguage()
  const [tab, setTab] = createSignal<"overview" | "models">("overview")
  const [range, setRange] = createSignal<(typeof RANGES)[number]["id"]>("all")
  const [usageRaw] = createResource(
    () => range(),
    async (id) => {
      const days = RANGES.find((r) => r.id === id)?.days ?? 0
      const dirs = fabulaProjectDirs()
      const qs = new URLSearchParams()
      if (days) qs.set("days", String(days))
      if (dirs.length) qs.set("dirs", JSON.stringify(dirs))
      const res = await fetch(`/global/fabula/usage${qs.size ? `?${qs}` : ""}`).catch(() => undefined)
      if (!res?.ok) return undefined
      return (await res.json()) as Usage
    },
  )
  // Keep the last loaded data while a range refetch is in flight — otherwise the whole widget
  // blanks out and the page visibly "blinks" on every toggle.
  const [cached, setCached] = createSignal<Usage | undefined>(undefined)
  createEffect(() => {
    const value = usageRaw()
    if (value) setCached(value)
  })
  const usage = cached
  const loading = () => usageRaw.loading

  const totalTokens = createMemo(() => {
    const t = usage()?.totalTokens
    if (!t) return 0
    return t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  })
  // Imported Claude-history sessions carry the anthropic/* provider, which FABULA itself never
  // runs — they must not win «favorite model» or populate the Models tab.
  const nativeModels = createMemo(() =>
    Object.entries(usage()?.modelUsage ?? {}).filter(([key]) => !key.startsWith("anthropic/")),
  )
  const favoriteModel = createMemo(() => {
    const top = nativeModels().sort((a, b) => b[1].messages - a[1].messages)[0]
    if (!top) return "—"
    return top[0].split("/").pop() ?? top[0]
  })
  const topModels = createMemo(() =>
    nativeModels()
      .sort((a, b) => b[1].messages - a[1].messages)
      .slice(0, 6),
  )
  const heatMax = createMemo(() => Math.max(1, ...(usage()?.daily ?? []).map((d) => d.count)))
  const heatColor = (count: number) => {
    if (!count) return "var(--surface-base)"
    const level = Math.min(1, count / heatMax())
    const pct = 25 + Math.round(level * 75)
    return `color-mix(in srgb, var(--text-interactive-base) ${pct}%, var(--surface-base))`
  }
  // Honest comparison: only claim "~N× War and Peace" once you're actually past a book's worth of
  // tokens (rounds to ≥1). Below that, don't fabricate a "~1×" minimum.
  const funTimes = createMemo(() => Math.round(totalTokens() / BOOK_TOKENS))

  const cell = (label: string, value: string | number) => (
    <div class="rounded-lg border border-border-weaker-base bg-surface-base/40 px-3 py-2 min-w-0">
      <div class="truncate text-[11px] text-text-weak">{label}</div>
      <div class="truncate text-16-medium text-text-strong">{value}</div>
    </div>
  )

  return (
    <div
      classList={{
        "w-full max-w-xl rounded-2xl border border-border-weaker-base p-4 flex flex-col gap-3 transition-opacity": true,
        "opacity-60": loading() && !!usage(),
      }}
    >
      <div class="flex items-center gap-2">
        <div class="flex items-center gap-1">
          <For each={["overview", "models"] as const}>
            {(id) => (
              <button
                type="button"
                classList={{
                  "h-6 rounded-md px-2 text-[12px] font-medium transition-colors cursor-pointer": true,
                  "bg-surface-base text-text-strong": tab() === id,
                  "text-text-weak hover:text-text-strong": tab() !== id,
                }}
                onClick={() => setTab(id)}
              >
                {language.t(`home.usage.${id}` as never)}
              </button>
            )}
          </For>
        </div>
        <div class="ml-auto flex items-center gap-1">
          <For each={RANGES}>
            {(r) => (
              <button
                type="button"
                classList={{
                  "h-6 rounded-md px-2 text-[12px] transition-colors cursor-pointer": true,
                  "bg-surface-base text-text-strong": range() === r.id,
                  "text-text-weak hover:text-text-strong": range() !== r.id,
                }}
                onClick={() => setRange(r.id)}
              >
                {language.t(`home.usage.range.${r.id}` as never)}
              </button>
            )}
          </For>
        </div>
      </div>

      <Show when={tab() === "overview"} fallback={
        <div class="flex flex-col gap-1.5">
          <For each={topModels()}>
            {([model, info]) => (
              <div class="flex items-center gap-2 rounded-lg border border-border-weaker-base px-3 py-2 min-w-0">
                <span class="min-w-0 flex-1 truncate text-[13px] text-text-strong">{model.split("/").pop()}</span>
                <span class="shrink-0 text-[12px] text-text-weak">
                  {formatBig(info.messages)} · {formatBig(info.tokens.input + info.tokens.output)} tok
                </span>
              </div>
            )}
          </For>
          <Show when={topModels().length === 0}>
            <div class="py-4 text-center text-[13px] text-text-weak">—</div>
          </Show>
        </div>
      }>
        <div class="grid grid-cols-4 gap-1.5">
          {cell(language.t("home.usage.sessions"), usage()?.totalSessions ?? "—")}
          {cell(language.t("home.usage.messages"), formatBig(usage()?.totalMessages ?? 0))}
          {cell(language.t("home.usage.tokens"), formatBig(totalTokens()))}
          {cell(language.t("home.usage.activeDays"), usage()?.activeDays ?? "—")}
          {cell(language.t("home.usage.currentStreak"), language.t("home.usage.daysShort", { count: usage()?.currentStreak ?? 0 }))}
          {cell(language.t("home.usage.longestStreak"), language.t("home.usage.daysShort", { count: usage()?.longestStreak ?? 0 }))}
          {cell(language.t("home.usage.peakHour"), `${usage()?.peakHour ?? 0}:00`)}
          {cell(language.t("home.usage.favoriteModel"), favoriteModel())}
        </div>

        <Show when={(usage()?.daily ?? []).length > 0}>
          <div class="grid grid-flow-col grid-rows-7 gap-[3px] w-fit">
            <For each={usage()?.daily ?? []}>
              {(day) => (
                <span
                  class="size-2.5 rounded-[3px]"
                  style={{ "background-color": heatColor(day.count) }}
                  title={`${day.date} — ${day.count}`}
                />
              )}
            </For>
          </div>
        </Show>

        <Show when={funTimes() >= 1}>
          <div class="text-[12px] text-text-weak">{language.t("home.usage.fun", { count: funTimes() })}</div>
        </Show>
      </Show>
    </div>
  )
}
