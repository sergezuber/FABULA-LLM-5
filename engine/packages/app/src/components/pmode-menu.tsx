// FABULA: shared permission-mode selector — the SAME control on Home and in every session
// composer, so access settings are always one click away. Reads/writes fabula-permissions.json
// via the /global/fabula/pmode engine routes (the security plugin's guards enforce the mode).
import { createResource, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { DropdownMenu } from "@mimo-ai/ui/dropdown-menu"
import { Icon, type IconProps } from "@mimo-ai/ui/icon"
import { useLanguage } from "@/context/language"

export type Pmode = "default" | "acceptEdits" | "plan" | "bypass"
export const PMODES: { id: Pmode; icon: IconProps["name"] }[] = [
  { id: "default", icon: "eye" },
  { id: "acceptEdits", icon: "edit-small-2" },
  { id: "plan", icon: "checklist" },
  { id: "bypass", icon: "circle-ban-sign" },
]

export async function fetchPmode(): Promise<Pmode | undefined> {
  const res = await fetch("/global/fabula/pmode").catch(() => undefined)
  // Return undefined (not "default") on failure so the resource's `.latest` keeps the last good
  // value instead of visibly snapping the label/checkmark back to "default".
  if (!res?.ok) return undefined
  return ((await res.json()) as { mode: Pmode }).mode
}

// The access mode is the ONE mode switch of the app: "Plan mode" also drives the
// engine's plan agent (the separate Build/Plan selector was removed as a duplicate), so
// consumers can react to changes via onModeChange.
export function PmodeMenu(props: {
  triggerClass?: string
  triggerStyle?: JSX.CSSProperties
  onSelected?: () => void
  onModeChange?: (mode: Pmode) => void
}) {
  const language = useLanguage()
  const [pmode, { mutate, refetch }] = createResource(fetchPmode)
  // External writers (e.g. the plan-approval dock) broadcast mode changes so every mounted
  // menu keeps its label in sync without polling.
  onMount(() => {
    const onExternal = (e: Event) => {
      const mode = (e as CustomEvent<Pmode>).detail
      if (mode) mutate(mode)
    }
    window.addEventListener("fabula:pmode-changed", onExternal)
    onCleanup(() => window.removeEventListener("fabula:pmode-changed", onExternal))
  })
  const setPmode = async (mode: Pmode) => {
    mutate(mode)
    props.onModeChange?.(mode)
    await fetch("/global/fabula/pmode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    }).catch(() => undefined)
    props.onSelected?.()
  }
  return (
    <DropdownMenu onOpenChange={(open) => open && void refetch()}>
      <DropdownMenu.Trigger
        as="button"
        class={
          props.triggerClass ??
          "flex h-7 items-center gap-1 rounded-lg px-2 text-[13px] text-text-base hover:bg-surface-raised-base-hover transition-colors cursor-pointer"
        }
        style={props.triggerStyle}
      >
        <Icon
          name={PMODES.find((m) => m.id === (pmode.latest ?? "default"))?.icon ?? "eye"}
          size="small"
          class="shrink-0 text-icon-base"
        />
        <span class="max-w-40 truncate">{language.t(`home.pmode.${pmode.latest ?? "default"}.title` as never)}</span>
        <Icon name="chevron-down" size="small" class="shrink-0 text-icon-weak-base" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="min-w-72">
          <For each={PMODES}>
            {(m) => (
              <DropdownMenu.Item onSelect={() => void setPmode(m.id)}>
                <div class="flex w-full items-start gap-2.5 py-0.5">
                  <Icon name={m.icon} size="small" class="mt-0.5 shrink-0 text-icon-base" />
                  <div class="flex min-w-0 flex-col">
                    <span class="text-[13px] text-text-strong">
                      {language.t(`home.pmode.${m.id}.title` as never)}
                    </span>
                    <span class="text-[12px] text-text-weak">{language.t(`home.pmode.${m.id}.desc` as never)}</span>
                  </div>
                  <Show when={(pmode.latest ?? "default") === m.id}>
                    <Icon name="check-small" size="small" class="ml-auto mt-0.5 shrink-0 text-icon-base" />
                  </Show>
                </div>
              </DropdownMenu.Item>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
