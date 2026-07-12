// FABULA: Settings > Permissions — the access mode (same store the composer menu writes) plus the
// persisted command allow-list the security plugin's guards skip. Backed by /global/fabula/pmode.
import { createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@mimo-ai/ui/button"
import { Icon } from "@mimo-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { PMODES, type Pmode } from "@/components/pmode-menu"

export const SettingsPermissions = () => {
  const language = useLanguage()
  const [data, { refetch, mutate }] = createResource(async () => {
    const res = await fetch("/global/fabula/pmode").catch(() => undefined)
    if (!res?.ok) return undefined
    return (await res.json()) as { mode: Pmode; allow: string[] }
  })
  const [draft, setDraft] = createSignal("")

  const post = async (body: Record<string, unknown>) => {
    await fetch("/global/fabula/pmode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined)
    void refetch()
  }

  return (
    <div class="flex flex-col gap-4 px-4 py-4">
      <h2 class="text-2xl font-semibold tracking-tight text-text-strong">
        {language.t("settings.permissions.title")}
      </h2>
      <p class="text-[13px] leading-6 text-text-weak">{language.t("settings.permissions.subtitle")}</p>

      <div class="flex flex-col overflow-hidden rounded-xl border border-border-weaker-base">
        <For each={PMODES}>
          {(m) => (
            <button
              type="button"
              class="flex items-start gap-3 border-b border-border-weaker-base px-3 py-3 text-left last:border-b-0 transition-colors hover:bg-surface-raised-base-hover cursor-pointer"
              onClick={() => {
                mutate((cur) => (cur ? { ...cur, mode: m.id } : cur))
                void post({ mode: m.id })
              }}
            >
              <Icon name={m.icon} size="small" class="mt-0.5 shrink-0 text-icon-base" />
              <div class="min-w-0 flex-1">
                <div class="text-[13px] text-text-strong">{language.t(`home.pmode.${m.id}.title` as never)}</div>
                <div class="text-[12px] text-text-weak">{language.t(`home.pmode.${m.id}.desc` as never)}</div>
              </div>
              <Show when={(data.latest?.mode ?? "default") === m.id}>
                <Icon name="check-small" size="small" class="mt-0.5 shrink-0 text-icon-base" />
              </Show>
            </button>
          )}
        </For>
      </div>

      <div class="mt-2 flex flex-col gap-2">
        <div class="text-14-medium text-text-strong">{language.t("settings.permissions.allowTitle")}</div>
        <p class="text-[12px] leading-5 text-text-weak">{language.t("settings.permissions.allowSubtitle")}</p>
        <div class="flex items-center gap-2">
          <input
            type="text"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !draft().trim()) return
              void post({ allowAdd: draft().trim() })
              setDraft("")
            }}
            placeholder={language.t("settings.permissions.allowPlaceholder")}
            spellcheck={false}
            class="h-8 min-w-0 flex-1 rounded-lg border border-border-weak-base bg-background-base px-2 font-mono text-[12px] text-text-strong outline-none focus:border-text-interactive-base"
          />
          <Button
            size="normal"
            disabled={!draft().trim()}
            onClick={() => {
              void post({ allowAdd: draft().trim() })
              setDraft("")
            }}
          >
            {language.t("settings.registry.create")}
          </Button>
        </div>
        <div class="flex flex-col overflow-hidden rounded-xl border border-border-weaker-base">
          <Show
            when={(data.latest?.allow ?? []).length > 0}
            fallback={
              <div class="py-6 text-center text-[13px] text-text-weak">
                {language.t("settings.permissions.allowEmpty")}
              </div>
            }
          >
            <For each={data.latest?.allow ?? []}>
              {(rule) => (
                <div class="group flex items-center gap-3 border-b border-border-weaker-base px-3 py-2 last:border-b-0 transition-colors hover:bg-surface-raised-base-hover">
                  <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-text-strong">{rule}</span>
                  <Button
                    size="small"
                    variant="ghost"
                    class="shrink-0 text-text-danger-base opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => void post({ allowRemove: rule })}
                  >
                    {language.t("settings.registry.delete")}
                  </Button>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  )
}
