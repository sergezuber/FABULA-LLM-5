import { Component, createSignal, onCleanup, Show } from "solid-js"
import { Dialog } from "@mimo-ai/ui/dialog"
import { Button } from "@mimo-ai/ui/button"
import { useDialog } from "@mimo-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { requestEngineRestart } from "@/context/host-bridge"

/**
 * "A newer version exists" → the installation updated and the engine restarted.
 *
 * The indicator used to open the release page, and the reader said what they expected instead: that it
 * would just update and restart. They were right — the install is a git clone, so the update is a pull
 * and the build this project already has. The release page is still one click away for anyone who wants
 * to read what changed first.
 *
 * The work runs DETACHED in the engine (`scripts/self-update.ts`), which is why this polls rather than
 * awaits: a build takes minutes and the window must stay usable while it happens.
 */
export const DialogUpdate: Component<{ version: string; url: string }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const platform = usePlatform()
  const [step, setStep] = createSignal<string>("")
  const [failed, setFailed] = createSignal<string>("")
  const [done, setDone] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  let timer: ReturnType<typeof setInterval> | undefined
  onCleanup(() => timer && clearInterval(timer))

  const poll = async () => {
    const res = await fetch("/global/fabula/update/status").catch(() => undefined)
    const body = (await res?.json().catch(() => undefined)) as { status?: { state: string; step: string; detail?: string } } | undefined
    const s = body?.status
    if (!s) return
    setStep(s.step)
    if (s.state === "failed") {
      // The reason travels verbatim. "It failed" sends someone to a log they do not know they have.
      setFailed(s.detail ?? s.step)
      setBusy(false)
      timer && clearInterval(timer)
    }
    if (s.state === "done") {
      setDone(true)
      setBusy(false)
      timer && clearInterval(timer)
    }
  }

  const start = async () => {
    setBusy(true)
    setFailed("")
    const res = await fetch("/global/fabula/update/apply", { method: "POST" }).catch(() => undefined)
    const body = (await res?.json().catch(() => undefined)) as { started?: boolean; reason?: string } | undefined
    if (!body?.started) {
      setFailed(body?.reason ?? language.t("common.requestFailed"))
      setBusy(false)
      return
    }
    timer = setInterval(() => void poll(), 2000)
    void poll()
  }

  return (
    <Dialog title={language.t("update.dialog.title", { version: props.version })}>
      <div class="flex flex-col gap-4 p-4 max-w-[520px]">
        <p class="text-[13px] text-text-base">{language.t("update.dialog.body")}</p>

        <Show when={busy()}>
          <p class="text-[13px] text-text-weak">{language.t(`update.step.${step()}`)}</p>
        </Show>
        <Show when={failed()}>
          <p class="text-[13px] text-icon-error-base whitespace-pre-wrap">{failed()}</p>
        </Show>
        <Show when={done()}>
          <p class="text-[13px] text-icon-success-base">{language.t("update.dialog.done")}</p>
        </Show>

        <div class="flex items-center gap-2 justify-end">
          <Button size="large" variant="ghost" onClick={() => platform.openLink(props.url)}>
            {language.t("update.dialog.notes")}
          </Button>
          <Show
            when={!done()}
            fallback={
              <Button size="large" onClick={() => requestEngineRestart()}>
                {language.t("update.dialog.restart")}
              </Button>
            }
          >
            <Button size="large" disabled={busy()} onClick={() => void start()}>
              {busy() ? language.t("update.dialog.working") : language.t("update.dialog.start")}
            </Button>
          </Show>
          <Button size="large" variant="ghost" onClick={() => dialog.close()}>
            {language.t("update.dialog.later")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
