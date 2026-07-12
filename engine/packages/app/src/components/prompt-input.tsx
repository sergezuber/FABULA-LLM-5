import { useFilteredList } from "@mimo-ai/ui/hooks"
import { showToast } from "@mimo-ai/ui/toast"
import { useSpring } from "@mimo-ai/ui/motion-spring"
import { createEffect, on, Component, Show, onCleanup, createMemo, createSignal, createResource, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { selectionFromLines, type SelectedLineRange, useFile } from "@/context/file"
import {
  ContentPart,
  DEFAULT_PROMPT,
  isPromptEqual,
  Prompt,
  usePrompt,
  ImageAttachmentPart,
  AgentPart,
  FileAttachmentPart,
} from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useComments } from "@/context/comments"
import { Button } from "@mimo-ai/ui/button"
import { DockShellForm, DockTray } from "@mimo-ai/ui/dock-surface"
import { Icon } from "@mimo-ai/ui/icon"
import { ProviderIcon } from "@mimo-ai/ui/provider-icon"
import { Tooltip, TooltipKeybind } from "@mimo-ai/ui/tooltip"
import { IconButton } from "@mimo-ai/ui/icon-button"
import { Select } from "@mimo-ai/ui/select"
import { useDialog } from "@mimo-ai/ui/context/dialog"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
import { PmodeMenu, fetchPmode, type Pmode } from "@/components/pmode-menu"
import { useProviders } from "@/hooks/use-providers"
import { useCommand } from "@/context/command"
import { Persist, persisted } from "@/utils/persist"
import { usePermission } from "@/context/permission"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"
import { createTextFragment, getCursorPosition, setCursorPosition, setRangeEdge } from "./prompt-input/editor-dom"
import { createPromptAttachments } from "./prompt-input/attachments"
import { ACCEPTED_FILE_TYPES } from "./prompt-input/files"
import {
  canNavigateHistoryAtCursor,
  navigatePromptHistory,
  prependHistoryEntry,
  type PromptHistoryComment,
  type PromptHistoryEntry,
  type PromptHistoryStoredEntry,
  promptLength,
} from "./prompt-input/history"
import { createPromptSubmit, HOME_AUTOSUBMIT_KEY, HOME_MODEL_KEY, type FollowupDraft } from "./prompt-input/submit"
import { getSpeechRecognitionCtor } from "@/utils/runtime-adapters"
import { PromptPopover, type AtOption, type AgentOption, type SlashCommand } from "./prompt-input/slash-popover"
import { PromptContextItems } from "./prompt-input/context-items"
import { BuddyWidget } from "@/components/buddy-widget"
import { PromptImageAttachments } from "./prompt-input/image-attachments"
import { PromptDragOverlay } from "./prompt-input/drag-overlay"
import { promptPlaceholder } from "./prompt-input/placeholder"
import { ImagePreview } from "@mimo-ai/ui/image-preview"
import { useQueries, useQuery } from "@tanstack/solid-query"
import { loadAgentsQuery, loadProvidersQuery } from "@/context/global-sync/bootstrap"

interface PromptInputProps {
  class?: string
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  edit?: { id: string; prompt: Prompt; context: FollowupDraft["context"] }
  onEditLoaded?: () => void
  shouldQueue?: () => boolean
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
}

const EXAMPLES = [
  "prompt.example.1",
  "prompt.example.2",
  "prompt.example.3",
  "prompt.example.4",
  "prompt.example.5",
  "prompt.example.6",
  "prompt.example.7",
  "prompt.example.8",
  "prompt.example.9",
  "prompt.example.10",
  "prompt.example.11",
  "prompt.example.12",
  "prompt.example.13",
  "prompt.example.14",
  "prompt.example.15",
  "prompt.example.16",
  "prompt.example.17",
  "prompt.example.18",
  "prompt.example.19",
  "prompt.example.20",
  "prompt.example.21",
  "prompt.example.22",
  "prompt.example.23",
  "prompt.example.24",
  "prompt.example.25",
] as const

const NON_EMPTY_TEXT = /[^\s\u200B]/

