import { Show, createMemo } from "solid-js"
import { DateTime } from "luxon"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { Icon } from "@mimo-ai/ui/icon"
import { getDirectory, getFilename } from "@mimo-ai/shared/util/path"
import { HomeUsageWidget } from "@/components/home-usage-widget"

const MAIN_WORKTREE = "main"
const CREATE_WORKTREE = "create"
// FABULA: this new-session view is now the app's home (Claude-Code behavior — we open straight into
// the real chat). It scrolls so the usage dashboard fits above the greeting/branch info.
const ROOT_CLASS = "size-full overflow-y-auto no-scrollbar"

interface NewSessionViewProps {
  worktree: string
}

export function NewSessionView(props: NewSessionViewProps) {
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()

  const sandboxes = createMemo(() => sync.project?.sandboxes ?? [])
  const options = createMemo(() => [MAIN_WORKTREE, ...sandboxes(), CREATE_WORKTREE])
  const current = createMemo(() => {
    const selection = props.worktree
    if (options().includes(selection)) return selection
    return MAIN_WORKTREE
  })
  const projectRoot = createMemo(() => sync.project?.worktree ?? sdk.directory)
  const greeting = createMemo(() => {
    const hour = new Date().getHours()
    if (hour >= 5 && hour < 12) return language.t("home.greeting.morning")
    if (hour >= 12 && hour < 18) return language.t("home.greeting.afternoon")
    return language.t("home.greeting.evening")
  })
  const isWorktree = createMemo(() => {
    const project = sync.project
    if (!project) return false
    return sdk.directory !== project.worktree
  })

  const label = (value: string) => {
    if (value === MAIN_WORKTREE) {
      if (isWorktree()) return language.t("session.new.worktree.main")
      const branch = sync.data.vcs?.branch
      if (branch) return language.t("session.new.worktree.mainWithBranch", { branch })
      return language.t("session.new.worktree.main")
    }

    if (value === CREATE_WORKTREE) return language.t("session.new.worktree.create")

    return getFilename(value)
  }

  return (
    <div class={ROOT_CLASS}>
      <div class="min-h-full px-6 pt-16 pb-30 flex flex-col items-center gap-8 text-center">
        <div class="w-full max-w-200 flex flex-col items-center text-center gap-4">
          {/* FABULA: time-of-day greeting — this is the app's home screen (we open straight to chat). */}
          <h1 class="text-3xl font-semibold tracking-tight text-text-strong">{greeting()}</h1>
          <div class="w-full flex flex-col gap-4 items-center">
            <div class="flex items-start justify-center gap-3 min-h-5">
              <div class="text-12-medium text-text-weak select-text leading-5 min-w-0 max-w-160 break-words text-center">
                {getDirectory(projectRoot())}
                <span class="text-text-strong">{getFilename(projectRoot())}</span>
              </div>
            </div>
            <div class="flex items-start justify-center gap-1.5 min-h-5">
              <Icon name="branch" size="small" class="mt-0.5 shrink-0" />
              <div class="text-12-medium text-text-weak select-text leading-5 min-w-0 max-w-160 break-words text-center">
                {label(current())}
              </div>
            </div>
            <Show when={sync.project}>
              {(project) => (
                <div class="flex items-start justify-center gap-3 min-h-5">
                  <div class="text-12-medium text-text-weak leading-5 min-w-0 max-w-160 break-words text-center">
                    {language.t("session.new.lastModified")}&nbsp;
                    <span class="text-text-strong">
                      {DateTime.fromMillis(project().time.updated ?? project().time.created)
                        .setLocale(language.intl())
                        .toRelative()}
                    </span>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </div>
        {/* FABULA: usage dashboard, moved here from the old launcher so it survives opening straight
            into chat. Self-contained (fetches /global/fabula/usage). */}
        <div class="w-full max-w-2xl">
          <HomeUsageWidget />
        </div>
      </div>
    </div>
  )
}
