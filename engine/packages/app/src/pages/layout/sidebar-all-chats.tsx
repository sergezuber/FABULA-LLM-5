// FABULA: the global chat list — every session across all projects, Pinned on top + date groups
// (Today / Yesterday / Mon D), each row tagged with its project folder and a ⋮ menu (pin / rename /
// fork / archive / delete) wired to the real engine SDK. Matches the reference client's flat chat rail.
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import { makePersisted } from "@solid-primitives/storage"
import { Spinner } from "@mimo-ai/ui/spinner"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import { A, useNavigate, useParams } from "@solidjs/router"
import { base64Encode } from "@mimo-ai/shared/util/encode"
import { getFilename } from "@mimo-ai/shared/util/path"
import { Button } from "@mimo-ai/ui/button"
import { Dialog } from "@mimo-ai/ui/dialog"
import { useDialog } from "@mimo-ai/ui/context/dialog"
import { DropdownMenu } from "@mimo-ai/ui/dropdown-menu"
import { IconButton } from "@mimo-ai/ui/icon-button"
import type { Session } from "@mimo-ai/sdk/v2/client"
import { sessionTitle } from "@/utils/session-title"
import { getRelativeTime } from "@/utils/time"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { groupSessions, workspaceKey } from "./helpers"
import { allSessions, allSessionsLoaded, hiddenChatDirs, hideChatDir, refreshAllSessions, scheduleAllSessionsRefresh } from "./sidebar-all-sessions"
import { Key } from "@solid-primitives/keyed"
import { isPinned, pinnedIds, togglePin } from "./sidebar-pins"

