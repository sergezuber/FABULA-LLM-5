import { createMemo, For, Show } from "solid-js"
import type { PermissionRequest } from "@mimo-ai/sdk/v2"
import { Button } from "@mimo-ai/ui/button"
import { DockPrompt } from "@mimo-ai/ui/dock-prompt"
import { Icon } from "@mimo-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()
  const sync = useSync()

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  // Preview of WHAT the tool is about to do (reference-client behaviour): resolve the pending
  // tool part by callID and show the command / file / input instead of a bare pattern list.
  const preview = createMemo(() => {
    const ref = props.request.tool
    if (!ref) return undefined
    const parts = sync.data.part[ref.messageID] ?? []
    const part = parts.find(
      (p) => p.type === "tool" && (p as { callID?: string }).callID === ref.callID,
    ) as { tool?: string; state?: { input?: Record<string, unknown> } } | undefined
    const input = part?.state?.input
    if (!input) return undefined
    const tool = part?.tool ?? props.request.permission
    if (typeof input.command === "string") return { kind: "command" as const, text: `$ ${input.command}` }
    const file = (input.filePath ?? input.path ?? input.file) as string | undefined
    if (/edit|write|patch|create/.test(tool) && file) {
      const oldStr = typeof input.oldString === "string" ? input.oldString : ""
      const newStr = typeof input.newString === "string" ? input.newString : typeof input.content === "string" ? input.content : ""
      const body = [
        oldStr && `− ${oldStr.split("\n").slice(0, 6).join("\n− ")}`,
        newStr && `+ ${newStr.split("\n").slice(0, 6).join("\n+ ")}`,
      ]
        .filter(Boolean)
        .join("\n")
      return { kind: "file" as const, file, text: body }
    }
    const json = JSON.stringify(input, null, 1)
    return { kind: "json" as const, text: json.length > 600 ? json.slice(0, 600) + "…" : json }
  })

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Button
              variant="secondary"
              size="normal"
              onClick={() => props.onDecide("always")}
              disabled={props.responding}
            >
              {language.t("ui.permission.allowAlways")}
            </Button>
            <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.patterns}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>

      <Show when={preview()} keyed>
        {(p) => (
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div class="min-w-0 flex-1">
              <Show when={p.kind === "file"}>
                <div class="pb-1 font-mono text-[12px] text-text-strong break-all">{(p as { file?: string }).file}</div>
              </Show>
              <Show when={p.text}>
                <pre class="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-base/60 p-2 font-mono text-[11px] leading-4 text-text-base">
                  {p.text}
                </pre>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </DockPrompt>
  )
}
