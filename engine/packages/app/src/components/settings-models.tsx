import { useFilteredList } from "@mimo-ai/ui/hooks"
import { ProviderIcon } from "@mimo-ai/ui/provider-icon"
import { Switch } from "@mimo-ai/ui/switch"
import { Icon } from "@mimo-ai/ui/icon"
import { IconButton } from "@mimo-ai/ui/icon-button"
import { TextField } from "@mimo-ai/ui/text-field"
import { Button } from "@mimo-ai/ui/button"
import { Dialog } from "@mimo-ai/ui/dialog"
import { useDialog } from "@mimo-ai/ui/context/dialog"
import { showToast } from "@mimo-ai/ui/toast"
import { createResource, createSignal, type Component, For, Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { popularProviders } from "@/hooks/use-providers"
import { SettingsList } from "./settings-list"

// Per-model metadata editor for launch-config providers: display name + context/output limits
// (both or neither — the engine refuses partial limits). Writes via /global/fabula/providers-config.
const EditModelDialog = (props: {
  providerID: string
  modelID?: string
  initialName?: string
  initialLimit?: { context?: number; output?: number }
  onSaved: () => void
}): JSX.Element => {
  const dialog = useDialog()
  const language = useLanguage()
  const [id, setId] = createSignal(props.modelID ?? "")
  const [name, setName] = createSignal(props.initialName ?? "")
  const [ctx, setCtx] = createSignal(props.initialLimit?.context ? String(props.initialLimit.context) : "")
  const [out, setOut] = createSignal(props.initialLimit?.output ? String(props.initialLimit.output) : "")
  const [busy, setBusy] = createSignal(false)
  const [err, setErr] = createSignal("")
  const save = async () => {
    const modelID = id().trim()
    if (!modelID) return setErr(language.t("provider.custom.error.required"))
    const c = ctx().trim()
    const o = out().trim()
    if (!!c !== !!o) return setErr(language.t("settings.models.edit.limitBoth"))
    const limit = c && o ? { context: Number(c), output: Number(o) } : undefined
    if (limit && (!Number.isFinite(limit.context) || !Number.isFinite(limit.output)))
      return setErr(language.t("settings.models.edit.limitNumber"))
    setBusy(true)
    const res = await fetch("/global/fabula/providers-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerID: props.providerID,
        modelPatch: { id: modelID, name: name().trim() || modelID, ...(limit ? { limit } : {}) },
      }),
    }).catch(() => undefined)
    const data = (await res?.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    setBusy(false)
    if (!data?.ok) return setErr(data?.error ?? language.t("common.requestFailed"))
    dialog.close()
    props.onSaved()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("settings.models.edit.saved"),
      description: language.t("settings.registry.restartHint"),
    })
  }
  return (
    <Dialog size="normal" transition>
      <div class="flex flex-col gap-4 p-5">
        <h3 class="text-16-medium text-text-strong">
          {props.modelID ? language.t("settings.models.edit.title") : language.t("settings.models.add.title")}
        </h3>
        <TextField
          label="ID"
          value={id()}
          disabled={!!props.modelID}
          onChange={setId}
          placeholder="model-id"
        />
        <TextField label={language.t("provider.custom.field.name.label")} value={name()} onChange={setName} />
        <div class="grid grid-cols-2 gap-3">
          <TextField
            label={language.t("settings.models.edit.context")}
            value={ctx()}
            onChange={setCtx}
            placeholder="131072"
          />
          <TextField
            label={language.t("settings.models.edit.output")}
            value={out()}
            onChange={setOut}
            placeholder="16384"
          />
        </div>
        <Show when={err()}>
          <p class="text-[13px] text-text-danger-base">{err()}</p>
        </Show>
        <div class="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("settings.registry.cancel")}
          </Button>
          <Button disabled={busy()} onClick={() => void save()}>
            {language.t("settings.registry.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

const ListLoadingState: Component<{ label: string }> = (props) => {
  return (
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <span class="text-14-regular text-text-weak">{props.label}</span>
    </div>
  )
}

const ListEmptyState: Component<{ message: string; filter: string }> = (props) => {
  return (
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <span class="text-14-regular text-text-weak">{props.message}</span>
      <Show when={props.filter}>
        <span class="text-14-regular text-text-strong mt-1">&quot;{props.filter}&quot;</span>
      </Show>
    </div>
  )
}

export const SettingsModels: Component = () => {
  const language = useLanguage()
  const models = useModels()
  const dialog = useDialog()
  type LaunchProvider = { name?: string; baseURL?: string; models: Record<string, { name?: string; limit?: { context?: number; output?: number } }> }
  const [launchProviders, { refetch: refetchLaunch }] = createResource(async () => {
    const res = await fetch("/global/fabula/providers-config").catch(() => undefined)
    if (!res?.ok) return {} as Record<string, LaunchProvider>
    const data = (await res.json().catch(() => ({}))) as { providers?: Record<string, LaunchProvider> }
    return data.providers ?? {}
  })
  const launchModel = (providerID: string, modelID: string) => launchProviders()?.[providerID]?.models?.[modelID]
  const openEditModel = (providerID: string, modelID?: string) => {
    const meta = modelID ? launchModel(providerID, modelID) : undefined
    dialog.show(() => (
      <EditModelDialog
        providerID={providerID}
        modelID={modelID}
        initialName={meta?.name}
        initialLimit={meta?.limit}
        onSaved={() => void refetchLaunch()}
      />
    ))
  }
  const fmtK = (n?: number) => (n && n >= 1024 ? `${Math.round(n / 1024)}K` : n ? String(n) : "")

  const list = useFilteredList<ModelItem>({
    items: (_filter) => models.list(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0

      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      if (aPopular && bPopular) return aIndex - bIndex

      const aName = a.items[0].provider.name
      const bName = b.items[0].provider.name
      return aName.localeCompare(bName)
    },
  })

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.models.title")}</h2>
          <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
            <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
            <TextField
              variant="ghost"
              type="text"
              value={list.filter()}
              onChange={list.onInput}
              placeholder={language.t("dialog.model.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="flex-1"
            />
            <Show when={list.filter()}>
              <IconButton icon="circle-x" variant="ghost" onClick={list.clear} />
            </Show>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <Show
          when={!(list.grouped.loading && list.flat().length === 0)}
          fallback={
            <ListLoadingState label={`${language.t("common.loading")}${language.t("common.loading.ellipsis")}`} />
          }
        >
          <Show
            when={list.flat().length > 0}
            fallback={<ListEmptyState message={language.t("dialog.model.empty")} filter={list.filter()} />}
          >
            <For each={list.grouped.latest}>
              {(group) => (
                <div class="flex flex-col gap-1">
                  <div class="flex items-center gap-2 pb-2">
                    <ProviderIcon id={group.category} class="size-5 shrink-0 icon-strong-base" />
                    <span class="text-14-medium text-text-strong">{group.items[0].provider.name}</span>
                    <Show when={launchProviders.latest?.[group.category]}>
                      <Button
                        size="small"
                        variant="ghost"
                        class="ml-auto"
                        onClick={() => openEditModel(group.category)}
                      >
                        {language.t("settings.models.add.action")}
                      </Button>
                    </Show>
                  </div>
                  <SettingsList>
                    <For each={group.items}>
                      {(item) => {
                        const key = { providerID: item.provider.id, modelID: item.id }
                        return (
                          <div class="group flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
                            <div class="min-w-0">
                              <span class="text-14-regular text-text-strong truncate block">{item.name}</span>
                              {(() => {
                                const limit = (item as { limit?: { context?: number; output?: number } }).limit
                                const parts = [
                                  item.id,
                                  limit?.context ? `${language.t("settings.models.meta.context")} ${fmtK(limit.context)}` : "",
                                  limit?.output ? `${language.t("settings.models.meta.output")} ${fmtK(limit.output)}` : "",
                                ].filter(Boolean)
                                return <span class="text-[11px] text-text-weak truncate block">{parts.join(" · ")}</span>
                              })()}
                            </div>
                            <div class="flex flex-shrink-0 items-center gap-2">
                              <Show when={launchModel(item.provider.id, item.id)}>
                                <Button
                                  size="small"
                                  variant="ghost"
                                  class="opacity-0 transition-opacity group-hover:opacity-100"
                                  onClick={() => openEditModel(item.provider.id, item.id)}
                                >
                                  {language.t("settings.registry.edit")}
                                </Button>
                              </Show>
                              <Switch
                                checked={models.visible(key)}
                                onChange={(checked) => {
                                  models.setVisibility(key, checked)
                                }}
                                hideLabel
                              >
                                {item.name}
                              </Switch>
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </SettingsList>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}
