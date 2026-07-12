// @refresh reload

import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { type Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { handleNotificationClick } from "@/utils/notification-click"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => getStorage(DEFAULT_SERVER_URL_KEY)
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)

// FABULA: native folder picker. Inside the WKWebView shell the Swift `fabulaPickFolder`
// reply-handler opens a real Finder-style NSOpenPanel and resolves with the chosen absolute path
// (or null on cancel). Defined ONLY when the bridge exists, so every call site
// (`platform.openDirectoryPickerDialog && …`) uses the native panel in the app and cleanly falls
// back to the in-app directory dialog on the plain web build.
const folderBridge = (
  window as unknown as {
    webkit?: {
      messageHandlers?: { fabulaPickFolder?: { postMessage: (m: unknown) => Promise<unknown> } }
    }
  }
).webkit?.messageHandlers?.fabulaPickFolder
const openDirectoryPickerDialog = folderBridge
  ? async (opts?: { title?: string; multiple?: boolean }) => {
      const res = await folderBridge.postMessage({ title: opts?.title ?? "", multiple: !!opts?.multiple })
      if (res == null) return null
      return (Array.isArray(res) ? (res as string[]) : (res as string)) as string | string[]
    }
  : undefined

const notify: Platform["notify"] = async (title, description, href) => {
  // FABULA: inside the native WKWebView shell the Web Notification API is dead — hand the
  // notification to the Swift bridge (UNUserNotificationCenter) instead.
  const bridge = (
    window as unknown as {
      webkit?: { messageHandlers?: { fabulaNotify?: { postMessage: (m: unknown) => void } } }
    }
  ).webkit?.messageHandlers?.fabulaNotify
  if (bridge) {
    const inView = document.visibilityState === "visible" && document.hasFocus()
    if (inView) return
    bridge.postMessage({ title, body: description ?? "", href: href ?? "" })
    return
  }
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: "/favicon-v3.svg",
  })

  notification.onclick = () => {
    handleNotificationClick(href)
    notification.close()
  }
}

const openLink: Platform["openLink"] = (url) => {
  window.open(url, "_blank")
}

const back: Platform["back"] = () => {
  window.history.back()
}

const forward: Platform["forward"] = () => {
  window.history.forward()
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getCurrentUrl = () => {
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  return getCurrentUrl()
}

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  openLink,
  back,
  forward,
  restart,
  notify,
  openDirectoryPickerDialog,
  getDefaultServer: async () => {
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: writeDefaultServerUrl,
}

if (root instanceof HTMLElement) {
  const server: ServerConnection.Http = { type: "http", http: { url: getCurrentUrl() } }
  render(
    () => (
      <PlatformProvider value={platform}>
        <AppBaseProviders>
          <AppInterface
            defaultServer={ServerConnection.Key.make(getDefaultUrl())}
            servers={[server]}
            disableHealthCheck
          />
        </AppBaseProviders>
      </PlatformProvider>
    ),
    root,
  )
}
