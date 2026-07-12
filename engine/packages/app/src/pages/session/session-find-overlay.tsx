// FABULA: in-session find (⌘F, reference-client behaviour) — searches the text parts of the
// open session, shows "N of M", Enter/Shift+Enter (or arrows) walks hits, each hit scrolls the
// timeline to its turn anchor ([data-message-id]) and flashes a highlight ring.
import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { IconButton } from "@mimo-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"

export function SessionFindOverlay(props: { sessionID: string; open: boolean; onClose: () => void }) {
  const language = useLanguage()
  const sync = useSync()
  const [query, setQuery] = createSignal("")
  const [index, setIndex] = createSignal(0)
  let inputRef: HTMLInputElement | undefined

  const hits = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (q.length < 2) return [] as { messageID: string; snippet: string }[]
    const out: { messageID: string; snippet: string }[] = []
    // Timeline anchors ([data-message-id]) sit on the TURN wrapper keyed by the turn's USER
    // message id — map assistant-text hits back to the turn anchor.
    let turnAnchor = ""
    for (const message of sync.data.message[props.sessionID] ?? []) {
      if (message.role === "user") turnAnchor = message.id
      const anchor = turnAnchor || message.id
      const parts = sync.data.part[message.id] ?? []
      for (const part of parts) {
        if (part.type !== "text") continue
        const text = (part as { text?: string }).text ?? ""
        const at = text.toLowerCase().indexOf(q)
        if (at < 0) continue
        const from = Math.max(0, at - 40)
        out.push({
          messageID: anchor,
          snippet: (from > 0 ? "…" : "") + text.slice(from, at + q.length + 40).replace(/\s+/g, " "),
        })
        break // one hit per message keeps the walk predictable
      }
    }
    // Collapse multiple hits inside one turn to a single stop.
    return out.filter((hit, i) => i === 0 || out[i - 1].messageID !== hit.messageID)
  })

  const goto = (i: number) => {
    const list = hits()
    if (!list.length) return
    const next = ((i % list.length) + list.length) % list.length
    setIndex(next)
    const target = document.querySelector(`[data-message-id="${list[next].messageID}"]`)
    if (!(target instanceof HTMLElement)) return
    target.scrollIntoView({ block: "center" })
    target.classList.add("fabula-find-flash")
    setTimeout(() => target.classList.remove("fabula-find-flash"), 1600)
  }

  createEffect(
    on(hits, (list) => {
      setIndex(0)
      if (list.length) goto(0)
    }),
  )
  createEffect(() => {
    if (props.open) queueMicrotask(() => inputRef?.focus())
  })

  return (
    <Show when={props.open}>
      <div class="absolute right-4 top-2 z-40 flex items-center gap-1 rounded-xl border border-border-weak-base bg-background-base px-2 py-1.5 shadow-md">
        <input
          ref={inputRef}
          type="text"
          value={query()}
          placeholder={language.t("session.find.placeholder")}
          spellcheck={false}
          class="h-6 w-48 bg-transparent text-[13px] text-text-strong outline-none placeholder:text-text-weak"
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") goto(index() + (e.shiftKey ? -1 : 1))
            if (e.key === "Escape") props.onClose()
            e.stopPropagation()
          }}
        />
        <span class="shrink-0 tabular-nums text-[11px] text-text-weak">
          {hits().length ? `${index() + 1} / ${hits().length}` : query().trim().length >= 2 ? "0" : ""}
        </span>
        <IconButton
          icon="chevron-left"
          variant="ghost"
          class="size-6 rotate-90"
          onClick={() => goto(index() - 1)}
        />
        <IconButton icon="chevron-down" variant="ghost" class="size-6" onClick={() => goto(index() + 1)} />
        <IconButton icon="circle-x" variant="ghost" class="size-6" onClick={() => props.onClose()} />
      </div>
    </Show>
  )
}
