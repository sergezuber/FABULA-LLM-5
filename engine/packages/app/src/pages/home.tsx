// FABULA: reference-client-style home — time-of-day greeting over a composer card with a
// workspace popover (recent + check + "Open folder"), a permission-mode selector (writes the
// same fabula-permissions.json the security plugin's guards read), a default-model selector
// (writes the launch config's `model`), and a draft-seeding input that opens a new session.
import { createEffect, createMemo, createResource, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { Button } from "@mimo-ai/ui/button"
import { DropdownMenu } from "@mimo-ai/ui/dropdown-menu"
import { useLayout } from "@/context/layout"
import { allSessions, fabulaProjectDirs } from "@/pages/layout/sidebar-all-sessions"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@mimo-ai/shared/util/encode"
import { Icon } from "@mimo-ai/ui/icon"
import { Tooltip } from "@mimo-ai/ui/tooltip"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@mimo-ai/ui/context/dialog"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { useServer } from "@/context/server"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useModels } from "@/context/models"
import { Persist, PersistTesting } from "@/utils/persist"
import { PmodeMenu } from "@/components/pmode-menu"
import { WorkspaceChip } from "@/components/workspace-chip"
import { OnboardingDialog, ONBOARDED_KEY, markOnboarded } from "@/components/onboarding"
import { HomeUsageWidget } from "@/components/home-usage-widget"
import { HOME_AUTOSUBMIT_KEY, HOME_MODEL_KEY } from "@/components/prompt-input/submit"
import { Mark } from "@mimo-ai/ui/logo"

export default function Home() {
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const providers = useProviders()
  const models = useModels()
  // FABULA-only recency: the engine project table is shared with CLI runs and importers, so
  // restrict "recent projects" (and the default composer target) to directories that actually have
  // FABULA (non-imported) sessions — fabulaProjectDirs() derives exactly that.
  const registryDirs = createMemo(() => {
    allSessions() // start the loader + react to updates
    return new Set(fabulaProjectDirs())
  })
  const recent = createMemo(() => {
    const dirs = registryDirs()
    return sync.data.project
      .filter((p) => dirs.has(p.worktree))
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 5)
  })

  const [chosenDir, setChosenDir] = createSignal<string | undefined>(undefined)
  const [draft, setDraft] = createSignal("")
  const [enhancing, setEnhancing] = createSignal(false)
  const enhanceDraft = async () => {
    const text = draft().trim()
    if (!text || enhancing()) return
    setEnhancing(true)
    try {
      const res = await fetch("/global/fabula/enhance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, model: model() }),
      })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string }
      if (body.ok && body.text) setDraft(body.text)
    } catch {
      /* leave the draft as-is on failure */
    } finally {
      setEnhancing(false)
    }
  }
  const selectedDir = createMemo(() => chosenDir() ?? recent()[0]?.worktree)

  // FABULA (owner request 2026-07-09): Home ALWAYS opens the clean launcher (folder picker + recents +
  // composer), like the reference client — it must NEVER auto-jump into the last project (that re-opened stale/
  // deleted projects like a benchmark scratchpad and showed load errors). Picking a recent/folder only
  // re-targets the composer (setChosenDir); send starts the session. No auto-redirect on boot.

  // Default model — backed by a real engine route (permission mode lives in the shared PmodeMenu).
  const [model, { mutate: mutateModel }] = createResource(async () => {
    const res = await fetch("/global/fabula/model").catch(() => undefined)
    if (!res?.ok) return undefined
    return ((await res.json()) as { model?: string }).model
  })
  const setModel = async (value: string) => {
    mutateModel(value)
    await fetch("/global/fabula/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: value }),
    }).catch(() => undefined)
  }
  const [modelQuery, setModelQuery] = createSignal("")
  // Models grouped by provider — SAME source (models.list) and SAME visibility filter (models.visible)
  // as the session model picker, so Home never offers a model the user hid in Settings ▸ Models (and a
  // picked model is always one the session can actually use — no post-send fallback to a different one).
  const modelGroups = createMemo(() => {
    const q = modelQuery().trim().toLowerCase()
    const byProvider = new Map<string, { provider: string; options: { value: string; label: string }[] }>()
    for (const m of models.list()) {
      if (!models.visible({ modelID: m.id, providerID: m.provider.id })) continue
      const value = `${m.provider.id}/${m.id}`
      const label = m.name ?? m.id
      if (q && !label.toLowerCase().includes(q) && !value.toLowerCase().includes(q)) continue
      const pid = m.provider.id
      if (!byProvider.has(pid)) byProvider.set(pid, { provider: m.provider.name ?? pid, options: [] })
      byProvider.get(pid)!.options.push({ value, label })
    }
    return [...byProvider.values()].filter((g) => g.options.length > 0)
  })
  const modelOptions = createMemo(() => modelGroups().flatMap((g) => g.options))
  const modelLabel = createMemo(() => {
    const current = model()
    if (!current) return "—"
    const match = modelOptions().find((o) => o.value === current)
    return match?.label ?? current.split("/").pop() ?? current
  })

  const openModelSettings = () => {
    void import("@/components/dialog-settings").then((x) => {
      dialog.show(() => <x.DialogSettings tab="models" />)
    })
  }

  // Git state of the selected workspace: branch chip + the user's name for the greeting.
  // initialValue keeps this "refreshing" rather than "pending", so it never registers with the app-wide
  // RouterRoot <Suspense> at creation (which would blank the Home pane while the git shell-out runs on a
    // "New session" navigation). Read only via `git.latest`, so the null seed is inert.
  const [git] = createResource(
    () => selectedDir() ?? "",
    async (dir) => {
      if (!dir) return null
      const res = await fetch(`/global/fabula/git/state?dir=${encodeURIComponent(dir)}`).catch(() => undefined)
      if (!res?.ok) return null
      return (await res.json()) as { ok: boolean; branch?: string; user?: string }
    },
    { initialValue: null },
  )
  const greeting = createMemo(() => {
    const name = git.latest?.user
    return name ? language.t("home.greeting.next", { name }) : language.t("home.greeting.nextNoName")
  })

  // FABULA: first-run onboarding wizard (once; closing in any way marks it done).
  onMount(() => {
    if (typeof window === "undefined") return
    if (window.localStorage.getItem(ONBOARDED_KEY)) return
    dialog.show(
      () => <OnboardingDialog />,
      () => markOnboarded(),
    )
  })

  const serverDotClass = createMemo(() => {
    const healthy = server.healthy()
    if (healthy === true) return "bg-icon-success-base"
    if (healthy === false) return "bg-icon-critical-base"
    return "bg-border-weak-base"
  })

  function openProject(directory: string) {
    layout.projects.open(directory)
    server.projects.touch(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  // Seed the per-workspace prompt draft so the new-session composer opens pre-filled.
  // (No platform guard: the earlier `desktop` early-return silently DROPPED the typed text.)
  // SCOPE GOTCHA: the session prompt context keys its storage by the RAW base64 route segment
  // (params.dir), NOT the decoded path — writing under the decoded path lands in a different
  // workspace bucket and the draft silently never shows up.
  function seedDraft(directory: string, text: string) {
    try {
      const target = Persist.scoped(base64Encode(directory), undefined, "prompt")
      if (!target.storage) return
      const storage = PersistTesting.localStorageWithPrefix(target.storage)
      storage.setItem(
        target.key,
        JSON.stringify({
          prompt: [{ type: "text", content: text, start: 0, end: text.length }],
          cursor: text.length,
          context: { items: [] },
        }),
      )
    } catch {
      // best-effort: the user just types again in the session composer
    }
  }

  // autoSend=true for the send arrow / Enter (actually submit the message on the first press);
  // autoSend=false for "+" (open the composer pre-filled, let the user add attachments / edit).
  function startSession(autoSend = false) {
    const dir = selectedDir()
    if (!dir) return void chooseProject()
    const text = draft().trim()
    if (text) {
      seedDraft(dir, text)
      if (autoSend && typeof sessionStorage !== "undefined") sessionStorage.setItem(HOME_AUTOSUBMIT_KEY, "1")
    }
    // Carry the model the user picked here into the new-session composer as a per-session pin, so the
    // chat runs with EXACTLY that model — the Home picker only writes the launch-config default, which
    // the composer's resolution overrides with the agent/history model otherwise (the "model changed
    // to another one" bug). Seeded for BOTH send paths (Enter and "+") since it reflects the choice on
    // screen; the new composer consumes it once.
    const picked = model()
    if (picked && typeof sessionStorage !== "undefined") sessionStorage.setItem(HOME_MODEL_KEY, picked)
    layout.projects.open(dir)
    server.projects.touch(dir)
    navigate(`/${base64Encode(dir)}/session`)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(directory)
        }
      } else if (result) {
        openProject(result)
      }
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
    } else {
      dialog.show(
        () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
        () => resolve(null),
      )
    }
  }

  return (
    // FABULA: the Home launcher ALWAYS renders (clean slate + folder picker), never a blank redirect.
    <Show when={true} fallback={<div class="size-full" />}>
    {/* FABULA launcher — pick/open a folder (or a recent) to start a chat; ⌘N is always here. */}
    <div class="mx-auto w-full max-w-2xl px-4 flex h-full min-h-0 flex-col">
      <Switch>
        <Match when={registryDirs().size > 0}>
          {/* Reference-client composition: greeting left with the mark, usage widget, empty middle. */}
          <div class="mt-14 flex items-center gap-3">
            <Mark class="w-6 shrink-0" />
            <h1 class="text-3xl font-semibold tracking-tight text-text-strong">{greeting()}</h1>
          </div>

          <div class="mt-8">
            <HomeUsageWidget />
          </div>

          <div class="flex-1 min-h-4" />

          {/* Context chips above the composer: server, workspace, git branch. */}
          <div class="flex items-center gap-2 pb-2">
            <button
              type="button"
              class="flex h-7 items-center gap-1.5 rounded-lg border border-border-weaker-base px-2.5 text-[12px] text-text-base hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
              onClick={() => dialog.show(() => <DialogSelectServer />)}
            >
              <div
                classList={{
                  "size-2 rounded-full": true,
                  [serverDotClass()]: true,
                }}
              />
              {language.t("home.chip.local")}
            </button>
            {/* On the Home launcher, picking a folder — recent OR via the native picker — only RE-TARGETS
                the composer (setChosenDir); it must NOT navigate away to a bare per-project view, which
                would drop the usage widget and flash. startSession() registers+opens the project on send. */}
            <WorkspaceChip current={selectedDir()} onPick={setChosenDir} onOpenFolder={setChosenDir} />
            <Show when={git.latest?.ok && git.latest?.branch}>
              <div class="flex h-7 items-center gap-1.5 rounded-lg border border-border-weaker-base px-2.5 text-[12px] text-text-base">
                <Icon name="branch" size="small" class="shrink-0 text-icon-base" />
                {git.latest?.branch}
              </div>
            </Show>
          </div>

          <div
            data-dock-surface="shell"
            class="mb-6 w-full shrink-0 p-1.5 flex flex-col gap-1 focus-within:shadow-xs-border"
          >
            <div class="px-3 pt-3 pb-2 flex flex-col gap-2">
              <textarea
                rows={2}
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                    e.preventDefault()
                    startSession(true)
                  }
                }}
                placeholder={language.t("home.composer.placeholder")}
                spellcheck={false}
                class="w-full resize-none bg-transparent outline-none text-14-regular text-text-strong placeholder:text-text-weak"
              />
              <div class="flex items-center gap-1.5">
                {/* «+» opens the full composer (attachments live there) in a fresh session */}
                <button
                  type="button"
                  class="flex size-7 items-center justify-center rounded-lg text-icon-base hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
                  aria-label={language.t("command.session.new")}
                  onClick={() => startSession(false)}
                >
                  <Icon name="plus" size="small" />
                </button>

                {/* Prompt enhance — rewrites the draft with the default model; disabled until
                    there is text to improve (the tooltip says so). */}
                <Tooltip
                  placement="top"
                  value={draft().trim() ? language.t("home.enhance") : language.t("home.enhance.empty")}
                >
                  <button
                    type="button"
                    disabled={enhancing() || !draft().trim()}
                    class="flex size-7 items-center justify-center rounded-lg text-icon-base hover:bg-surface-raised-base-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
                    aria-label={language.t("home.enhance")}
                    onClick={enhanceDraft}
                  >
                    <Icon name="prompt" size="small" classList={{ "animate-pulse": enhancing() }} />
                  </button>
                </Tooltip>

                {/* Permission mode (ZCode's hand menu) — real: fabula-permissions.json */}
                <PmodeMenu />

                <div class="flex-1" />

                {/* Default model (ZCode's model menu incl. Manage models) — real: launch config */}
                <DropdownMenu>
                  <DropdownMenu.Trigger
                    as="button"
                    class="flex h-7 items-center gap-1 rounded-lg px-2 text-[13px] text-text-base hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
                  >
                    <span class="max-w-48 truncate">{modelLabel()}</span>
                    <Icon name="chevron-down" size="small" class="shrink-0 text-icon-weak-base" />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content class="min-w-72 max-h-[60vh] overflow-y-auto no-scrollbar">
                      <div class="sticky top-0 z-10 bg-surface-raised-base px-1 pb-1">
                        <div class="relative">
                          <span class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-weak">
                            <Icon name="magnifying-glass" size="small" />
                          </span>
                          <input
                            type="text"
                            value={modelQuery()}
                            onInput={(e) => setModelQuery(e.currentTarget.value)}
                            onKeyDown={(e) => e.stopPropagation()}
                            placeholder={language.t("home.model.search")}
                            spellcheck={false}
                            class="h-8 w-full rounded-lg border border-border-weak-base bg-background-base pl-7 pr-2 text-[13px] text-text-strong outline-none placeholder:text-text-weak focus:border-text-interactive-base"
                          />
                        </div>
                      </div>
                      <For each={modelGroups()}>
                        {(group) => (
                          <>
                            <div class="px-2.5 pt-2 pb-1 text-[11px] font-medium text-text-weak">{group.provider}</div>
                            <For each={group.options}>
                              {(option) => (
                                <DropdownMenu.Item closeOnSelect onSelect={() => void setModel(option.value)}>
                                  <div class="flex w-full items-center gap-2 min-w-0">
                                    <DropdownMenu.ItemLabel>
                                      <span class="min-w-0 truncate">{option.label}</span>
                                    </DropdownMenu.ItemLabel>
                                    <Show when={model() === option.value}>
                                      <Icon name="check-small" size="small" class="ml-auto shrink-0 text-icon-base" />
                                    </Show>
                                  </div>
                                </DropdownMenu.Item>
                              )}
                            </For>
                          </>
                        )}
                      </For>
                      <Show when={modelOptions().length === 0}>
                        <div class="px-2.5 py-3 text-[13px] text-text-weak">{language.t("palette.empty")}</div>
                      </Show>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item onSelect={openModelSettings}>
                        <DropdownMenu.ItemLabel>{language.t("home.model.manage")}</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>

                <button
                  type="button"
                  class="flex size-7 items-center justify-center rounded-lg bg-surface-base hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
                  aria-label={language.t("command.session.new")}
                  onClick={() => startSession(true)}
                >
                  <Icon name="arrow-up" size="small" class="text-icon-base" />
                </button>
              </div>
            </div>
          </div>

        </Match>
        <Match when={!sync.ready}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>
            <Button class="px-3" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
        <Match when={true}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <Icon name="folder-add-left" size="large" />
            <div class="flex flex-col gap-1 items-center justify-center">
              <div class="text-14-medium text-text-strong">{language.t("home.empty.title")}</div>
              <div class="text-12-regular text-text-weak">{language.t("home.empty.description")}</div>
            </div>
            <Button class="px-3 mt-1" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
      </Switch>
    </div>
    </Show>
  )
}
