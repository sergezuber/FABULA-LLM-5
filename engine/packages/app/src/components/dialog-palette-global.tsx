// FABULA: lightweight global command palette usable ANYWHERE (incl. Home), where the rich
// session palette (dialog-select-file.tsx) can't run because it needs session-only providers
// (useFile/useSessionLayout). This one uses only globally-available data: registered commands
// (useCommand) + the global session list (allSessions signal). Scope chips All/Commands/Chats;
// the "Chats" scope shows recent sessions even with no query, and a 2+ char query also
// full-text-searches message content via /global/fabula/search (snippet rows). Files are out
// of scope here by design — inside a project the session palette (with its Files chip) opens instead.
import { createMemo, createResource, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { A, useNavigate } from "@solidjs/router"
import { base64Encode } from "@mimo-ai/shared/util/encode"
import { getFilename } from "@mimo-ai/shared/util/path"
import { Dialog } from "@mimo-ai/ui/dialog"
import { List } from "@mimo-ai/ui/list"
import { Icon } from "@mimo-ai/ui/icon"
import { Keybind } from "@mimo-ai/ui/keybind"
import { formatKeybind, useCommand, type CommandOption } from "@/context/command"
import { useDialog } from "@mimo-ai/ui/context/dialog"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { sessionTitle } from "@/utils/session-title"
import { getRelativeTime } from "@/utils/time"
import { allSessions } from "@/pages/layout/sidebar-all-sessions"
import { fabulaProjectDirs } from "@/pages/layout/sidebar-all-sessions"

type Scope = "all" | "command" | "session"

type Entry =
  | { type: "command"; id: string; title: string; description?: string; category: string; option: CommandOption }
  | {
      type: "session"
      id: string
      title: string
      category: string
      directory: string
      sessionID: string
      updated?: number
    }
  | {
      type: "content"
      id: string
      title: string
      category: string
      directory: string
      sessionID: string
      snippet: string
    }

export function DialogPaletteGlobal(): JSX.Element {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const globalSync = useGlobalSync()


  const scopes: { id: Scope; label: () => string }[] = [
    { id: "all", label: () => language.t("palette.scope.all") },
    { id: "command", label: () => language.t("palette.scope.commands") },
    { id: "session", label: () => language.t("palette.scope.sessions") },
  ]
  const [scope, setScope] = createSignal<Scope>("all")

  // Debounced copy of the List's search text — drives the content full-text search.
  const [query, setQuery] = createSignal("")
  const [debounced, setDebounced] = createSignal("")
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  const onFilter = (value: string) => {
    setQuery(value)
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => setDebounced(value.trim()), 200)
  }

  const [contentHits] = createResource(
    () => (scope() === "command" ? "" : debounced()),
    async (q): Promise<Entry[]> => {
      if (q.length < 2) return []
      const dirs = fabulaProjectDirs()
      const dirsQs = dirs.length ? `&dirs=${encodeURIComponent(JSON.stringify(dirs))}` : ""
      const res = await fetch(`/global/fabula/search?q=${encodeURIComponent(q)}&limit=20${dirsQs}`).catch(
        () => undefined,
      )
      if (!res?.ok) return []
      const data = (await res.json().catch(() => ({ results: [] }))) as {
        results: { sessionID: string; directory: string; title: string; snippet: string }[]
      }
      return (data.results ?? []).map((hit) => ({
        type: "content" as const,
        id: `content:${hit.sessionID}`,
        title: sessionTitle(hit.title) ?? "New session",
        category: language.t("palette.group.content"),
        directory: hit.directory,
        sessionID: hit.sessionID,
        snippet: hit.snippet,
      }))
    },
  )

  const norm = (p: string) => p.replace(/\/+$/, "")
  const withinHome = (dir: string, home: string) => !home || norm(dir) === norm(home) || norm(dir).startsWith(norm(home) + "/")

  const commandEntries = createMemo<Entry[]>(() =>
    command.options
      .filter((o) => !o.disabled && o.id !== "file.open" && !o.id.startsWith("suggested."))
      .map((option) => ({
        type: "command" as const,
        id: `command:${option.id}`,
        title: option.title,
        description: option.description,
        category: option.category ?? language.t("palette.group.commands"),
        option,
      })),
  )

  const sessionEntries = createMemo<Entry[]>(() => {
    const home = globalSync.data.path.home
    return [...allSessions()]
      .filter((s) => !s.parentID && !s.time?.archived && withinHome(s.directory, home))
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 50)
      .map((s) => ({
        type: "session" as const,
        id: `session:${s.id}`,
        title: sessionTitle(s.title) ?? "New session",
        category: language.t("command.category.session"),
        directory: s.directory,
        sessionID: s.id,
        updated: s.time.updated,
      }))
  })

    // Empty query in the "All" scope shows a curated landing (a few suggested actions + the five
  // most recent chats) instead of the full command wall — typing switches to the complete search.
  const SUGGESTED = ["session.new.global", "project.open", "settings.open", "sidebar.toggle"]
  const items = () => {
    const s = scope()
    const content = contentHits() ?? []
    if (s === "all" && !query().trim()) {
      const byId = new Map(commandEntries().map((e) => [e.type === "command" ? e.option.id : "", e]))
      const suggested = SUGGESTED.flatMap((id) => {
        const entry = byId.get(id)
        return entry ? [{ ...entry, category: language.t("palette.group.suggested") }] : []
      })
      const recent = sessionEntries()
        .slice(0, 5)
        .map((e) => ({ ...e, category: language.t("palette.group.recent") }))
      return [...suggested, ...recent]
    }
    if (s === "command") return commandEntries()
    if (s === "session") return [...sessionEntries(), ...content]
    return [...commandEntries(), ...sessionEntries(), ...content]
  }

  const onSelect = (item: Entry | undefined) => {
    if (!item) return
    dialog.close()
    if (item.type === "command") {
      item.option.onSelect?.("palette")
      return
    }
    navigate(`/${base64Encode(item.directory)}/session/${item.sessionID}`)
  }

  const chips = (
    <div class="flex shrink-0 gap-1 px-3 pt-1 pb-2 overflow-x-auto no-scrollbar" role="tablist">
      <For each={scopes}>
        {(item) => (
          <button
            type="button"
            role="tab"
            aria-selected={scope() === item.id}
            class="inline-flex h-6 shrink-0 items-center rounded-full border px-2.5 text-[11px] font-medium leading-none transition-colors cursor-pointer"
            classList={{
              "border-border-weak-base bg-surface-base text-text-strong": scope() === item.id,
              "border-transparent text-text-weak hover:bg-surface-raised-base-hover hover:text-text-strong":
                scope() !== item.id,
            }}
            onClick={() => setScope(item.id)}
          >
            {item.label()}
          </button>
        )}
      </For>
    </div>
  )

  return (
    <Dialog class="pt-3 pb-0 !max-h-[480px] !rounded-2xl" transition>
      <Show when={scope()}>
        {(_) => (
          <List
            search={{ placeholder: language.t("palette.search.placeholder"), autofocus: true, hideIcon: true }}
            header={chips}
            emptyMessage={language.t("palette.empty")}
            loadingMessage={language.t("common.loading")}
            items={items}
            key={(item: Entry) => item.id}
            filter={query()}
            onFilter={onFilter}
            filterKeys={["title", "description", "category", "snippet"]}
            groupBy={(item: Entry) => item.category}
            onSelect={onSelect}
          >
            {(item: Entry) => (
              <Switch>
                <Match when={item.type === "command"}>
                  <div class="w-full flex items-center justify-between gap-4">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="text-[13px] text-text-strong whitespace-nowrap">{item.title}</span>
                      <Show when={item.type === "command" && item.description}>
                        <span class="text-[13px] text-text-weak truncate">
                          {item.type === "command" ? item.description : ""}
                        </span>
                      </Show>
                    </div>
                    <Show when={item.type === "command" && item.option.keybind}>
                      <Keybind class="rounded-[4px]">
                        {formatKeybind(item.type === "command" ? item.option.keybind ?? "" : "", language.t)}
                      </Keybind>
                    </Show>
                  </div>
                </Match>
                <Match when={item.type === "content"}>
                  <div class="w-full flex flex-col gap-0.5 rounded-md pl-1 py-0.5 min-w-0">
                    <div class="flex items-center gap-x-3 min-w-0">
                      <Icon name="magnifying-glass" size="small" class="shrink-0 text-icon-weak" />
                      <span class="text-[13px] text-text-strong truncate">{item.title}</span>
                      <span class="shrink-0 text-[11px] text-text-weak truncate max-w-[96px] ml-auto">
                        {item.type === "content" ? getFilename(item.directory) : ""}
                      </span>
                    </div>
                    <span class="text-[12px] text-text-weak truncate pl-7">
                      {item.type === "content" ? item.snippet : ""}
                    </span>
                  </div>
                </Match>
                <Match when={item.type === "session"}>
                  <div class="w-full flex items-center justify-between rounded-md pl-1">
                    <div class="flex items-center gap-x-3 grow min-w-0">
                      <Icon name="bubble-5" size="small" class="shrink-0 text-icon-weak" />
                      <span class="text-[13px] text-text-strong truncate">{item.title}</span>
                    </div>
                    <span class="shrink-0 text-[11px] text-text-weak truncate max-w-[96px] ml-2">
                      {item.type === "session" ? getFilename(item.directory) : ""}
                    </span>
                    <Show when={item.type === "session" && item.updated}>
                      <span class="shrink-0 text-[11px] text-text-weak whitespace-nowrap ml-2">
                        {getRelativeTime(new Date((item.type === "session" && item.updated) || 0).toISOString(), language.t)}
                      </span>
                    </Show>
                  </div>
                </Match>
              </Switch>
            )}
          </List>
        )}
      </Show>
    </Dialog>
  )
}
