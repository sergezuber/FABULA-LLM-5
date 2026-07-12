// FABULA: ZCode-style Plugins settings page — title + Beta chip, Installed/Discover segmented
// control, search, and plugin cards with real enable/disable toggles. Backed by the engine's
// /fabula/plugins routes (fabula-state.json convention); toggles apply on the next engine start.
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Icon } from "@mimo-ai/ui/icon"
import { Switch as UiSwitch } from "@mimo-ai/ui/switch"
import { Button } from "@mimo-ai/ui/button"
import { useDialog } from "@mimo-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"

type PluginRow = { id: string; file: string; enabled: boolean }

async function fetchPlugins(): Promise<{ plugins: PluginRow[]; root: string } | undefined> {
  const res = await fetch("/global/fabula/plugins").catch(() => undefined)
  if (!res?.ok) return undefined
  const body = (await res.json()) as { plugins?: PluginRow[]; root?: string }
  return { plugins: body.plugins ?? [], root: body.root ?? "" }
}

// Native bridge (present only inside the WKWebView app) — same handler the file tree uses.
const fileBridge = () =>
  (window as unknown as { webkit?: { messageHandlers?: { fabulaFile?: { postMessage(v: unknown): void } } } }).webkit
    ?.messageHandlers?.fabulaFile

