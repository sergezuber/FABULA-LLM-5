// FABULA: git toolbar for the Review panel — branch popover with filter + inline create, per-file
// stage/unstage/discard with checkboxes (Staged/Unstaged/Untracked sections), commit with an
// AI-generated message when the field is empty, push, and readable errors with a copy button.
// Backed by /global/fabula/git/* routes (direct git shell-outs). Hidden when the dir is not a repo.
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { Button } from "@mimo-ai/ui/button"
import { DropdownMenu } from "@mimo-ai/ui/dropdown-menu"
import { Icon } from "@mimo-ai/ui/icon"
import { useLanguage } from "@/context/language"

type GitFile = { path: string; staged: boolean; unstaged: boolean; untracked: boolean }
type GitState = {
  ok: boolean
  branch?: string
  branches?: string[]
  changes?: number
  files?: GitFile[]
  ahead?: number
  behind?: number
  hasUpstream?: boolean
}

export function GitReviewBar(props: { dir: string }) {
  const language = useLanguage()
  const [state, { refetch, mutate }] = createResource(
    () => props.dir,
    async (dir) => {
      const res = await fetch(`/global/fabula/git/state?dir=${encodeURIComponent(dir)}`).catch(() => undefined)
      if (!res?.ok) return { ok: false } as GitState
      return (await res.json()) as GitState
    },
    // initialValue makes this resource start "ready" (then "refreshing") instead of "pending" on mount.
    // A "pending" resource registers with the nearest <Suspense> AT CREATION (independent of any accessor
    // read) — mounting this bar during the new→session navigation registered a ~90ms git shell-out with
    // the app-wide RouterRoot <Suspense>, blanking the content pane right after Send (the send flicker).
    // "refreshing" never triggers a Suspense fallback, and every read here already goes through `.latest`.
    { initialValue: { ok: false } as GitState },
  )
  const [busy, setBusy] = createSignal<string | undefined>(undefined)
  const [message, setMessage] = createSignal("")
  const [note, setNote] = createSignal("")
  const [errorText, setErrorText] = createSignal("")
  const [filesOpen, setFilesOpen] = createSignal(false)
  const [selected, setSelected] = createSignal<Set<string>>(new Set<string>())
  const [branchFilter, setBranchFilter] = createSignal("")
  const [creatingBranch, setCreatingBranch] = createSignal(false)
  const [newBranch, setNewBranch] = createSignal("")

  const files = createMemo(() => state.latest?.files ?? [])
  const staged = createMemo(() => files().filter((f) => f.staged))
  const unstaged = createMemo(() => files().filter((f) => f.unstaged && !f.untracked))
  const untracked = createMemo(() => files().filter((f) => f.untracked))
  const selectedFiles = createMemo(() => files().filter((f) => selected().has(f.path)))
  const filteredBranches = createMemo(() => {
    const q = branchFilter().trim().toLowerCase()
    const list = state.latest?.branches ?? []
    return q ? list.filter((b) => b.toLowerCase().includes(q)) : list
  })

  const toggleSelect = (path: string) => {
    const next = new Set(selected())
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setSelected(next)
  }

  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(`/global/fabula/git/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: props.dir, ...body }),
    }).catch(() => undefined)
    return (await res?.json().catch(() => ({}))) as { ok?: boolean; message?: string; output?: string; error?: string }
  }

  const finish = (out: { ok?: boolean; message?: string; output?: string; error?: string }, okNote: string) => {
    if (out.ok) {
      setNote(okNote)
      setErrorText("")
    } else {
      setNote(language.t("session.git.failed"))
      setErrorText(out.error ?? out.output ?? "")
    }
    setSelected(new Set<string>())
    setBusy(undefined)
    void refetch()
  }

  const stageSelected = async (stage: boolean) => {
    const paths = selectedFiles()
      .filter((f) => (stage ? !f.staged || f.unstaged : f.staged))
      .map((f) => f.path)
    if (!paths.length || busy()) return
    setBusy(stage ? "stage" : "unstage")
    finish(await post("stage", { files: paths, stage }), "✓")
  }

  const discardSelected = async () => {
    const tracked = selectedFiles()
      .filter((f) => !f.untracked)
      .map((f) => f.path)
    const untrackedPaths = selectedFiles()
      .filter((f) => f.untracked)
      .map((f) => f.path)
    if ((!tracked.length && !untrackedPaths.length) || busy()) return
    if (!window.confirm(language.t("session.git.discardConfirm", { count: tracked.length + untrackedPaths.length })))
      return
    setBusy("discard")
    finish(await post("discard", { files: tracked, untracked: untrackedPaths }), "✓")
  }

  const commit = async () => {
    if (busy()) return
    setBusy("commit")
    setNote(message().trim() ? "" : language.t("session.git.generating"))
    const out = await post("commit", { message: message().trim() || undefined })
    if (out.ok) setMessage("")
    finish(out, `✓ ${out.message ?? ""}`)
  }

  const push = async () => {
    if (busy()) return
    setBusy("push")
    setNote("")
    finish(await post("push", {}), language.t("session.git.pushed"))
  }

  const switchBranch = async (branch: string, create?: boolean) => {
    if (busy()) return
    setBusy("switch")
    setCreatingBranch(false)
    setNewBranch("")
    finish(await post("switch", { branch, create }), "✓")
  }

  const copyError = () => {
    void navigator.clipboard?.writeText(errorText())
    setNote(language.t("session.git.copied"))
  }

  const fileRow = (file: GitFile, badge: string) => (
    <label class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-raised-base-hover">
      <input
        type="checkbox"
        checked={selected().has(file.path)}
        onChange={() => toggleSelect(file.path)}
        class="size-3.5 shrink-0 accent-[var(--text-interactive-base)]"
      />
      <span class="min-w-0 flex-1 truncate text-[12px] text-text-strong">{file.path}</span>
      <span class="shrink-0 text-[10px] uppercase tracking-wide text-text-weak">{badge}</span>
    </label>
  )

  const section = (title: string, list: GitFile[], badge: string) => (
    <Show when={list.length > 0}>
      <div class="flex flex-col gap-0.5">
        <div class="px-2 pt-1 text-[11px] font-medium text-text-weak">
          {title} · {list.length}
        </div>
        <For each={list}>{(file) => fileRow(file, badge)}</For>
      </div>
    </Show>
  )

  return (
    <Show when={state.latest?.ok}>
      <div class="flex flex-col gap-1 border-b border-border-weaker-base px-3 py-2">
        <div class="flex min-w-0 items-center gap-2">
          <DropdownMenu onOpenChange={(open) => open && setBranchFilter("")}>
            <DropdownMenu.Trigger
              as="button"
              class="flex h-7 min-w-0 items-center gap-1 rounded-lg px-2 text-[13px] text-text-base hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
            >
              <Icon name="branch" size="small" class="shrink-0 text-icon-base" />
              <span class="min-w-0 max-w-40 truncate">{state.latest?.branch}</span>
              <Icon name="chevron-down" size="small" class="shrink-0 text-icon-weak-base" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="min-w-64 max-h-[50vh] overflow-y-auto no-scrollbar">
                <div class="sticky top-0 z-10 bg-surface-raised-base px-1 pb-1">
                  <input
                    type="text"
                    value={branchFilter()}
                    onInput={(e) => setBranchFilter(e.currentTarget.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder={language.t("session.git.branchFilter")}
                    spellcheck={false}
                    class="h-7 w-full rounded-lg border border-border-weak-base bg-background-base px-2 text-[12px] text-text-strong outline-none placeholder:text-text-weak focus:border-text-interactive-base"
                  />
                </div>
                <For each={filteredBranches()}>
                  {(branch) => (
                    <DropdownMenu.Item onSelect={() => void switchBranch(branch)}>
                      <div class="flex w-full items-center gap-2 min-w-0">
                        <DropdownMenu.ItemLabel>
                          <span class="min-w-0 truncate">{branch}</span>
                        </DropdownMenu.ItemLabel>
                        <Show when={state.latest?.branch === branch}>
                          <Icon name="check-small" size="small" class="ml-auto shrink-0 text-icon-base" />
                        </Show>
                      </div>
                    </DropdownMenu.Item>
                  )}
                </For>
                <Show when={filteredBranches().length === 0}>
                  <div class="px-2.5 py-2 text-[12px] text-text-weak">{language.t("palette.empty")}</div>
                </Show>
                <DropdownMenu.Separator />
                <DropdownMenu.Item onSelect={() => setCreatingBranch(true)}>
                  <DropdownMenu.ItemLabel>{language.t("session.git.newBranch")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>

          <button
            type="button"
            class="flex h-7 shrink-0 items-center gap-1 rounded-lg px-2 text-[12px] text-text-weak hover:bg-surface-raised-base-hover hover:text-text-strong transition-colors cursor-pointer"
            onClick={() => setFilesOpen((v) => !v)}
          >
            {language.t("session.git.changes", { count: state.latest?.changes ?? 0 })}
            <Icon
              name="chevron-down"
              size="small"
              class="shrink-0"
              style={{ transform: `rotate(${filesOpen() ? 180 : 0}deg)`, transition: "transform 120ms" }}
            />
          </button>

          <div class="flex-1" />

          <Button
            size="small"
            variant="secondary"
            disabled={!!busy() || (state.latest?.changes ?? 0) === 0}
            onClick={() => void commit()}
          >
            {busy() === "commit" ? language.t("session.git.committing") : language.t("session.git.commit")}
          </Button>
          <Button size="small" variant="ghost" disabled={!!busy()} onClick={() => void push()}>
            {busy() === "push"
              ? language.t("session.git.pushing")
              : (state.latest?.ahead ?? 0) > 0
                ? `${language.t("session.git.push")} ↑${state.latest?.ahead}`
                : language.t("session.git.push")}
          </Button>
        </div>

        <Show when={creatingBranch()}>
          <div class="flex items-center gap-2">
            <input
              type="text"
              value={newBranch()}
              onInput={(e) => setNewBranch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newBranch().trim()) void switchBranch(newBranch().trim(), true)
                if (e.key === "Escape") setCreatingBranch(false)
              }}
              ref={(el) => queueMicrotask(() => el.focus())}
              placeholder={language.t("session.git.newBranchPrompt")}
              spellcheck={false}
              class="h-7 min-w-0 flex-1 rounded-lg border border-text-interactive-base bg-background-base px-2 text-[12px] text-text-strong outline-none placeholder:text-text-weak"
            />
            <Button
              size="small"
              disabled={!newBranch().trim() || !!busy()}
              onClick={() => void switchBranch(newBranch().trim(), true)}
            >
              {language.t("settings.registry.create")}
            </Button>
            <Button size="small" variant="ghost" onClick={() => setCreatingBranch(false)}>
              {language.t("settings.registry.cancel")}
            </Button>
          </div>
        </Show>

        <Show when={filesOpen() && files().length > 0}>
          <div class="flex max-h-56 flex-col gap-1 overflow-y-auto fabula-scrollbar rounded-lg border border-border-weaker-base p-1">
            {section(language.t("session.git.section.staged"), staged(), "S")}
            {section(language.t("session.git.section.unstaged"), unstaged(), "M")}
            {section(language.t("session.git.section.untracked"), untracked(), "U")}
          </div>
          <div class="flex items-center gap-1.5">
            <span class="text-[11px] text-text-weak">
              {language.t("session.git.selected", { count: selectedFiles().length })}
            </span>
            <div class="flex-1" />
            <Button
              size="small"
              variant="ghost"
              disabled={!!busy() || selectedFiles().length === 0}
              onClick={() => void stageSelected(true)}
            >
              {language.t("session.git.stage")}
            </Button>
            <Button
              size="small"
              variant="ghost"
              disabled={!!busy() || selectedFiles().every((f) => !f.staged)}
              onClick={() => void stageSelected(false)}
            >
              {language.t("session.git.unstage")}
            </Button>
            <Button
              size="small"
              variant="ghost"
              class="text-text-danger-base"
              disabled={!!busy() || selectedFiles().length === 0}
              onClick={() => void discardSelected()}
            >
              {language.t("session.git.discard")}
            </Button>
          </div>
        </Show>

        <input
          type="text"
          value={message()}
          onInput={(e) => setMessage(e.currentTarget.value)}
          placeholder={language.t("session.git.messagePlaceholder")}
          spellcheck={false}
          class="h-7 w-full rounded-lg border border-border-weaker-base bg-background-base px-2 text-[12px] text-text-strong outline-none placeholder:text-text-weak focus:border-text-interactive-base"
        />
        <Show when={note()}>
          <div class="truncate text-[12px] text-text-weak">{note()}</div>
        </Show>
        <Show when={errorText()}>
          <div class="flex flex-col gap-1 rounded-lg border border-border-weaker-base bg-surface-base/40 p-2">
            <pre class="max-h-28 overflow-y-auto fabula-scrollbar whitespace-pre-wrap break-all font-mono text-[11px] leading-4 text-text-danger-base">
              {errorText()}
            </pre>
            <div class="flex justify-end">
              <Button size="small" variant="ghost" onClick={copyError}>
                {language.t("session.git.copyError")}
              </Button>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}
