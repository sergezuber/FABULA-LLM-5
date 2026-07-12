// FABULA: first-run onboarding — a short multi-step wizard shown once on Home
// (flag `fabula.onboarded` in localStorage): welcome → project folder → models → tips.
import { createMemo, createSignal, For, Show } from "solid-js"
import { Button } from "@mimo-ai/ui/button"
import { Dialog } from "@mimo-ai/ui/dialog"
import { Icon } from "@mimo-ai/ui/icon"
import { Mark } from "@mimo-ai/ui/logo"
import { useDialog } from "@mimo-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useProviders } from "@/hooks/use-providers"
import { useServer } from "@/context/server"

export const ONBOARDED_KEY = "fabula.onboarded"

export function markOnboarded() {
  try {
    window.localStorage.setItem(ONBOARDED_KEY, "1")
  } catch {
    /* private mode — the wizard will simply show again */
  }
}

export function OnboardingDialog() {
  const dialog = useDialog()
  const language = useLanguage()
  const layout = useLayout()
  const platform = usePlatform()
  const providers = useProviders()
  const server = useServer()
  const [step, setStep] = createSignal(0)
  const [pickedDir, setPickedDir] = createSignal<string | undefined>(undefined)

  const modelCount = createMemo(() =>
    providers.connected().reduce((total, p) => total + Object.keys(p.models ?? {}).length, 0),
  )

  const finish = () => {
    markOnboarded()
    dialog.close()
  }

  const pickFolder = async () => {
    if (!platform.openDirectoryPickerDialog || !server.isLocal()) return
    const picked = await platform.openDirectoryPickerDialog({ title: language.t("command.project.open") })
    const dir = Array.isArray(picked) ? picked[0] : picked
    if (!dir) return
    setPickedDir(dir)
    layout.projects.open(dir)
    server.projects.touch(dir)
  }

  const steps = [
    () => (
      <div class="flex flex-col items-center gap-4 text-center">
        <Mark class="w-12" />
        <h2 class="text-2xl font-semibold tracking-tight text-text-strong">{language.t("onboarding.welcome.title")}</h2>
        <p class="max-w-md text-[13px] leading-6 text-text-weak">{language.t("onboarding.welcome.body")}</p>
      </div>
    ),
    () => (
      <div class="flex flex-col items-center gap-4 text-center">
        <Icon name="folder" size="large" class="text-icon-base" />
        <h2 class="text-xl font-semibold tracking-tight text-text-strong">{language.t("onboarding.project.title")}</h2>
        <p class="max-w-md text-[13px] leading-6 text-text-weak">{language.t("onboarding.project.body")}</p>
        <Button icon="folder-add-left" onClick={() => void pickFolder()}>
          {pickedDir() ? `✓ ${pickedDir()!.split("/").pop()}` : language.t("home.project.open")}
        </Button>
      </div>
    ),
    () => (
      <div class="flex flex-col items-center gap-4 text-center">
        <Icon name="brain" size="large" class="text-icon-base" />
        <h2 class="text-xl font-semibold tracking-tight text-text-strong">{language.t("onboarding.models.title")}</h2>
        <p class="max-w-md text-[13px] leading-6 text-text-weak">
          {language.t("onboarding.models.body", { count: modelCount() })}
        </p>
      </div>
    ),
    () => (
      <div class="flex flex-col items-center gap-4 text-center">
        <Icon name="checklist" size="large" class="text-icon-base" />
        <h2 class="text-xl font-semibold tracking-tight text-text-strong">{language.t("onboarding.tips.title")}</h2>
        <ul class="flex max-w-md flex-col gap-2 text-left text-[13px] leading-6 text-text-weak">
          <li>{language.t("onboarding.tips.newSession")}</li>
          <li>{language.t("onboarding.tips.search")}</li>
          <li>{language.t("onboarding.tips.pmode")}</li>
          <li>{language.t("onboarding.tips.plugins")}</li>
        </ul>
      </div>
    ),
  ]

  const last = createMemo(() => step() === steps.length - 1)

  return (
    <Dialog size="normal" transition>
      <div class="flex min-h-96 flex-col gap-6 p-6">
        <div class="flex flex-1 items-center justify-center">{steps[step()]()}</div>
        <div class="flex items-center gap-2">
          <div class="flex items-center gap-1.5">
            <For each={steps}>
              {(_, index) => (
                <span
                  classList={{
                    "size-1.5 rounded-full transition-colors": true,
                    "bg-text-interactive-base": index() === step(),
                    "bg-border-weak-base": index() !== step(),
                  }}
                />
              )}
            </For>
          </div>
          <div class="flex-1" />
          <Button variant="ghost" onClick={finish}>
            {language.t("onboarding.skip")}
          </Button>
          <Show when={step() > 0}>
            <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))}>
              {language.t("onboarding.back")}
            </Button>
          </Show>
          <Button onClick={() => (last() ? finish() : setStep((s) => s + 1))}>
            {last() ? language.t("onboarding.done") : language.t("onboarding.next")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
