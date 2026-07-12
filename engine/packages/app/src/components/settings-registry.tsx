// FABULA: generic Settings page for the file-based registries — Skills, Subagents
// (agents), Commands. Full CRUD over plain markdown via /global/fabula/registry;
// the engine picks changes up on its next start (same contract as plugins).
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { base64Decode } from "@mimo-ai/shared/util/encode"
import { Icon, type IconProps } from "@mimo-ai/ui/icon"
import { Switch as UiSwitch } from "@mimo-ai/ui/switch"
import { Button } from "@mimo-ai/ui/button"
import { Dialog } from "@mimo-ai/ui/dialog"
import { useDialog } from "@mimo-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"

export type RegistryKind = "skills" | "agents" | "commands"

type RegistryItem = { name: string; file: string; description?: string; content: string; enabled?: boolean }
type RegistryData = { root: string; items: RegistryItem[]; builtins: string[] }

const KIND_ICON: Record<RegistryKind, IconProps["name"]> = {
  skills: "brain",
  agents: "fork",
  commands: "console",
}

async function fetchRegistry(kind: RegistryKind, scope: "global" | "project", dir?: string): Promise<RegistryData> {
  const params = new URLSearchParams({ kind, scope })
  if (scope === "project" && dir) params.set("dir", dir)
  const res = await fetch(`/global/fabula/registry?${params}`).catch(() => undefined)
  if (!res?.ok) return { root: "", items: [], builtins: [] }
  return (await res.json()) as RegistryData
}

