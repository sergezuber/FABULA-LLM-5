// FABULA: shared workspace chip — the ZCode-style folder popover (recent projects with a check
// on the active one + "Open folder"). Used on Home and above the new-session composer so the
// new-chat window is visually identical to the Home card.
import { createMemo, For, Show } from "solid-js"
import { DropdownMenu } from "@mimo-ai/ui/dropdown-menu"
import { Icon } from "@mimo-ai/ui/icon"
import { getFilename } from "@mimo-ai/shared/util/path"
import { useDialog } from "@mimo-ai/ui/context/dialog"
import { useGlobalSync } from "@/context/global-sync"
import { allSessions, fabulaProjectDirs, hideChatDir } from "@/pages/layout/sidebar-all-sessions"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"

export function WorkspaceChip(props: {
  current?: string
  onPick: (dir: string) => void
  // Picking via the folder dialog can mean something else than picking a recent dir (Home opens
  // the project immediately); defaults to onPick.
  onOpenFolder?: (dir: string) => void
}) {
  const sync = useGlobalSync()
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const dialog = useDialog()
  const homedir = createMemo(() => sync.data.path.home)
  const ru = () => document.documentElement.lang.startsWith("ru")
  // FABULA-only: only directories that have FABULA (non-imported) sessions, not the whole shared
  // engine project table (which also holds CLI-run and imported project dirs).
  const recent = createMemo(() => {
    allSessions() // start the loader + react
    const dirs = new Set(fabulaProjectDirs())
    return sync.data.project
      .filter((p) => dirs.has(p.worktree))
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 5)
  })
  const open = (dir: string) => (props.onOpenFolder ?? props.onPick)(dir)
  const chooseFolder = async () => {
    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const picked = await platform.openDirectoryPickerDialog?.({ title: language.t("command.project.open") })
      const dir = Array.isArray(picked) ? picked[0] : picked
      if (dir) open(dir)
      return
    }
    dialog.show(
      () => (
        <DialogSelectDirectory
          onSelect={(r) => {
            const dir = Array.isArray(r) ? r[0] : r
            if (dir) open(dir)
          }}
        />
      ),
      () => undefined,
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        as="button"
        class="flex w-fit max-w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-text-base hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
      >
        <Icon name="folder" size="small" class="shrink-0 text-icon-base" />
        <span class="min-w-0 truncate">
          {props.current ? getFilename(props.current) : language.t("command.project.open")}
        </span>
        <Icon name="chevron-down" size="small" class="shrink-0 text-icon-weak-base" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="min-w-72">
          <For each={recent()}>
            {(project) => (
                            // The pick row + a trailing menu that opens a tiny submenu with a single "Remove from list"
              // (removes this path from the recent list — reuses the exact hide-dir store as the chat ⋮).
              <div class="flex w-full items-center gap-1">
                <DropdownMenu.Item class="flex-1 min-w-0" onSelect={() => props.onPick(project.worktree)}>
                  <div class="flex w-full items-center gap-2 min-w-0">
                    <Icon name="folder" size="small" class="shrink-0 text-icon-base" />
                    <DropdownMenu.ItemLabel>
                      <span class="min-w-0 truncate">{project.worktree.replace(homedir(), "~")}</span>
                    </DropdownMenu.ItemLabel>
                    <Show when={props.current === project.worktree}>
                      <Icon name="check-small" size="small" class="ml-auto shrink-0 text-icon-base" />
                    </Show>
                  </div>
                </DropdownMenu.Item>
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger
                    class="flex shrink-0 items-center justify-center size-7 rounded-md text-icon-weak-base hover:bg-surface-raised-base-hover hover:text-icon-base cursor-pointer"
                    aria-label={language.t("common.moreOptions")}
                  >
                    <Icon name="dot-grid" size="small" />
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.SubContent class="min-w-40">
                      <DropdownMenu.Item onSelect={() => hideChatDir(project.worktree)}>
                        <DropdownMenu.ItemLabel>
                          {ru() ? "Удалить из списка" : "Remove from list"}
                        </DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                    </DropdownMenu.SubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              </div>
            )}
          </For>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={() => void chooseFolder()}>
            <div class="flex w-full items-center gap-2">
              <Icon name="folder-add-left" size="small" class="shrink-0 text-icon-base" />
              <DropdownMenu.ItemLabel>{language.t("home.project.open")}</DropdownMenu.ItemLabel>
            </div>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