export const PromptInput: Component<PromptInputProps> = (props) => {
  const sdk = useSDK()

  const sync = useSync()
  const local = useLocal()
  const files = useFile()
  const prompt = usePrompt()
  const layout = useLayout()
  const comments = useComments()
  const dialog = useDialog()
  const providers = useProviders()
  const command = useCommand()
  const permission = usePermission()
  const language = useLanguage()
  const platform = usePlatform()
  const { params, tabs, view } = useSessionLayout()
  let editorRef!: HTMLDivElement
  let fileInputRef: HTMLInputElement | undefined
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement

  const mirror = { input: false }
  const inset = 56
  const space = `${inset}px`

  const scrollCursorIntoView = () => {
    const container = scrollRef
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const cursor = getCursorPosition(editorRef)
    const length = promptLength(prompt.current().filter((part) => part.type !== "image"))
    if (cursor >= length) {
      container.scrollTop = container.scrollHeight
      return
    }

    const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - inset) {
      container.scrollTop = bottom - container.clientHeight + inset
    }
  }

  const queueScroll = (count = 2) => {
    requestAnimationFrame(() => {
      scrollCursorIntoView()
      if (count > 1) queueScroll(count - 1)
    })
  }

  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: files.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? files.tab(tab) : tab),
  }).activeFileTab

  const commentInReview = (path: string) => {
    const sessionID = params.id
    if (!sessionID) return false

    const diffs = sync.data.session_diff[sessionID]
    if (!diffs) return false
    return diffs.some((diff) => diff.file === path)
  }

  const openComment = (item: { path: string; commentID?: string; commentOrigin?: "review" | "file" }) => {
    if (!item.commentID) return

    const focus = { file: item.path, id: item.commentID }
    comments.setActive(focus)

    const queueCommentFocus = (attempts = 6) => {
      const schedule = (left: number) => {
        requestAnimationFrame(() => {
          comments.setFocus({ ...focus })
          if (left <= 0) return
          requestAnimationFrame(() => {
            const current = comments.focus()
            if (!current) return
            if (current.file !== focus.file || current.id !== focus.id) return
            schedule(left - 1)
          })
        })
      }

      schedule(attempts)
    }

    const wantsReview = item.commentOrigin === "review" || (item.commentOrigin !== "file" && commentInReview(item.path))
    if (wantsReview) {
      if (!view().reviewPanel.opened()) view().reviewPanel.open()
      layout.fileTree.setTab("changes")
      tabs().setActive("review")
      queueCommentFocus()
      return
    }

    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    layout.fileTree.setTab("all")
    const tab = files.tab(item.path)
    void tabs().open(tab)
    tabs().setActive(tab)
    void Promise.resolve(files.load(item.path)).finally(() => queueCommentFocus())
  }

  const recent = createMemo(() => {
    const all = tabs().all()
    const active = activeFileTab()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })
  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const status = createMemo(
    () =>
      sync.data.session_status[params.id ?? ""] ?? {
        type: "idle",
      },
  )
  const working = createMemo(() => status()?.type !== "idle")
  const imageAttachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )

  const [store, setStore] = createStore<{
    popover: "at" | "agent" | "slash" | null
    historyIndex: number
    savedPrompt: PromptHistoryEntry | null
    placeholder: number
    draggingType: "image" | "@mention" | null
    mode: "normal" | "shell"
    applyingHistory: boolean
  }>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null as PromptHistoryEntry | null,
    placeholder: Math.floor(Math.random() * EXAMPLES.length),
    draggingType: null,
    mode: "normal",
    applyingHistory: false,
  })

  const buttonsSpring = useSpring(() => (store.mode === "normal" ? 1 : 0), { visualDuration: 0.2, bounce: 0 })
  const motion = (value: number) => ({
    opacity: value,
    transform: `scale(${0.95 + value * 0.05})`,
    filter: `blur(${(1 - value) * 2}px)`,
    "pointer-events": value > 0.5 ? ("auto" as const) : ("none" as const),
  })
  const buttons = createMemo(() => motion(buttonsSpring()))
  const shell = createMemo(() => motion(1 - buttonsSpring()))
  const control = createMemo(() => ({ height: "28px", ...buttons() }))

  const commentCount = createMemo(() => {
    if (store.mode === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const blank = createMemo(() => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && imageAttachments().length === 0 && commentCount() === 0
  })
  const stopping = createMemo(() => working() && blank())
  const tip = () => {
    if (stopping()) {
      return (
        <div class="flex items-center gap-2">
          <span>{language.t("prompt.action.stop")}</span>
          <span class="text-icon-base text-12-medium text-[10px]!">{language.t("common.key.esc")}</span>
        </div>
      )
    }

    return (
      <div class="flex items-center gap-2">
        <span>{language.t("prompt.action.send")}</span>
        <Icon name="enter" size="small" class="text-icon-base" />
      </div>
    )
  }

  const contextItems = createMemo(() => {
    const items = prompt.context.items()
    if (store.mode !== "shell") return items
    return items.filter((item) => !item.comment?.trim())
  })

  const hasUserPrompt = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return false
    const messages = sync.data.message[sessionID]
    if (!messages) return false
    return messages.some((m) => m.role === "user")
  })

  const [history, setHistory] = persisted(
    Persist.global("prompt-history", ["prompt-history.v1"]),
    createStore<{
      entries: PromptHistoryStoredEntry[]
    }>({
      entries: [],
    }),
  )
  const [shellHistory, setShellHistory] = persisted(
    Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]),
    createStore<{
      entries: PromptHistoryStoredEntry[]
    }>({
      entries: [],
    }),
  )

  const suggest = createMemo(() => !hasUserPrompt())

  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: store.mode,
      commentCount: commentCount(),
      example: suggest() ? language.t(EXAMPLES[store.placeholder]) : "",
      suggest: suggest(),
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
    }),
  )

  const historyComments = () => {
    const byID = new Map(comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return prompt.context.items().flatMap((item) => {
      if (item.type !== "file") return []
      const comment = item.comment?.trim()
      if (!comment) return []

      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? ({
              start: item.selection.startLine,
              end: item.selection.endLine,
            } satisfies SelectedLineRange)
          : undefined)
      if (!nextSelection) return []

      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }

  const applyHistoryComments = (items: PromptHistoryComment[]) => {
    comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    prompt.context.replaceComments(
      items.map((item) => ({
        type: "file" as const,
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const applyHistoryPrompt = (entry: PromptHistoryEntry, position: "start" | "end") => {
    const p = entry.prompt
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    applyHistoryComments(entry.comments)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      editorRef.focus()
      setCursorPosition(editorRef, length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

  const getCaretState = () => {
    const selection = window.getSelection()
    const textLength = promptLength(prompt.current())
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !editorRef.contains(anchorNode)) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPosition(editorRef),
      textLength,
    }
  }

  const escBlur = () => platform.platform === "desktop" && platform.os === "macos"

  const pick = () => fileInputRef?.click()

  const setMode = (mode: "normal" | "shell") => {
    setStore("mode", mode)
    setStore("popover", null)
    requestAnimationFrame(() => editorRef?.focus())
  }

  const shellModeKey = "mod+shift+x"
  const normalModeKey = "mod+shift+e"

  command.register("prompt-input", () => [
    {
      id: "file.attach",
      title: language.t("prompt.action.attachFile"),
      category: language.t("command.category.file"),
      keybind: "mod+u",
      disabled: store.mode !== "normal",
      onSelect: pick,
    },
    {
      id: "prompt.mode.shell",
      title: language.t("command.prompt.mode.shell"),
      category: language.t("command.category.session"),
      keybind: shellModeKey,
      disabled: store.mode === "shell",
      onSelect: () => setMode("shell"),
    },
    {
      id: "prompt.mode.normal",
      title: language.t("command.prompt.mode.normal"),
      category: language.t("command.category.session"),
      keybind: normalModeKey,
      disabled: store.mode === "normal",
      onSelect: () => setMode("normal"),
    },
  ])

  const closePopover = () => setStore("popover", null)

  const resetHistoryNavigation = (force = false) => {
    if (!force && (store.historyIndex < 0 || store.applyingHistory)) return
    setStore("historyIndex", -1)
    setStore("savedPrompt", null)
  }

  const clearEditor = () => {
    editorRef.innerHTML = ""
  }

  const setEditorText = (text: string) => {
    clearEditor()
    editorRef.textContent = text
  }

  const focusEditorEnd = () => {
    requestAnimationFrame(() => {
      editorRef.focus()
      const range = document.createRange()
      const selection = window.getSelection()
      range.selectNodeContents(editorRef)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  }

  const currentCursor = () => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) return null
    return getCursorPosition(editorRef)
  }

  const restoreFocus = () => {
    requestAnimationFrame(() => {
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      editorRef.focus()
      setCursorPosition(editorRef, cursor)
      queueScroll()
    })
  }

  const renderEditorWithCursor = (parts: Prompt) => {
    const cursor = currentCursor()
    renderEditor(parts)
    if (cursor !== null) setCursorPosition(editorRef, cursor)
  }

  createEffect(() => {
    params.id
    if (params.id) return
    if (!suggest()) return
    const interval = setInterval(() => {
      setStore("placeholder", (prev) => (prev + 1) % EXAMPLES.length)
    }, 6500)
    onCleanup(() => clearInterval(interval))
  })

  const [composing, setComposing] = createSignal(false)
  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  const handleBlur = () => {
    closePopover()
    setComposing(false)
  }

  const handleCompositionStart = () => {
    setComposing(true)
  }

  const handleCompositionEnd = () => {
    setComposing(false)
    requestAnimationFrame(() => {
      if (composing()) return
      reconcile(prompt.current().filter((part) => part.type !== "image"))
    })
  }

  const agentList = createMemo(() =>
    sync.data.agent
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent): AgentOption => ({ name: agent.name, display: agent.name })),
  )

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
  }

  const atKey = (x: AtOption | undefined) => (x ? `file:${x.path}` : "")

  const {
    flat: atFlat,
    active: atActive,
    setActive: setAtActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const open = recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ path, display: path, recent: true }))
      if (!query.trim()) return pinned
      const paths = await files.searchFilesAndDirectories(query)
      const fileOptions: AtOption[] = paths.filter((path) => !seen.has(path)).map((path) => ({ path, display: path }))
      return [...pinned, ...fileOptions]
    },
    key: atKey,
    filterKeys: ["display"],
    groupBy: (item) => (item.recent ? "recent" : "file"),
    sortGroupsBy: (a, b) => (a.category === "recent" ? 0 : 1) - (b.category === "recent" ? 0 : 1),
    onSelect: handleAtSelect,
  })

  const handleAgentSelect = (option: AgentOption | undefined) => {
    if (!option) return
    addPart({ type: "agent", name: option.name, content: "$" + option.name, start: 0, end: 0 })
  }

  const agentKey = (x: AgentOption | undefined) => (x ? `agent:${x.name}` : "")

  const {
    flat: agentFlat,
    active: agentActive,
    setActive: setAgentActive,
    onInput: agentOnInput,
    onKeyDown: agentOnKeyDown,
  } = useFilteredList<AgentOption>({
    items: () => agentList(),
    key: agentKey,
    filterKeys: ["display"],
    onSelect: handleAgentSelect,
  })

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const builtin = command.options
      .filter((opt) => !opt.disabled && !opt.id.startsWith("suggested.") && opt.slash)
      .map((opt) => ({
        id: opt.id,
        trigger: opt.slash!,
        title: opt.title,
        description: opt.description,
        keybind: opt.keybind,
        type: "builtin" as const,
      }))

    const custom = sync.data.command.map((cmd) => ({
      id: `custom.${cmd.name}`,
      trigger: cmd.name,
      title: cmd.name,
      description: cmd.description,
      type: "custom" as const,
      source: cmd.source,
    }))

    return [...custom, ...builtin]
  })

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    closePopover()
    const images = imageAttachments()

    if (cmd.type === "custom") {
      const text = `/${cmd.trigger} `
      setEditorText(text)
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }, ...images], text.length)
      focusEditorEnd()
      return
    }

    clearEditor()
    prompt.set([...DEFAULT_PROMPT, ...images], 0)
    command.trigger(cmd.id, "slash")
  }

  const {
    flat: slashFlat,
    active: slashActive,
    setActive: setSlashActive,
    onInput: slashOnInput,
    onKeyDown: slashOnKeyDown,
  } = useFilteredList<SlashCommand>({
    items: slashCommands,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title"],
    onSelect: handleSlashSelect,
  })

  const createPill = (part: FileAttachmentPart | AgentPart) => {
    const pill = document.createElement("span")
    pill.textContent = part.content
    pill.setAttribute("data-type", part.type)
    if (part.type === "file") pill.setAttribute("data-path", part.path)
    if (part.type === "agent") pill.setAttribute("data-name", part.name)
    pill.setAttribute("contenteditable", "false")
    pill.style.userSelect = "text"
    pill.style.cursor = "default"
    return pill
  }

  const isNormalizedEditor = () =>
    Array.from(editorRef.childNodes).every((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ""
        if (!text.includes("\u200B")) return true
        if (text !== "\u200B") return false

        const prev = node.previousSibling
        const next = node.nextSibling
        const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
        return !!prevIsBr && !next
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      if (el.dataset.type === "file") return true
      if (el.dataset.type === "agent") return true
      return el.tagName === "BR"
    })

  const renderEditor = (parts: Prompt) => {
    clearEditor()
    for (const part of parts) {
      if (part.type === "text") {
        editorRef.appendChild(createTextFragment(part.content))
        continue
      }
      if (part.type === "file" || part.type === "agent") {
        editorRef.appendChild(createPill(part))
      }
    }

    const last = editorRef.lastChild
    if (last?.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") {
      editorRef.appendChild(document.createTextNode("\u200B"))
    }
  }

  // Auto-scroll active command into view when navigating with keyboard
  createEffect(() => {
    const activeId = slashActive()
    if (!activeId || !slashPopoverRef) return

    requestAnimationFrame(() => {
      const element = slashPopoverRef.querySelector(`[data-slash-id="${activeId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  })
  const selectPopoverActive = () => {
    if (store.popover === "at") {
      const items = atFlat()
      if (items.length === 0) return
      const active = atActive()
      const item = items.find((entry) => atKey(entry) === active) ?? items[0]
      handleAtSelect(item)
      return
    }

    if (store.popover === "agent") {
      const items = agentFlat()
      if (items.length === 0) return
      const active = agentActive()
      const item = items.find((entry) => agentKey(entry) === active) ?? items[0]
      handleAgentSelect(item)
      return
    }

    if (store.popover === "slash") {
      const items = slashFlat()
      if (items.length === 0) return
      const active = slashActive()
      const item = items.find((entry) => entry.id === active) ?? items[0]
      handleSlashSelect(item)
    }
  }

  const reconcile = (input: Prompt) => {
    if (mirror.input) {
      mirror.input = false
      if (isNormalizedEditor()) return

      renderEditorWithCursor(input)
      return
    }

    const dom = parseFromDOM()
    if (isNormalizedEditor() && isPromptEqual(input, dom)) return

    renderEditorWithCursor(input)
  }

  createEffect(
    on(
      () => prompt.current(),
      (parts) => {
        if (composing()) return
        reconcile(parts.filter((part) => part.type !== "image"))
      },
    ),
  )

  const parseFromDOM = (): Prompt => {
    const parts: Prompt = []
    let position = 0
    let buffer = ""

    const flushText = () => {
      let content = buffer
      if (content.includes("\r")) content = content.replace(/\r\n?/g, "\n")
      if (content.includes("\u200B")) content = content.replace(/\u200B/g, "")
      buffer = ""
      if (!content) return
      parts.push({ type: "text", content, start: position, end: position + content.length })
      position += content.length
    }

    const pushFile = (file: HTMLElement) => {
      const content = file.textContent ?? ""
      parts.push({
        type: "file",
        path: file.dataset.path!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const pushAgent = (agent: HTMLElement) => {
      const content = agent.textContent ?? ""
      parts.push({
        type: "agent",
        name: agent.dataset.name!,
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
    }

    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        buffer += node.textContent ?? ""
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return

      const el = node as HTMLElement
      if (el.dataset.type === "file") {
        flushText()
        pushFile(el)
        return
      }
      if (el.dataset.type === "agent") {
        flushText()
        pushAgent(el)
        return
      }
      if (el.tagName === "BR") {
        buffer += "\n"
        return
      }

      for (const child of Array.from(el.childNodes)) {
        visit(child)
      }
    }

    const children = Array.from(editorRef.childNodes)
    children.forEach((child, index) => {
      const isBlock = child.nodeType === Node.ELEMENT_NODE && ["DIV", "P"].includes((child as HTMLElement).tagName)
      visit(child)
      if (isBlock && index < children.length - 1) {
        buffer += "\n"
      }
    })

    flushText()

    if (parts.length === 0) parts.push(...DEFAULT_PROMPT)
    return parts
  }

  const handleInput = () => {
    const rawParts = parseFromDOM()
    const images = imageAttachments()
    const cursorPosition = getCursorPosition(editorRef)
    const rawText =
      rawParts.length === 1 && rawParts[0]?.type === "text"
        ? rawParts[0].content
        : rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const shouldReset = !NON_EMPTY_TEXT.test(rawText) && !hasNonText && images.length === 0

    if (shouldReset) {
      closePopover()
      resetHistoryNavigation()
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      queueScroll()
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const beforeCursor = rawText.substring(0, cursorPosition)
      const atMatch = beforeCursor.match(/@(\S*)$/)
      const agentMatch = beforeCursor.match(/\$(\S*)$/)
      const slashMatch = rawText.match(/^\/(\S*)$/)

      if (agentMatch) {
        agentOnInput(agentMatch[1])
        setStore("popover", "agent")
      } else if (atMatch) {
        atOnInput(atMatch[1])
        setStore("popover", "at")
      } else if (slashMatch) {
        slashOnInput(slashMatch[1])
        setStore("popover", "slash")
      } else {
        closePopover()
      }
    } else {
      closePopover()
    }

    resetHistoryNavigation()

    mirror.input = true
    prompt.set([...rawParts, ...images], cursorPosition)
    queueScroll()
  }

  const addPart = (part: ContentPart) => {
    if (part.type === "image") return false

    const selection = window.getSelection()
    if (!selection) return false

    if (selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) {
      editorRef.focus()
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      setCursorPosition(editorRef, cursor)
    }

    if (selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return false

    if (part.type === "file" || part.type === "agent") {
      const cursorPosition = getCursorPosition(editorRef)
      const rawText = prompt
        .current()
        .map((p) => ("content" in p ? p.content : ""))
        .join("")
      const textBeforeCursor = rawText.substring(0, cursorPosition)
      const triggerMatch = textBeforeCursor.match(part.type === "agent" ? /\$(\S*)$/ : /@(\S*)$/)
      const pill = createPill(part)
      const gap = document.createTextNode(" ")

      if (triggerMatch) {
        const start = triggerMatch.index ?? cursorPosition - triggerMatch[0].length
        setRangeEdge(editorRef, range, "start", start)
        setRangeEdge(editorRef, range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    if (part.type === "text") {
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          const isBreak = last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR"
          const next = last.nextSibling
          const emptyText = next?.nodeType === Node.TEXT_NODE && (next.textContent ?? "") === ""
          if (isBreak && (!next || emptyText)) {
            const placeholder = next && emptyText ? next : document.createTextNode("\u200B")
            if (!next) last.parentNode?.insertBefore(placeholder, null)
            placeholder.textContent = "\u200B"
            range.setStart(placeholder, 0)
          } else {
            range.setStartAfter(last)
          }
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    closePopover()
    return true
  }

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    const currentHistory = mode === "shell" ? shellHistory : history
    const setCurrentHistory = mode === "shell" ? setShellHistory : setHistory
    const next = prependHistoryEntry(currentHistory.entries, prompt, mode === "shell" ? [] : historyComments())
    if (next === currentHistory.entries) return
    setCurrentHistory("entries", next)
  }

  createEffect(
    on(
      () => props.edit?.id,
      (id) => {
        const edit = props.edit
        if (!id || !edit) return

        for (const item of prompt.context.items()) {
          prompt.context.remove(item.key)
        }

        for (const item of edit.context) {
          prompt.context.add({
            type: item.type,
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          })
        }

        setStore("mode", "normal")
        setStore("popover", null)
        setStore("historyIndex", -1)
        setStore("savedPrompt", null)
        prompt.set(edit.prompt, promptLength(edit.prompt))
        requestAnimationFrame(() => {
          editorRef.focus()
          setCursorPosition(editorRef, promptLength(edit.prompt))
          queueScroll()
        })
        props.onEditLoaded?.()
      },
      { defer: true },
    ),
  )

  const navigateHistory = (direction: "up" | "down") => {
    const result = navigatePromptHistory({
      direction,
      entries: store.mode === "shell" ? shellHistory.entries : history.entries,
      historyIndex: store.historyIndex,
      currentPrompt: prompt.current(),
      currentComments: historyComments(),
      savedPrompt: store.savedPrompt,
    })
    if (!result.handled) return false
    setStore("historyIndex", result.historyIndex)
    setStore("savedPrompt", result.savedPrompt)
    applyHistoryPrompt(result.entry, result.cursor)
    return true
  }

  const { addAttachments, removeAttachment, handlePaste } = createPromptAttachments({
    editor: () => editorRef,
    isDialogActive: () => !!dialog.active,
    setDraggingType: (type) => setStore("draggingType", type),
    focusEditor: () => {
      editorRef.focus()
      setCursorPosition(editorRef, promptLength(prompt.current()))
    },
    addPart,
    readClipboardImage: platform.readClipboardImage,
  })

  const variants = createMemo(() => ["default", ...local.model.variant.list()])

    // FABULA: the access mode is the app's single mode switch — "Plan mode" maps to the
  // engine's plan agent, every other mode to build. The Build/Plan agent selector was removed as
  // a duplicate; every chat aligns its agent to the global mode on mount and on change.
  const [planMode, setPlanMode] = createSignal(false)
  const alignAgentToPmode = (mode: Pmode) => {
    setPlanMode(mode === "plan")
    const want = mode === "plan" ? "plan" : "build"
    if (local.agent.current()?.name === want) return
    if (!local.agent.list().some((agent) => agent.name === want)) return
    local.agent.set(want)
  }
  // Plan-approval dock (reference-client behaviour): once the plan agent finishes a turn in plan
  // mode, offer to approve — flips the mode back to default and kicks off the implementation.
  const [planDismissedID, setPlanDismissedID] = createSignal("")
  const planReadyID = createMemo(() => {
    if (!planMode() || working()) return ""
    const id = params.id
    if (!id) return ""
    const messages = sync.data.message[id] ?? []
    const last = messages[messages.length - 1]
    if (!last || last.role !== "assistant") return ""
    const assistant = last as { id: string; agent?: string; error?: unknown; time?: { completed?: unknown } }
    if (typeof assistant.time?.completed !== "number") return ""
    if (assistant.error) return ""
    if (assistant.agent && assistant.agent !== "plan") return ""
    if (planDismissedID() === assistant.id) return ""
    return assistant.id
  })
  createEffect(() => {
    if (agentsLoading()) return
    void fetchPmode().then((mode) => alignAgentToPmode(mode ?? "default"))
  })

  // FABULA: dictation — Web Speech API when the host exposes it (hidden otherwise). Final
  // results append to the draft; the mic button pulses while listening.
  type Recognition = {
    lang: string
    continuous: boolean
    interimResults: boolean
    start: () => void
    stop: () => void
    onresult: ((e: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null
    onend: (() => void) | null
    onerror: (() => void) | null
  }
  const speechCtor = getSpeechRecognitionCtor<Recognition>(globalThis)
  const [listening, setListening] = createSignal(false)
  let recognition: Recognition | undefined
  const appendDictation = (transcript: string) => {
    const text = transcript.trim()
    if (!text) return
    const current = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    const next = current ? `${current} ${text}` : text
    setEditorText(next)
    prompt.set([{ type: "text", content: next, start: 0, end: next.length }], next.length)
  }
  const toggleDictation = () => {
    if (!speechCtor) return
    if (listening()) {
      recognition?.stop()
      return
    }
    recognition = new speechCtor()
    recognition.lang = document.documentElement.lang === "ru" ? "ru-RU" : "en-US"
    recognition.continuous = true
    recognition.interimResults = false
    recognition.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) appendDictation(e.results[i][0].transcript)
      }
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    setListening(true)
    recognition.start()
  }
  onCleanup(() => recognition?.stop())

  // FABULA: prompt enhance — same control as on Home, using the session's current model.
  // While a request is in flight the same button becomes a cancel control (AbortController),
  // and a failure surfaces as an error toast instead of silently keeping the draft.
  const [enhancing, setEnhancing] = createSignal(false)
  let enhanceAbort: AbortController | undefined
  const cancelEnhance = () => enhanceAbort?.abort()
  onCleanup(cancelEnhance)
  const enhanceDraft = async () => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
      .trim()
    if (!text || enhancing()) return
    setEnhancing(true)
    enhanceAbort = new AbortController()
    try {
      const current = local.model.current()
      const res = await fetch("/global/fabula/enhance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, model: current ? `${current.provider.id}/${current.id}` : undefined }),
        signal: enhanceAbort.signal,
      })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string }
      if (body.ok && body.text) {
        prompt.set([{ type: "text", content: body.text, start: 0, end: body.text.length }], body.text.length)
      } else {
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: body.error ?? `HTTP ${res.status}`,
        })
      }
    } catch (error) {
      // Cancel is the user's own action — only real failures get a toast.
      if (!(error instanceof DOMException && error.name === "AbortError"))
        showToast({ variant: "error", title: language.t("common.requestFailed"), description: String(error) })
    } finally {
      enhanceAbort = undefined
      setEnhancing(false)
    }
  }
  const accepting = createMemo(() => {
    const id = params.id
    if (!id) return permission.isAutoAcceptingDirectory(sdk.directory)
    return permission.isAutoAccepting(id, sdk.directory)
  })

  const { abort, handleSubmit } = createPromptSubmit({
    info,
    imageAttachments,
    commentCount,
    autoAccept: () => accepting(),
    mode: () => store.mode,
    working,
    editor: () => editorRef,
    queueScroll,
    promptLength,
    addToHistory,
    resetHistoryNavigation: () => {
      resetHistoryNavigation(true)
    },
    setMode: (mode) => setStore("mode", mode),
    setPopover: (popover) => setStore("popover", popover),
    newSessionWorktree: () => props.newSessionWorktree,
    onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
    shouldQueue: props.shouldQueue,
    onQueue: props.onQueue,
    onAbort: props.onAbort,
    onSubmit: props.onSubmit,
  })

  // FABULA: if the Home launcher SENT a draft (it seeds the text here and sets a one-shot flag),
  // submit it once the persisted draft has loaded — so send works on the FIRST press instead of
  // landing the user on a pre-filled composer they must submit again. Bounded poll (~1s); the flag
  // is cleared either way so it fires exactly once and never on the "+" (which sets no flag).
  // FABULA: pin the model the user picked on the Home launcher as THIS new session's model (highest-
  // priority slot), before any auto-submit — otherwise the composer's resolution falls back to the
  // agent/history model and the chat silently opens with a different model than the one selected.
  // New-session composer only (guarded on !params.id); consumed once.
  onMount(() => {
    try {
      if (params.id || typeof sessionStorage === "undefined") return
      const seeded = sessionStorage.getItem(HOME_MODEL_KEY)
      if (!seeded) return
      sessionStorage.removeItem(HOME_MODEL_KEY)
      const slash = seeded.indexOf("/")
      if (slash > 0) local.model.set({ providerID: seeded.slice(0, slash), modelID: seeded.slice(slash + 1) })
    } catch {}
  })

  onMount(() => {
    if (typeof sessionStorage === "undefined" || !sessionStorage.getItem(HOME_AUTOSUBMIT_KEY)) return
    let frames = 0
    const tryOnce = () => {
      // ~4s budget: on a fresh session the agent list + model resolve ASYNC (sync/providers load
      // after navigation). Submitting before they're ready just fires the "select an agent and
      // model" toast — the exact failure the user hit. Wait for all three, then submit once.
      if (frames++ > 240) {
        sessionStorage.removeItem(HOME_AUTOSUBMIT_KEY)
        return
      }
      const draftReady = !isPromptEqual(prompt.current(), DEFAULT_PROMPT)
      const modelReady = !!local.model.current()
      const agentReady = !!local.agent.current()
      if (!draftReady || !modelReady || !agentReady) {
        requestAnimationFrame(tryOnce)
        return
      }
      sessionStorage.removeItem(HOME_AUTOSUBMIT_KEY)
      void handleSubmit(new Event("submit", { cancelable: true }))
    }
    requestAnimationFrame(tryOnce)
  })

    // "Approve plan": mode -> default (persisted), agent -> build, then auto-send the kickoff.
  const approvePlan = async () => {
    setPlanDismissedID(planReadyID())
    await fetch("/global/fabula/pmode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "default" }),
    }).catch(() => {})
    alignAgentToPmode("default")
    window.dispatchEvent(new CustomEvent("fabula:pmode-changed", { detail: "default" }))
    const text = language.t("prompt.plan.approvedMessage")
    setEditorText(text)
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    await new Promise((resolve) => setTimeout(resolve, 30))
    void handleSubmit(new Event("submit", { cancelable: true }))
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "u") {
      event.preventDefault()
      if (store.mode !== "normal") return
      pick()
      return
    }

    if (event.key === "Backspace") {
      const selection = window.getSelection()
      if (selection && selection.isCollapsed) {
        const node = selection.anchorNode
        const offset = selection.anchorOffset
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? ""
          if (/^\u200B+$/.test(text) && offset > 0) {
            const range = document.createRange()
            range.setStart(node, 0)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
    }

    if (event.key === "!" && store.mode === "normal") {
      const cursorPosition = getCursorPosition(editorRef)
      if (cursorPosition === 0) {
        setStore("mode", "shell")
        setStore("popover", null)
        event.preventDefault()
        return
      }
    }

    if (event.key === "Escape") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (store.mode === "shell") {
        setStore("mode", "normal")
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (working()) {
        void abort()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (escBlur()) {
        editorRef.blur()
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
    }

    // Handle Shift+Enter BEFORE IME check - Shift+Enter is never used for IME input
    // and should always insert a newline regardless of composition state
    if (event.key === "Enter" && event.shiftKey) {
      addPart({ type: "text", content: "\n", start: 0, end: 0 })
      event.preventDefault()
      return
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (store.popover) {
      if (event.key === "Tab") {
        selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (store.popover === "at") {
          atOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "agent") {
          agentOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "slash") {
          slashOnKeyDown(event)
        }
        event.preventDefault()
        return
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        return
      }
      if (working()) {
        void abort()
        event.preventDefault()
      }
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = getCaretState()
      if (!collapsed) return

      const cursorPosition = getCursorPosition(editorRef)
      const textContent = prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (!canNavigateHistoryAtCursor(direction, textContent, cursorPosition, store.historyIndex >= 0)) return
      if (navigateHistory(direction)) {
        event.preventDefault()
      }
      return
    }

    // Note: Shift+Enter is handled earlier, before IME check
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (event.repeat) return
      if (
        working() &&
        prompt
          .current()
          .map((part) => ("content" in part ? part.content : ""))
          .join("")
          .trim().length === 0 &&
        imageAttachments().length === 0 &&
        commentCount() === 0
      ) {
        return
      }
      void handleSubmit(event)
    }
  }

  const [agentsQuery, globalProvidersQuery, providersQuery] = useQueries(() => ({
    queries: [loadAgentsQuery(sdk.directory), loadProvidersQuery(null), loadProvidersQuery(sdk.directory)],
  }))

  const agentsLoading = () => agentsQuery.isLoading
  const providersLoading = () => agentsLoading() || providersQuery.isLoading || globalProvidersQuery.isLoading

  const [promptReady] = createResource(
    () => prompt.ready().promise,
    (p) => p,
    // initialValue keeps this "refreshing" not "pending", so it never registers with the app-wide
    // <Suspense> AT CREATION (a pending resource registers regardless of whether its accessor is read).
    // Combined with the `.latest`-only read below, the composer never blanks to the Splash on a
    // session/directory switch. The null seed is inert (the read only keeps the resource warm).
    { initialValue: null },
  )

  return (
    <div class="relative size-full _max-h-[320px] flex flex-col gap-0">
      {/* `.latest`, not the raw accessor: this read exists only to keep the resource warm. Reading the
          raw accessor re-suspends the app-wide ConnectionGate <Suspense> (full-window Splash) whenever
          prompt.ready() yields a new promise on session/directory switch — the project-switch flash. */}
      {(promptReady.latest, null)}
      <PromptPopover
        popover={store.popover}
        setSlashPopoverRef={(el) => (slashPopoverRef = el)}
        atFlat={atFlat()}
        atActive={atActive() ?? undefined}
        atKey={atKey}
        setAtActive={setAtActive}
        onAtSelect={handleAtSelect}
        agentFlat={agentFlat()}
        agentActive={agentActive() ?? undefined}
        agentKey={agentKey}
        setAgentActive={setAgentActive}
        onAgentSelect={handleAgentSelect}
        slashFlat={slashFlat()}
        slashActive={slashActive() ?? undefined}
        setSlashActive={setSlashActive}
        onSlashSelect={handleSlashSelect}
        commandKeybind={command.keybind}
        t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      />
      <Show when={planReadyID()}>
        <div class="mb-1.5 flex items-center gap-3 rounded-xl border border-border-weak-base bg-surface-base px-3 py-2">
          <span class="min-w-0 flex-1 truncate text-[13px] text-text-strong">
            {language.t("prompt.plan.readyTitle")}
          </span>
          <button
            type="button"
            class="shrink-0 cursor-pointer text-[13px] font-medium text-text-interactive-base underline-offset-2 hover:underline"
            onClick={() => void approvePlan()}
          >
            {language.t("prompt.plan.approve")}
          </button>
          <button
            type="button"
            class="shrink-0 cursor-pointer text-[13px] text-text-weak underline-offset-2 hover:underline"
            onClick={() => setPlanDismissedID(planReadyID())}
          >
            {language.t("prompt.plan.keepPlanning")}
          </button>
        </div>
      </Show>
      {/* FABULA Buddy — living pixel pet on the composer's top edge (walks/reacts to session state). */}
      <BuddyWidget working={working} directory={() => sdk.directory} />
      <DockShellForm
        onSubmit={(e: Event) => {
          // Only wave on a REAL send — not on an empty submit or an Enter-to-stop (both are blank()).
          try { if (!blank()) window.dispatchEvent(new CustomEvent("fabula-buddy", { detail: { kind: "send" } })) } catch {}
          return handleSubmit(e)
        }}
        classList={{
          "group/prompt-input": true,
          "focus-within:shadow-xs-border": true,
          "border-icon-info-active border-dashed": store.draggingType !== null,
          [props.class ?? ""]: !!props.class,
        }}
      >
        <PromptDragOverlay
          type={store.draggingType}
          label={language.t(store.draggingType === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label")}
        />
        <PromptContextItems
          items={contextItems()}
          active={(item) => {
            const active = comments.active()
            return !!item.commentID && item.commentID === active?.id && item.path === active?.file
          }}
          openComment={openComment}
          remove={(item) => {
            if (item.commentID) comments.remove(item.path, item.commentID)
            prompt.context.remove(item.key)
          }}
          t={(key) => language.t(key as Parameters<typeof language.t>[0])}
        />
        <PromptImageAttachments
          attachments={imageAttachments()}
          onOpen={(attachment) =>
            dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />)
          }
          onRemove={removeAttachment}
          removeLabel={language.t("prompt.attachment.remove")}
        />
        <div
          class="relative"
          onMouseDown={(e) => {
            const target = e.target
            if (!(target instanceof HTMLElement)) return
            if (target.closest('[data-action="prompt-attach"], [data-action="prompt-submit"]')) {
              return
            }
            editorRef?.focus()
          }}
        >
          <div
            class="relative max-h-[240px] overflow-y-auto no-scrollbar"
            ref={(el) => (scrollRef = el)}
            style={{ "scroll-padding-bottom": space }}
          >
            <div
              data-component="prompt-input"
              ref={(el) => {
                editorRef = el
                props.ref?.(el)
              }}
              role="textbox"
              aria-multiline="true"
              aria-label={placeholder()}
              contenteditable="true"
              autocapitalize={store.mode === "normal" ? "sentences" : "off"}
              autocorrect={store.mode === "normal" ? "on" : "off"}
              spellcheck={store.mode === "normal"}
              inputMode="text"
              // @ts-expect-error
              autocomplete="off"
              onInput={handleInput}
              onPaste={handlePaste}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              classList={{
                "select-text": true,
                "w-full pl-3 pr-2 pt-2 text-14-regular text-text-strong focus:outline-none whitespace-pre-wrap": true,
                "[&_[data-type=file]]:text-syntax-property": true,
                "[&_[data-type=agent]]:text-syntax-type": true,
                "font-mono!": store.mode === "shell",
              }}
              style={{ "padding-bottom": space }}
            />
            <div
              class="absolute top-0 inset-x-0 pl-3 pr-2 pt-2 text-14-regular text-text-weak pointer-events-none whitespace-nowrap truncate"
              classList={{ "font-mono!": store.mode === "shell" }}
              style={{ "padding-bottom": space, display: prompt.dirty() ? "none" : undefined }}
            >
              {placeholder()}
            </div>
          </div>

          <div
            aria-hidden="true"
            class="pointer-events-none absolute inset-x-0 bottom-0"
            style={{
              height: space,
              background:
                "linear-gradient(to top, var(--surface-raised-stronger-non-alpha) calc(100% - 20px), transparent)",
            }}
          />

          <div class="pointer-events-none absolute bottom-2 right-2 flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_FILE_TYPES.join(",")}
              class="hidden"
              onChange={(e) => {
                const list = e.currentTarget.files
                if (list) void addAttachments(Array.from(list))
                e.currentTarget.value = ""
              }}
            />

            <div class="flex items-center gap-1 pointer-events-auto">
              <Tooltip placement="top" inactive={!working() && blank()} value={tip()}>
                <IconButton
                  data-action="prompt-submit"
                  type="submit"
                  disabled={store.mode !== "normal" || (!working() && blank())}
                  tabIndex={store.mode === "normal" ? undefined : -1}
                  icon={stopping() ? "stop" : "arrow-up"}
                  variant="primary"
                  class="size-8"
                  style={buttons()}
                  aria-label={stopping() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
                />
              </Tooltip>
            </div>
          </div>

          <div class="pointer-events-none absolute bottom-2 left-2">
            <div
              aria-hidden={store.mode !== "normal"}
              class="pointer-events-auto"
              style={{
                "pointer-events": buttonsSpring() > 0.5 ? "auto" : "none",
              }}
            >
              <TooltipKeybind
                placement="top"
                title={language.t("prompt.action.attachFile")}
                keybind={command.keybind("file.attach")}
              >
                <Button
                  data-action="prompt-attach"
                  type="button"
                  variant="ghost"
                  class="size-8 p-0"
                  style={buttons()}
                  onClick={pick}
                  disabled={store.mode !== "normal"}
                  tabIndex={store.mode === "normal" ? undefined : -1}
                  aria-label={language.t("prompt.action.attachFile")}
                >
                  <Icon name="plus" class="size-4.5" />
                </Button>
              </TooltipKeybind>
            </div>
          </div>
        </div>
      </DockShellForm>
      <Show when={store.mode === "normal" || store.mode === "shell"}>
        <DockTray attach="top">
          <div class="px-1.75 pt-5.5 pb-2 flex items-center gap-2 min-w-0">
            <div class="flex items-center gap-1.5 min-w-0 flex-1 relative">
              <div
                class="h-7 flex items-center gap-1.5 max-w-[160px] min-w-0 absolute inset-y-0 left-0"
                style={{
                  padding: "0 4px 0 8px",
                  ...shell(),
                }}
              >
                <span class="truncate text-13-medium text-text-strong">{language.t("prompt.mode.shell")}</span>
                <div class="size-4 shrink-0" />
              </div>
              <div class="flex items-center gap-1.5 min-w-0 flex-1 h-7">
                <Show when={store.mode !== "shell"}>
                  <div data-component="prompt-pmode-control" style={{ animation: "fade-in 0.3s" }}>
                    <PmodeMenu
                      triggerClass="flex h-7 items-center gap-1 rounded-lg px-2 text-13-regular text-text-base hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
                      triggerStyle={control()}
                      onSelected={restoreFocus}
                      onModeChange={alignAgentToPmode}
                    />
                  </div>
                </Show>
                <Show when={!providersLoading()}>
                  <Show when={store.mode !== "shell"}>
                    <div data-component="prompt-model-control" style={{ animation: "fade-in 0.3s" }}>
                      <Show
                        when={providers.paid().length > 0}
                        fallback={
                          <TooltipKeybind
                            placement="top"
                            gutter={4}
                            title={language.t("command.model.choose")}
                            keybind={command.keybind("model.choose")}
                          >
                            <Button
                              data-action="prompt-model"
                              as="div"
                              variant="ghost"
                              size="normal"
                              class="min-w-0 max-w-[320px] text-13-regular text-text-base group"
                              style={control()}
                              onClick={() => {
                                void import("@/components/dialog-select-model-unpaid").then((x) => {
                                  dialog.show(() => <x.DialogSelectModelUnpaid model={local.model} />)
                                })
                              }}
                            >
                              <Show when={local.model.current()?.provider?.id}>
                                <ProviderIcon
                                  id={local.model.current()?.provider?.id ?? ""}
                                  class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                                  style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                                />
                              </Show>
                              <span class="truncate">
                                {local.model.current()?.name ?? language.t("dialog.model.select.title")}
                              </span>
                              <Icon name="chevron-down" size="small" class="shrink-0" />
                            </Button>
                          </TooltipKeybind>
                        }
                      >
                        <TooltipKeybind
                          placement="top"
                          gutter={4}
                          title={language.t("command.model.choose")}
                          keybind={command.keybind("model.choose")}
                        >
                          <ModelSelectorPopover
                            model={local.model}
                            triggerAs={Button}
                            triggerProps={{
                              variant: "ghost",
                              size: "normal",
                              style: control(),
                              class: "min-w-0 max-w-[320px] text-13-regular text-text-base group",
                              "data-action": "prompt-model",
                            }}
                            onClose={restoreFocus}
                          >
                            <Show when={local.model.current()?.provider?.id}>
                              <ProviderIcon
                                id={local.model.current()?.provider?.id ?? ""}
                                class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                                style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                              />
                            </Show>
                            <span class="truncate">
                              {local.model.current()?.name ?? language.t("dialog.model.select.title")}
                            </span>
                            <Icon name="chevron-down" size="small" class="shrink-0" />
                          </ModelSelectorPopover>
                        </TooltipKeybind>
                      </Show>
                    </div>
                    <div data-component="prompt-variant-control" style={{ animation: "fade-in 0.3s" }}>
                      <TooltipKeybind
                        placement="top"
                        gutter={4}
                        title={language.t("command.model.variant.cycle")}
                        keybind={command.keybind("model.variant.cycle")}
                      >
                        <Select
                          size="normal"
                          options={variants()}
                          current={local.model.variant.current() ?? "default"}
                          label={(x) => (x === "default" ? language.t("common.default") : x)}
                          onSelect={(value) => {
                            local.model.variant.set(value === "default" ? undefined : value)
                            restoreFocus()
                          }}
                          class="capitalize max-w-[160px] text-text-base"
                          valueClass="truncate text-13-regular text-text-base"
                          triggerStyle={control()}
                          triggerProps={{ "data-action": "prompt-model-variant" }}
                          variant="ghost"
                        />
                      </TooltipKeybind>
                    </div>
                    <Show when={speechCtor}>
                      <div data-component="prompt-dictation-control" style={{ animation: "fade-in 0.3s" }}>
                        <Tooltip
                          placement="top"
                          gutter={4}
                          value={listening() ? language.t("prompt.dictation.stop") : language.t("prompt.dictation.start")}
                        >
                          <Button
                            type="button"
                            variant="ghost"
                            size="normal"
                            class="size-7 p-0"
                            style={control()}
                            onClick={toggleDictation}
                            aria-label={language.t("prompt.dictation.start")}
                          >
                            <Icon
                              name="microphone"
                              size="small"
                              classList={{ "animate-pulse text-text-danger-base": listening() }}
                            />
                          </Button>
                        </Tooltip>
                      </div>
                    </Show>
                    <div data-component="prompt-enhance-control" style={{ animation: "fade-in 0.3s" }}>
                      <Tooltip placement="top" gutter={4} value={language.t("home.enhance")}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="normal"
                          class="size-7 p-0"
                          style={control()}
                          disabled={!enhancing() && !prompt.dirty()}
                          onClick={() => (enhancing() ? cancelEnhance() : void enhanceDraft())}
                          aria-label={language.t("home.enhance")}
                        >
                          <Icon
                            name={enhancing() ? "close-small" : "prompt"}
                            size="small"
                            classList={{ "animate-pulse": enhancing() }}
                          />
                        </Button>
                      </Tooltip>
                    </div>
                  </Show>
                </Show>
              </div>
            </div>
          </div>
        </DockTray>
      </Show>
    </div>
  )
}