// Frontmatter helpers for the structured agent form (best-effort line parser; unknown keys survive
// round-trips untouched because Source mode edits the raw markdown directly).
function parseAgentDoc(raw: string) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const fields: Record<string, string> = {}
  if (match) {
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":")
      if (idx <= 0) continue
      fields[line.slice(0, idx).trim()] = line
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
    }
  }
  return { fields, body: match ? raw.slice(match[0].length) : raw }
}
function buildAgentDoc(fields: Record<string, string>, body: string) {
  const lines = Object.entries(fields)
    .filter(([, v]) => v.trim() !== "")
    .map(([k, v]) => `${k}: ${v.trim()}`)
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/^\n+/, "")}`
}

const RegistryEditor = (props: {
  title: string
  initial: string
  structured?: boolean
  onSave: (content: string) => Promise<boolean>
}) => {
  const dialog = useDialog()
  const language = useLanguage()
  const [text, setText] = createSignal(props.initial)
  const [busy, setBusy] = createSignal(false)
  const [mode, setMode] = createSignal<"form" | "source">(props.structured ? "form" : "source")
  const parsed = parseAgentDoc(props.initial)
  const [desc, setDesc] = createSignal(parsed.fields["description"] ?? "")
  const [agentMode, setAgentMode] = createSignal(parsed.fields["mode"] ?? "subagent")
  const [model, setModel] = createSignal(parsed.fields["model"] ?? "")
  const [body, setBody] = createSignal(parsed.body)
  // Keep both representations in sync when switching tabs.
  const composed = () =>
    buildAgentDoc(
      { ...parsed.fields, description: desc(), mode: agentMode(), model: model() },
      body(),
    )
  const switchTo = (next: "form" | "source") => {
    if (next === mode()) return
    if (next === "source") setText(composed())
    if (next === "form") {
      const p = parseAgentDoc(text())
      setDesc(p.fields["description"] ?? "")
      setAgentMode(p.fields["mode"] ?? "subagent")
      setModel(p.fields["model"] ?? "")
      setBody(p.body)
    }
    setMode(next)
  }
  const finalContent = () => (mode() === "form" ? composed() : text())
  return (
    <Dialog size="large" transition>
      <div class="flex h-full min-h-0 flex-col gap-3 p-4">
        <div class="flex items-center gap-3">
          <h3 class="text-16-medium text-text-strong">{props.title}</h3>
          <Show when={props.structured}>
            <div class="ml-auto flex h-7 items-center rounded-full bg-surface-base p-0.5">
              <For each={[{ id: "form" as const, k: "settings.registry.editor.form" }, { id: "source" as const, k: "settings.registry.editor.source" }]}>
                {(m) => (
                  <button
                    type="button"
                    class="h-6 rounded-full px-2.5 text-[12px] font-medium leading-none transition-colors cursor-pointer"
                    classList={{
                      "bg-background-base text-text-strong": mode() === m.id,
                      "text-text-weak hover:text-text-strong": mode() !== m.id,
                    }}
                    onClick={() => switchTo(m.id)}
                  >
                    {language.t(m.k as never)}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
        <Show
          when={props.structured && mode() === "form"}
          fallback={
            <textarea
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
              spellcheck={false}
              class="min-h-80 flex-1 resize-none rounded-xl border border-border-weak-base bg-background-base p-3 font-mono text-[12px] leading-5 text-text-strong outline-none focus:border-text-interactive-base"
            />
          }
        >
          <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            <label class="flex flex-col gap-1 text-[12px] text-text-weak">
              {language.t("settings.registry.agent.description")}
              <input
                type="text"
                value={desc()}
                onInput={(e) => setDesc(e.currentTarget.value)}
                class="h-8 rounded-lg border border-border-weak-base bg-background-base px-2 text-[13px] text-text-strong outline-none focus:border-text-interactive-base"
              />
            </label>
            <div class="grid grid-cols-2 gap-3">
              <label class="flex flex-col gap-1 text-[12px] text-text-weak">
                {language.t("settings.registry.agent.mode")}
                <select
                  value={agentMode()}
                  onChange={(e) => setAgentMode(e.currentTarget.value)}
                  class="h-8 rounded-lg border border-border-weak-base bg-background-base px-2 text-[13px] text-text-strong outline-none"
                >
                  <option value="subagent">subagent</option>
                  <option value="primary">primary</option>
                  <option value="all">all</option>
                </select>
              </label>
              <label class="flex flex-col gap-1 text-[12px] text-text-weak">
                {language.t("settings.registry.agent.model")}
                <input
                  type="text"
                  value={model()}
                  placeholder={language.t("settings.registry.agent.modelPlaceholder")}
                  onInput={(e) => setModel(e.currentTarget.value)}
                  class="h-8 rounded-lg border border-border-weak-base bg-background-base px-2 text-[13px] text-text-strong outline-none focus:border-text-interactive-base"
                />
              </label>
            </div>
            <label class="flex min-h-0 flex-1 flex-col gap-1 text-[12px] text-text-weak">
              {language.t("settings.registry.agent.prompt")}
              <textarea
                value={body()}
                onInput={(e) => setBody(e.currentTarget.value)}
                spellcheck={false}
                class="min-h-56 flex-1 resize-none rounded-xl border border-border-weak-base bg-background-base p-3 font-mono text-[12px] leading-5 text-text-strong outline-none focus:border-text-interactive-base"
              />
            </label>
          </div>
        </Show>
        <div class="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("settings.registry.cancel")}
          </Button>
          <Button
            disabled={busy() || !finalContent().trim()}
            onClick={async () => {
              setBusy(true)
              const ok = await props.onSave(finalContent())
              setBusy(false)
              if (ok) dialog.close()
            }}
          >
            {language.t("settings.registry.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export const SettingsRegistry = (props: { kind: RegistryKind }) => {
  const language = useLanguage()
  const dialog = useDialog()
  const params = useParams()
  // Project scope maps to <project>/.mimocode (engine contract); skills are global-only.
  const projectDir = createMemo(() => {
    try {
      return params.dir ? base64Decode(params.dir) : undefined
    } catch {
      return undefined
    }
  })
  const [scope, setScope] = createSignal<"global" | "project">("global")
  const scopeAvailable = () => props.kind !== "skills" && !!projectDir()
  const [data, { refetch }] = createResource(
    () => ({ kind: props.kind, scope: scopeAvailable() ? scope() : ("global" as const), dir: projectDir() }),
    (input) => fetchRegistry(input.kind, input.scope, input.dir),
  )
  // Cache-through-signal so refetches never blank the list (anti-flicker pattern used app-wide).
  const [cached, setCached] = createSignal<RegistryData>({ root: "", items: [], builtins: [] })
  createEffect(() => {
    const next = data()
    if (next) setCached(next)
  })
  const [query, setQuery] = createSignal("")
  const matches = (text: string) => text.toLowerCase().includes(query().trim().toLowerCase())
  const items = createMemo(() =>
    cached().items.filter((item) => !query().trim() || matches(item.name) || matches(item.description ?? "")),
  )
  const builtins = createMemo(() => cached().builtins.filter((name) => !query().trim() || matches(name)))

  const write = async (body: Record<string, unknown>) => {
    const res = await fetch("/global/fabula/registry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: props.kind,
        scope: scopeAvailable() ? scope() : "global",
        dir: projectDir(),
        ...body,
      }),
    }).catch(() => undefined)
    const out = (await res?.json().catch(() => ({}))) as { ok?: boolean }
    void refetch()
    return !!out?.ok
  }

  // Optimistic toggle: flip the row immediately, reconcile on refetch.
  const toggle = async (item: RegistryItem, enabled: boolean) => {
    setCached((prev) => ({
      ...prev,
      items: prev.items.map((x) => (x.file === item.file ? { ...x, enabled } : x)),
    }))
    await write({ action: "toggle", location: item.file, enabled })
  }

  const openEditor = (item: RegistryItem) => {
    dialog.show(
      () => (
        <RegistryEditor
          title={item.name}
          initial={item.content}
          structured={props.kind === "agents"}
          onSave={(content) => write({ action: "update", location: item.file, content })}
        />
      ),
      () => undefined,
    )
  }

  const create = async () => {
    const name = window.prompt(language.t("settings.registry.namePrompt"))?.trim()
    if (!name) return
    await write({ action: "create", name })
    const fresh = await fetchRegistry(props.kind, scopeAvailable() ? scope() : "global", projectDir())
    const item = fresh.items.find((x) => x.name === name || x.name === name.replace(/\.md$/, ""))
    if (item) openEditor(item)
  }

  const remove = async (item: RegistryItem) => {
    if (!window.confirm(language.t("settings.registry.deleteConfirm", { name: item.name }))) return
    await write({ action: "delete", location: item.file })
  }

  return (
    <div class="flex flex-col gap-4 px-4 py-4">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-2xl font-semibold tracking-tight text-text-strong">
          {language.t(`settings.tab.${props.kind}` as never)}
        </h2>
        <Show when={scopeAvailable()}>
          <div class="flex h-7 items-center rounded-full bg-surface-base p-0.5">
            <For each={[{ id: "global" as const, k: "settings.registry.scope.global" }, { id: "project" as const, k: "settings.registry.scope.project" }]}>
              {(s) => (
                <button
                  type="button"
                  class="h-6 rounded-full px-2.5 text-[12px] font-medium leading-none transition-colors cursor-pointer"
                  classList={{
                    "bg-background-base text-text-strong": scope() === s.id,
                    "text-text-weak hover:text-text-strong": scope() !== s.id,
                  }}
                  onClick={() => setScope(s.id)}
                >
                  {language.t(s.k as never)}
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="ml-auto flex items-center gap-2">
          <div class="relative">
            {/* Icon must be wrapped: absolute classes directly on Icon break its own sizing. */}
            <span class="pointer-events-none absolute left-2 top-1/2 flex -translate-y-1/2 items-center text-icon-weak [&_svg]:size-3.5">
              <Icon name="magnifying-glass" size="small" />
            </span>
            <input
              type="text"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder={language.t("common.search")}
              spellcheck={false}
              class="h-8 w-44 rounded-lg border border-border-weak-base bg-background-base pl-7 pr-2 text-[13px] text-text-strong outline-none placeholder:text-text-weak focus:border-text-interactive-base"
            />
          </div>
          <Button icon="plus" size="normal" class="pl-2 pr-3" onClick={() => void create()}>
            {language.t("settings.registry.create")}
          </Button>
        </div>
      </div>
      <p class="text-[13px] leading-6 text-text-weak">
        {language.t(`settings.${props.kind}.description` as never)} {language.t("settings.registry.restartHint")}
      </p>

      <div class="flex flex-col overflow-hidden rounded-xl border border-border-weaker-base">
        <Show
          when={items().length + builtins().length > 0}
          fallback={<div class="py-8 text-center text-[13px] text-text-weak">{language.t("settings.registry.empty")}</div>}
        >
          <For each={builtins()}>
            {(name) => (
              <div class="flex items-center gap-3 border-b border-border-weaker-base px-3 py-3 last:border-b-0">
                <div class="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-base">
                  <Icon name={KIND_ICON[props.kind]} size="small" class="text-icon-base" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="text-14-medium text-text-strong">{name}</span>
                    <span class="inline-flex h-5 items-center rounded-md bg-surface-base px-1.5 text-[11px] text-text-weak">
                      {language.t("settings.registry.builtin")}
                    </span>
                  </div>
                  <div class="truncate text-[12px] text-text-weak">
                    {language.t(`settings.registry.builtin.${name}` as never)}
                  </div>
                </div>
              </div>
            )}
          </For>
          <For each={items()}>
            {(item) => (
              <div class="group flex items-center gap-3 border-b border-border-weaker-base px-3 py-3 last:border-b-0 transition-colors hover:bg-surface-raised-base-hover">
                <div class="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-base">
                  <Icon name={KIND_ICON[props.kind]} size="small" class="text-icon-base" />
                </div>
                <div class="min-w-0 flex-1" classList={{ "opacity-50": item.enabled === false }}>
                  <span class="text-14-medium text-text-strong">{item.name}</span>
                  <div class="truncate text-[12px] text-text-weak">{item.description ?? item.file}</div>
                </div>
                <div class="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button size="small" variant="ghost" onClick={() => openEditor(item)}>
                    {language.t("settings.registry.edit")}
                  </Button>
                  <Button size="small" variant="ghost" class="text-text-danger-base" onClick={() => void remove(item)}>
                    {language.t("settings.registry.delete")}
                  </Button>
                </div>
                <UiSwitch
                  checked={item.enabled !== false}
                  onChange={(checked: boolean) => void toggle(item, checked)}
                />
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}
