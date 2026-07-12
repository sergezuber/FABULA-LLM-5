// FABULA: Settings > Connectors — MCP servers of the launch config: list with type/target,
// enable/disable, delete, and "Add" with a full-JSON entry (the engine's mcp schema).
// Backed by /global/fabula/mcp; changes apply on the next engine start.
import { createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@mimo-ai/ui/button"
import { Icon } from "@mimo-ai/ui/icon"
import { Switch as UiSwitch } from "@mimo-ai/ui/switch"
import { useLanguage } from "@/context/language"

type Server = { name: string; type: string; enabled: boolean; command?: string; url?: string }

export const SettingsMcp = () => {
  const language = useLanguage()
  const [data, { refetch, mutate }] = createResource(async () => {
    const res = await fetch("/global/fabula/mcp").catch(() => undefined)
    if (!res?.ok) return undefined
    return (await res.json()) as { servers: Server[] }
  })
  const [adding, setAdding] = createSignal(false)
  const [name, setName] = createSignal("")
  const [json, setJson] = createSignal('{\n  "type": "local",\n  "command": ["npx", "-y", "<package>"]\n}')
  const [note, setNote] = createSignal("")

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch("/global/fabula/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined)
    const out = (await res?.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    void refetch()
    return out
  }

  const add = async () => {
    if (!name().trim()) return
    const out = await post({ action: "add", name: name().trim(), config: json() })
    setNote(out.ok ? "" : (out.error ?? "error"))
    if (out.ok) {
      setAdding(false)
      setName("")
    }
  }

  return (
    <div class="flex flex-col gap-4 px-4 py-4">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-2xl font-semibold tracking-tight text-text-strong">{language.t("settings.mcp.title")}</h2>
        <div class="ml-auto">
          <Button icon="plus" size="normal" class="pl-2 pr-3" onClick={() => setAdding((v) => !v)}>
            {language.t("settings.registry.create")}
          </Button>
        </div>
      </div>
      <p class="text-[13px] leading-6 text-text-weak">
        {language.t("settings.mcp.subtitle")} {language.t("settings.registry.restartHint")}
      </p>

      <Show when={adding()}>
        <div class="flex flex-col gap-2 rounded-xl border border-border-weak-base p-3">
          <input
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder={language.t("settings.mcp.namePlaceholder")}
            spellcheck={false}
            class="h-8 w-full rounded-lg border border-border-weak-base bg-background-base px-2 text-[13px] text-text-strong outline-none focus:border-text-interactive-base"
          />
          <textarea
            value={json()}
            onInput={(e) => setJson(e.currentTarget.value)}
            spellcheck={false}
            class="min-h-32 w-full resize-y rounded-lg border border-border-weak-base bg-background-base p-2 font-mono text-[12px] leading-5 text-text-strong outline-none focus:border-text-interactive-base"
          />
          <div class="flex items-center gap-2">
            <Show when={note()}>
              <span class="text-[12px] text-text-danger-base">{note()}</span>
            </Show>
            <div class="flex-1" />
            <Button variant="ghost" onClick={() => setAdding(false)}>
              {language.t("settings.registry.cancel")}
            </Button>
            <Button disabled={!name().trim()} onClick={() => void add()}>
              {language.t("settings.registry.save")}
            </Button>
          </div>
        </div>
      </Show>

      <div class="flex flex-col overflow-hidden rounded-xl border border-border-weaker-base">
        <Show
          when={(data.latest?.servers ?? []).length > 0}
          fallback={<div class="py-8 text-center text-[13px] text-text-weak">{language.t("settings.registry.empty")}</div>}
        >
          <For each={data.latest?.servers ?? []}>
            {(server) => (
              <div class="group flex items-center gap-3 border-b border-border-weaker-base px-3 py-3 last:border-b-0 transition-colors hover:bg-surface-raised-base-hover">
                <div class="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-base">
                  <Icon name="providers" size="small" class="text-icon-base" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="text-14-medium text-text-strong">{server.name}</span>
                    <span class="inline-flex h-5 items-center rounded-md bg-surface-base px-1.5 text-[11px] text-text-weak">
                      {server.type}
                    </span>
                  </div>
                  <div class="truncate text-[12px] text-text-weak">{server.command ?? server.url ?? ""}</div>
                </div>
                <Button
                  size="small"
                  variant="ghost"
                  class="shrink-0 text-text-danger-base opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => {
                    if (!window.confirm(language.t("settings.mcp.removeConfirm", { name: server.name }))) return
                    void post({ action: "remove", name: server.name })
                  }}
                >
                  {language.t("settings.registry.delete")}
                </Button>
                <UiSwitch
                  checked={server.enabled}
                  onChange={(enabled: boolean) => {
                    // Optimistic flip — no full-list refetch blink.
                    mutate((cur) =>
                      cur
                        ? { servers: cur.servers.map((s) => (s.name === server.name ? { ...s, enabled } : s)) }
                        : cur,
                    )
                    void post({ action: "toggle", name: server.name, enabled })
                  }}
                />
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}
