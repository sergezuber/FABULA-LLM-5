import { Component, createSignal } from "solid-js"
import { Dialog } from "@mimo-ai/ui/dialog"
import { Tabs } from "@mimo-ai/ui/tabs"
import { Icon } from "@mimo-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneral } from "./settings-general"
import { SettingsKeybinds } from "./settings-keybinds"
import { SettingsProviders } from "./settings-providers"
import { SettingsModels } from "./settings-models"
import { SettingsPlugins } from "./settings-plugins"
import { SettingsUsage } from "./settings-usage"
import { SettingsChangelog } from "./settings-changelog"
import { SettingsRegistry } from "./settings-registry"
import { SettingsMcp } from "./settings-mcp"
import { SettingsPermissions } from "./settings-permissions"
import { FABULA_VERSION } from "@/data/fabula-changelog"

export const DialogSettings: Component<{ tab?: string }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()

  // Keep every visited tab MOUNTED so switching back never re-runs its fetch or flashes a
  // loading/empty state — but mount lazily on first visit so opening Settings doesn't fire every
  // panel's fetch at once. Inactive panels stay in the DOM, hidden via CSS.
  const initial = props.tab ?? "general"
  const [tab, setTab] = createSignal(initial)
  const [visited, setVisited] = createSignal<Set<string>>(new Set([initial]))
  const onTab = (value: string) => {
    setTab(value)
    setVisited((prev) => (prev.has(value) ? prev : new Set(prev).add(value)))
  }
  const panelClass = "no-scrollbar [&:not([data-selected])]:hidden"

  return (
    <Dialog size="x-large" transition>
      <Tabs
        orientation="vertical"
        variant="settings"
        value={tab()}
        onChange={onTab}
        class="h-full settings-dialog"
      >
        <Tabs.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full pt-3">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </Tabs.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="providers">
                      <Icon name="providers" />
                      {language.t("settings.providers.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="models">
                      <Icon name="models" />
                      {language.t("settings.models.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="mcp">
                      <Icon name="providers" />
                      {language.t("settings.mcp.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="permissions">
                      <Icon name="eye" />
                      {language.t("settings.permissions.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="plugins">
                      <Icon name="sliders" />
                      {language.t("settings.tab.plugins")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="skills">
                      <Icon name="brain" />
                      {language.t("settings.tab.skills")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="agents">
                      <Icon name="fork" />
                      {language.t("settings.tab.agents")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="commands">
                      <Icon name="console" />
                      {language.t("settings.tab.commands")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="usage">
                      <Icon name="status" />
                      {language.t("settings.tab.usage")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="changelog">
                      <Icon name="bullet-list" />
                      {language.t("settings.tab.changelog")}
                    </Tabs.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
              <span>{language.t("app.name.desktop")}</span>
              <span class="text-11-regular">
                v{FABULA_VERSION} · {platform.version}
              </span>
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content value="general" forceMount={visited().has("general")} class={panelClass}>
          <SettingsGeneral />
        </Tabs.Content>
        <Tabs.Content value="shortcuts" forceMount={visited().has("shortcuts")} class={panelClass}>
          <SettingsKeybinds />
        </Tabs.Content>
        <Tabs.Content value="providers" forceMount={visited().has("providers")} class={panelClass}>
          <SettingsProviders />
        </Tabs.Content>
        <Tabs.Content value="models" forceMount={visited().has("models")} class={panelClass}>
          <SettingsModels />
        </Tabs.Content>
        <Tabs.Content value="mcp" forceMount={visited().has("mcp")} class={panelClass}>
          <SettingsMcp />
        </Tabs.Content>
        <Tabs.Content value="permissions" forceMount={visited().has("permissions")} class={panelClass}>
          <SettingsPermissions />
        </Tabs.Content>
        <Tabs.Content value="plugins" forceMount={visited().has("plugins")} class={panelClass}>
          <SettingsPlugins />
        </Tabs.Content>
        <Tabs.Content value="skills" forceMount={visited().has("skills")} class={panelClass}>
          <SettingsRegistry kind="skills" />
        </Tabs.Content>
        <Tabs.Content value="agents" forceMount={visited().has("agents")} class={panelClass}>
          <SettingsRegistry kind="agents" />
        </Tabs.Content>
        <Tabs.Content value="commands" forceMount={visited().has("commands")} class={panelClass}>
          <SettingsRegistry kind="commands" />
        </Tabs.Content>
        <Tabs.Content value="usage" forceMount={visited().has("usage")} class={panelClass}>
          <SettingsUsage />
        </Tabs.Content>
        <Tabs.Content value="changelog" forceMount={visited().has("changelog")} class={panelClass}>
          <SettingsChangelog />
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
