// FABULA: Settings > Changes — the local changelog (patch notes per version, newest first).
import { createMemo, For } from "solid-js"
import { useLanguage } from "@/context/language"
import { CHANGELOG, FABULA_VERSION } from "@/data/fabula-changelog"

export const SettingsChangelog = () => {
  const language = useLanguage()
  const ru = createMemo(() => language.intl().toLowerCase().startsWith("ru"))

  return (
    <div class="flex flex-col gap-4 px-4 py-4">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-2xl font-semibold tracking-tight text-text-strong">
          {language.t("settings.changelog.title")}
        </h2>
        <span class="inline-flex h-6 items-center rounded-full border border-border-weak-base px-2 text-[11px] font-semibold text-text-weak">
          FABULA {FABULA_VERSION}
        </span>
      </div>
      <p class="text-[13px] leading-6 text-text-weak">{language.t("settings.changelog.description")}</p>

      <div class="flex flex-col gap-3">
        <For each={CHANGELOG}>
          {(entry) => (
            <div class="rounded-xl border border-border-weaker-base px-4 py-3 flex flex-col gap-2">
              <div class="flex items-baseline gap-2">
                <span class="text-14-medium text-text-strong">{entry.version}</span>
                <span class="text-[12px] text-text-weak">{entry.date}</span>
              </div>
              <ul class="flex flex-col gap-1.5">
                <For each={entry.items}>
                  {(item) => (
                    <li class="flex items-start gap-2 text-[13px] leading-5 text-text-base">
                      <span class="mt-[7px] size-1.5 shrink-0 rounded-full bg-icon-weak-base" />
                      <span class="min-w-0">{ru() ? item.ru : item.en}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