export const SettingsPlugins = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const dialog = useDialog()
  const [tab, setTab] = createSignal<"installed" | "discover">("installed")
  const [query, setQuery] = createSignal("")
  const [pending, setPending] = createSignal<string | undefined>(undefined)
  const [importState, setImportState] = createSignal<"idle" | "busy" | "ok" | "fail">("idle")
  const [expanded, setExpanded] = createSignal<string | undefined>(undefined)
  const [copied, setCopied] = createSignal(false)
  const [data, { refetch, mutate }] = createResource(fetchPlugins)
  const plugins = () => data.latest?.plugins
  const pluginPath = (row: PluginRow) => {
    const root = data.latest?.root
    const name = row.file.split("/").pop() ?? row.file
    return root ? `${root}/${name}` : row.file
  }

  const runImport = async (dir: string) => {
    setImportState("busy")
    const res = await fetch("/global/fabula/import-plugin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir }),
    }).catch(() => undefined)
    const body = (await res?.json().catch(() => ({}))) as { ok?: boolean }
    setImportState(body?.ok ? "ok" : "fail")
    void refetch()
  }

  const chooseAndImport = async () => {
    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const picked = await platform.openDirectoryPickerDialog?.({ title: language.t("settings.plugins.import") })
      const dir = Array.isArray(picked) ? picked[0] : picked
      if (dir) await runImport(dir)
      return
    }
    dialog.show(
      () => (
        <DialogSelectDirectory
          onSelect={(r) => {
            const dir = Array.isArray(r) ? r[0] : r
            if (dir) void runImport(dir)
          }}
        />
      ),
      () => undefined,
    )
  }

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    const list = plugins() ?? []
    if (!q) return list
    return list.filter((p) => p.id.toLowerCase().includes(q) || p.file.toLowerCase().includes(q))
  })

  const toggle = async (row: PluginRow, enabled: boolean) => {
    setPending(row.id)
    mutate((cur) =>
      cur
        ? { ...cur, plugins: cur.plugins.map((p) => (p.id === row.id ? { ...p, enabled } : p)) }
        : cur,
    )
    await fetch("/global/fabula/plugins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: row.id, enabled }),
    }).catch(() => undefined)
    setPending(undefined)
    void refetch()
  }

  return (
    <div class="flex flex-col gap-4 px-4 py-4">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-2xl font-semibold tracking-tight text-text-strong">
          {language.t("settings.plugins.title")}
        </h2>
        <span class="inline-flex h-6 items-center rounded-full border border-text-interactive-base px-2 text-[11px] font-semibold text-text-interactive-base">
          {language.t("settings.plugins.beta")}
        </span>
      </div>

      <div class="flex flex-wrap items-start justify-between gap-3">
        <p class="min-w-0 flex-1 text-[13px] leading-6 text-text-weak">
          {language.t("settings.plugins.description")} {language.t("settings.plugins.restartHint")}
        </p>
        <button
          type="button"
          class="shrink-0 h-7 rounded-lg px-2.5 text-[12px] text-text-weak hover:bg-surface-raised-base-hover hover:text-text-strong transition-colors cursor-pointer"
          onClick={() => void refetch()}
        >
          {language.t("settings.plugins.check")}
        </button>
      </div>

      <div class="flex h-7 w-fit items-center rounded-full bg-surface-base p-0.5">
        <For
          each={[
            { id: "installed" as const, label: () => language.t("settings.plugins.installed") },
            { id: "discover" as const, label: () => language.t("settings.plugins.discover") },
          ]}
        >
          {(chip) => (
            <button
              type="button"
              class="h-6 rounded-full px-2.5 text-[12px] font-medium leading-none transition-colors cursor-pointer"
              classList={{
                "bg-background-base text-text-strong": tab() === chip.id,
                "text-text-weak hover:text-text-strong": tab() !== chip.id,
              }}
              onClick={() => setTab(chip.id)}
            >
              {chip.label()}
            </button>
          )}
        </For>
      </div>

      <Show
        when={tab() === "installed"}
        fallback={
          <div class="flex flex-col items-center gap-3 py-10">
            <Icon name="sliders" size="large" class="text-icon-weak-base" />
            <p class="max-w-md text-center text-[13px] text-text-weak">{language.t("settings.plugins.importHint")}</p>
            <Button icon="folder-add-left" disabled={importState() === "busy"} onClick={chooseAndImport}>
              {importState() === "busy" ? language.t("settings.plugins.importing") : language.t("settings.plugins.import")}
            </Button>
            <Show when={importState() === "ok"}>
              <p class="text-[13px] text-text-success-base">{language.t("settings.plugins.importOk")}</p>
            </Show>
            <Show when={importState() === "fail"}>
              <p class="text-[13px] text-text-danger-base">{language.t("settings.plugins.importFail")}</p>
            </Show>
          </div>
        }
      >
        <div class="relative min-w-0">
          <span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-weak">
            <Icon name="magnifying-glass" size="small" />
          </span>
          <input
            type="text"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder={language.t("settings.plugins.search")}
            spellcheck={false}
            class="h-9 w-full rounded-xl border border-border-weak-base bg-surface-base pl-8 pr-3 text-[13px] text-text-strong outline-none transition-colors placeholder:text-text-weak hover:border-border-weak-base focus:border-text-interactive-base"
          />
        </div>

        <div class="flex items-center justify-between text-[13px] text-text-weak">
          <span>
            {language.t("settings.plugins.installed")} · {filtered().length} {language.t("settings.plugins.items")}
          </span>
        </div>

        <div class="flex flex-col overflow-hidden rounded-xl border border-border-weaker-base">
          <Show
            when={filtered().length > 0}
            fallback={
              <div class="py-8 text-center text-[13px] text-text-weak">{language.t("settings.plugins.empty")}</div>
            }
          >
            <For each={filtered()}>
              {(row) => (
                <div class="border-b border-border-weaker-base last:border-b-0">
                  <div
                    class="flex cursor-pointer items-center gap-3 px-3 py-3 transition-colors hover:bg-surface-raised-base-hover"
                    onClick={() => setExpanded((cur) => (cur === row.id ? undefined : row.id))}
                  >
                    <div class="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-base">
                      <Icon name="sliders" size="small" class="text-icon-base" />
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="text-14-medium text-text-strong">{row.id}</span>
                        <span class="inline-flex h-5 items-center rounded-md bg-surface-base px-1.5 text-[11px] text-text-weak">
                          {language.t("settings.plugins.builtin")}
                        </span>
                      </div>
                      <div class="truncate text-[12px] text-text-weak">{row.file}</div>
                    </div>
                    <Show
                      when={row.id !== "manage"}
                      fallback={
                        <span class="inline-flex h-5 shrink-0 items-center rounded-md bg-surface-base px-1.5 text-[11px] text-text-weak">
                          {language.t("settings.plugins.always")}
                        </span>
                      }
                    >
                      <div onClick={(e) => e.stopPropagation()}>
                        <UiSwitch
                          checked={row.enabled}
                          disabled={pending() === row.id}
                          onChange={(checked: boolean) => void toggle(row, checked)}
                        />
                      </div>
                    </Show>
                  </div>
                  <Show when={expanded() === row.id}>
                    <div
                      data-component="plugin-detail"
                      class="flex flex-col gap-2 border-t border-border-weaker-base bg-surface-base/40 px-4 py-3"
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="shrink-0 text-[11px] font-medium text-text-weaker uppercase tracking-wide">
                          {language.t("settings.plugins.detail.path")}
                        </span>
                        <span class="min-w-0 truncate font-mono text-[12px] text-text-base">{pluginPath(row)}</span>
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="shrink-0 text-[11px] font-medium text-text-weaker uppercase tracking-wide">
                          {language.t("settings.plugins.detail.status")}
                        </span>
                        <span class="text-[12px] text-text-base">
                          {row.enabled
                            ? language.t("settings.plugins.detail.enabled")
                            : language.t("settings.plugins.detail.disabled")}{" "}
                          · {language.t("settings.plugins.restartHint")}
                        </span>
                      </div>
                      <div class="flex items-center gap-2 pt-1">
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => {
                            void navigator.clipboard?.writeText(pluginPath(row))
                            setCopied(true)
                            setTimeout(() => setCopied(false), 1500)
                          }}
                        >
                          {copied()
                            ? language.t("settings.plugins.detail.copied")
                            : language.t("settings.plugins.detail.copyPath")}
                        </Button>
                        <Show when={fileBridge()}>
                          <Button
                            size="small"
                            variant="ghost"
                            onClick={() => fileBridge()!.postMessage({ action: "reveal", path: pluginPath(row) })}
                          >
                            {language.t("settings.plugins.detail.reveal")}
                          </Button>
                        </Show>
                      </div>
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  )
}