const ConfirmDeleteChat = (props: { title: string; onConfirm: () => Promise<void> }): JSX.Element => {
  const dialog = useDialog()
  const language = useLanguage()
  const [busy, setBusy] = createSignal(false)
  return (
    <Dialog size="normal" transition>
      <div class="flex flex-col gap-4 p-5">
        <h3 class="text-16-medium text-text-strong">{language.t("sidebar.chat.deleteTitle")}</h3>
        <p class="text-[13px] leading-6 text-text-weak">{language.t("sidebar.chat.deleteBody", { title: props.title })}</p>
        <div class="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("settings.registry.cancel")}
          </Button>
          <Button
            variant="secondary"
            class="text-text-danger-base"
            disabled={busy()}
            onClick={async () => {
              setBusy(true)
              await props.onConfirm()
              dialog.close()
            }}
          >
            {language.t("common.delete")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const ChatRow = (props: { session: Session }): JSX.Element => {
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  // Hiding a project drops all its chats from the list and stats (the sessions stay in the DB).
  const hideProject = (directory: string) => hideChatDir(directory)
  const notification = useNotification()
  const permission = usePermission()
  const language = useLanguage()
  const navigate = useNavigate()
  const params = useParams()
  const dialog = useDialog()
  // Live status indicators (reference-client): spinner while the agent works, amber dot for a
  // pending permission, red for an error, blue for unread — same sources as the project sidebar.
  // peek({bootstrap:false}) — NEVER child(): child() would bootstrap an instance store per row,
  // and with hundreds of cross-project rows that storm freezes the first render for good.
  const [sessionStore] = globalSync.peek(props.session.directory, { bootstrap: false })
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))
  const hasPermissions = createMemo(
    () =>
      !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.session.id, (item) => {
        return !permission.autoResponds(item, props.session.directory)
      }),
  )
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    const pending = (sessionStore.message[props.session.id] ?? []).findLast(
      (message) =>
        message.role === "assistant" &&
        typeof (message as { time?: { completed?: unknown } }).time?.completed !== "number",
    )
    const status = sessionStore.session_status[props.session.id]
    return pending !== undefined || (status !== undefined && status.type !== "idle")
  })
  const hasIndicator = createMemo(() => isWorking() || hasPermissions() || hasError() || unseenCount() > 0)
  const ru = () => document.documentElement.lang.startsWith("ru")
  const dir = () => props.session.directory
  const href = () => `/${base64Encode(dir())}/session/${props.session.id}`

  // Inline rename (reference-client style) — no native prompt.
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const rename = () => {
    setDraft(sessionTitle(props.session.title) ?? "")
    setEditing(true)
  }
  const commitRename = async () => {
    const next = draft().trim()
    setEditing(false)
    if (!next || next === props.session.title) return
    await globalSDK.client.session.update({ directory: dir(), sessionID: props.session.id, title: next })
    await refreshAllSessions()
  }
  const fork = async () => {
    await globalSDK.client.session.fork({ directory: dir(), sessionID: props.session.id })
    await refreshAllSessions()
  }
  const archived = () => !!props.session.time?.archived
  const archive = async () => {
    await globalSDK.client.session.update({ directory: dir(), sessionID: props.session.id, time: { archived: Date.now() } })
    await refreshAllSessions()
  }
  const unarchive = async () => {
    await globalSDK.client.session.update({
      directory: dir(),
      sessionID: props.session.id,
      time: { archived: null as unknown as number },
    })
    await refreshAllSessions()
  }
  const remove = () => {
    dialog.show(
      () => (
        <ConfirmDeleteChat
          title={sessionTitle(props.session.title) ?? "New session"}
          onConfirm={async () => {
            await globalSDK.client.session.delete({ directory: dir(), sessionID: props.session.id })
            if (params.id === props.session.id) navigate(`/${base64Encode(dir())}/session`)
            await refreshAllSessions()
          }}
        />
      ),
      () => undefined,
    )
  }

  return (
    <div class="group/session relative flex items-center gap-1 min-w-0 w-full rounded-md pr-1 transition-colors hover:bg-surface-raised-base-hover [&:has(.active)]:bg-surface-base-active">
      <Show
        when={!editing()}
        fallback={
          <input
            type="text"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename()
              if (e.key === "Escape") setEditing(false)
              e.stopPropagation()
            }}
            onBlur={() => void commitRename()}
            ref={(el) => queueMicrotask(() => el.focus())}
            spellcheck={false}
            class="min-w-0 flex-1 ml-3 my-1 h-6 rounded-md border border-text-interactive-base bg-background-base px-1.5 text-[13px] text-text-strong outline-none"
          />
        }
      >
        <A
          href={href()}
          data-session-id={props.session.id}
          class="flex items-center gap-2 min-w-0 flex-1 pl-4 pr-2 py-1.5 focus:outline-none"
          onDblClick={(e) => {
            e.preventDefault()
            rename()
          }}
        >
          <Show when={hasIndicator()}>
            <div class="shrink-0 size-4 -ml-1 flex items-center justify-center text-icon-interactive-base">
              <Switch>
                <Match when={isWorking()}>
                  <Spinner class="size-[13px]" />
                </Match>
                <Match when={hasPermissions()}>
                  <div class="size-1.5 rounded-full bg-surface-warning-strong" />
                </Match>
                <Match when={hasError()}>
                  <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
                </Match>
                <Match when={unseenCount() > 0}>
                  <div class="size-1.5 rounded-full bg-text-interactive-base" />
                </Match>
              </Switch>
            </div>
          </Show>
          <span class="text-[13px] text-text-strong min-w-0 flex-1 truncate">{sessionTitle(props.session.title)}</span>
          <span class="shrink-0 text-[11px] text-text-weak truncate max-w-[84px] group-hover/session:hidden">
            {getFilename(dir())}
          </span>
          <span class="hidden shrink-0 text-[11px] tabular-nums text-text-weak group-hover/session:inline">
            {getRelativeTime(
              new Date(props.session.time.updated ?? props.session.time.created).toISOString(),
              language.t,
            )}
          </span>
        </A>
      </Show>
      <div
        class="shrink-0 overflow-hidden transition-[width,opacity] w-0 opacity-0 pointer-events-none group-hover/session:w-6 group-hover/session:opacity-100 group-hover/session:pointer-events-auto group-focus-within/session:w-6 group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto has-[[data-expanded]]:w-6 has-[[data-expanded]]:opacity-100 has-[[data-expanded]]:pointer-events-auto"
      >
        <DropdownMenu>
          <DropdownMenu.Trigger
            as={IconButton}
            icon="dot-grid"
            variant="ghost"
            class="size-6 rounded-md"
            aria-label={language.t("common.moreOptions")}
          />
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <DropdownMenu.Item onSelect={() => togglePin(props.session.id)}>
                <DropdownMenu.ItemLabel>
                  {isPinned(props.session.id) ? (ru() ? "Открепить" : "Unpin") : ru() ? "Закрепить" : "Pin"}
                </DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={rename}>
                <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void fork()}>
                <DropdownMenu.ItemLabel>Fork</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <Show when={unseenCount() === 0}>
                <DropdownMenu.Item onSelect={() => notification.session.markUnread(props.session.id, dir())}>
                  <DropdownMenu.ItemLabel>
                    {ru() ? "Отметить непрочитанным" : "Mark unread"}
                  </DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </Show>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onSelect={() => hideProject(dir())}>
                <DropdownMenu.ItemLabel>
                  {ru() ? "Скрыть проект из FABULA" : "Hide project from FABULA"}
                </DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void (archived() ? unarchive() : archive())}>
                <DropdownMenu.ItemLabel>
                  {archived() ? (ru() ? "Разархивировать" : "Unarchive") : language.t("common.archive")}
                </DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={remove}>
                <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </div>
    </div>
  )
}

// The server 403s any directory outside $HOME (see server/routes/instance/middleware.ts); opening
// such a session throws in store bootstrap and takes down the whole app. Keep those sessions out of
// the list so they can never become a clickable landmine. Mirrors the server's "within $HOME" rule.
const norm = (p: string) => p.replace(/\/+$/, "")
const withinHome = (dir: string, home: string) => {
  if (!home) return true // path not synced yet — don't hide everything
  const d = norm(dir)
  const h = norm(home)
  return d === h || d.startsWith(h + "/")
}

// Sort mode for the chat list ("View" menu), persisted across launches.
const [chatSort, setChatSort] = makePersisted(createSignal<"updated" | "created">("updated"), {
  name: "fabula.chatSort",
})
// Collapsed date-group labels (day labels are stable per day; stale entries are harmless).
const [collapsedGroups, setCollapsedGroups] = makePersisted(createSignal<string[]>([]), {
  name: "fabula.collapsedChatGroups",
})
const toggleGroup = (label: string) =>
  setCollapsedGroups((prev) => (prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]))

export const AllChatsList = (props: { dirFilter?: string }): JSX.Element => {
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const notification = useNotification()
  const params = useParams()
  // Opening a chat from this list must clear its unread dot — the legacy project-rail flow
  // (syncSessionRoute in layout.tsx) is bypassed by direct navigation, so mark viewed here.
  createEffect(() => {
    const id = params.id
    if (id) notification.session.markViewed(id)
  })
  // Event-driven refresh: session.* on the global SSE stream re-fetches the list (debounced),
  // replacing the old 8s polling loop (now a 30s safety net in sidebar-all-sessions).
  const unsub = globalSDK.event.listen((e) => {
    const type = e.details?.type
    if (typeof type === "string" && type.startsWith("session.")) scheduleAllSessionsRefresh()
  })
  onCleanup(unsub)
  const [showArchived, setShowArchived] = createSignal(false)
  const timeOf = (s: Session) =>
    chatSort() === "created" ? s.time.created : (s.time.updated ?? s.time.created)
  const groups = createMemo(() => {
    const home = globalSync.data.path.home
    const dir = props.dirFilter
    const hiddenDirs = hiddenChatDirs()
    const list = [...allSessions()]
      .filter((s) => !s.parentID && !s.time?.archived && withinHome(s.directory, home))
      .filter((s) => !hiddenDirs.has(s.directory))
      .filter((s) => !dir || workspaceKey(s.directory) === workspaceKey(dir))
      .sort((a, b) => timeOf(b) - timeOf(a))
    return groupSessions(list, Date.now(), pinnedIds(), timeOf)
  })
  // Archived chats live in a collapsed section at the bottom (reference-client behaviour) instead
  // of disappearing entirely — the ⋮ menu offers "Unarchive" for rows shown from here.
  const archivedList = createMemo(() => {
    const home = globalSync.data.path.home
    const dir = props.dirFilter
    return [...allSessions()]
      .filter((s) => !s.parentID && !!s.time?.archived && withinHome(s.directory, home))
      .filter((s) => !dir || workspaceKey(s.directory) === workspaceKey(dir))
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
  })
  const ru = () => document.documentElement.lang.startsWith("ru")

  return (
    <div class="size-full flex flex-col py-2 overflow-y-auto fabula-scrollbar [overflow-anchor:none]">
      <Show when={groups().length > 0}>
        <div class="flex items-center justify-end px-2">
          <DropdownMenu>
            <DropdownMenu.Trigger
              as={IconButton}
              icon="bullet-list"
              variant="ghost"
              class="size-6 rounded-md"
              aria-label={ru() ? "Вид" : "View"}
            />
            <DropdownMenu.Portal>
              <DropdownMenu.Content>
                <DropdownMenu.Item onSelect={() => setChatSort("updated")}>
                  <DropdownMenu.ItemLabel>
                    {(chatSort() === "updated" ? "✓ " : " ") + (ru() ? "По обновлению" : "By updated")}
                  </DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => setChatSort("created")}>
                  <DropdownMenu.ItemLabel>
                    {(chatSort() === "created" ? "✓ " : " ") + (ru() ? "По созданию" : "By created")}
                  </DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item onSelect={() => setCollapsedGroups([])}>
                  <DropdownMenu.ItemLabel>{ru() ? "Развернуть все группы" : "Expand all groups"}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => setCollapsedGroups(groups().map((g) => g.label))}>
                  <DropdownMenu.ItemLabel>{ru() ? "Свернуть все группы" : "Collapse all groups"}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>
      </Show>
      {/* Only claim "no chats" AFTER the first fetch resolves — otherwise the cold-launch empty
          store flashes the empty state before the real rows arrive. */}
      <Show when={allSessionsLoaded() && groups().length === 0 && archivedList().length === 0}>
        <div class="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <span class="text-[13px] text-text-weak">{ru() ? "Чатов пока нет" : "No chats yet"}</span>
          <span class="text-[12px] text-text-weak">
            {ru() ? "Нажмите ⌘N, чтобы начать" : "Press ⌘N to start"}
          </span>
        </div>
      </Show>
      {/* Keyed by date label so a background refetch / sort / pin change reuses group blocks and
          their rows in place (reference-keyed <For> would remount the whole list). */}
      <Key each={groups()} by={(g) => g.label}>
        {(group) => (
          <div class="flex flex-col gap-0.5 pb-2">
            {/* Date header doubles as a collapse toggle (chevron appears on hover). */}
            <button
              type="button"
              class="group/head flex items-center gap-1.5 px-2 pt-3 pb-1 text-[12px] font-medium text-text-weak hover:text-text-strong transition-colors text-left"
              onClick={() => toggleGroup(group().label)}
            >
              <span>{group().label}</span>
              <span class="inline-block w-2.5 text-[10px] leading-none opacity-0 group-hover/head:opacity-100 transition-opacity">
                {collapsedGroups().includes(group().label) ? "▸" : "▾"}
              </span>
              <Show when={collapsedGroups().includes(group().label)}>
                <span class="text-[11px] text-text-weaker">{group().sessions.length}</span>
              </Show>
            </button>
            <Show when={!collapsedGroups().includes(group().label)}>
              <Key each={group().sessions} by={(s) => s.id}>
                {(session) => <ChatRow session={session()} />}
              </Key>
            </Show>
          </div>
        )}
      </Key>
      <Show when={archivedList().length > 0}>
        <div class="flex flex-col gap-0.5 pb-2">
          <button
            type="button"
            class="flex items-center gap-1.5 px-2 pt-3 pb-1 text-[12px] font-medium text-text-weak hover:text-text-strong transition-colors text-left"
            onClick={() => setShowArchived((v) => !v)}
          >
            <span class="inline-block w-2.5 text-[10px] leading-none">{showArchived() ? "▾" : "▸"}</span>
            <span>
              {ru() ? "Архив" : "Archive"} · {archivedList().length}
            </span>
          </button>
          <Show when={showArchived()}>
            <For each={archivedList()}>{(session) => <ChatRow session={session} />}</For>
          </Show>
        </div>
      </Show>
    </div>
  )
}
