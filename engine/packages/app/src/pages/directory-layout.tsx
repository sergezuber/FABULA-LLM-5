import { DataProvider } from "@mimo-ai/ui/context"
import { showToast } from "@mimo-ai/ui/toast"
import { base64Encode } from "@mimo-ai/shared/util/encode"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, type ParentProps, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { LocalProvider } from "@/context/local"
import { SDKProvider } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { decode64 } from "@/utils/base64"

function DirectoryDataProvider(props: ParentProps<{ directory: string }>) {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const sync = useSync()
  const slug = createMemo(() => base64Encode(props.directory))

  createEffect(() => {
    const next = sync.data.path.directory
    if (!next || next === props.directory) return
    const path = location.pathname.slice(slug().length + 1)
    navigate(`/${base64Encode(next)}${path}${location.search}${location.hash}`, { replace: true })
  })

  // Fire the per-session sync as a plain effect, NOT a createResource: a resource created under the
  // app-wide RouterRoot <Suspense> can flip that boundary to its (blank) fallback while it refetches
  // on a session-id change — the empty content flash right after send. An effect has no Suspense
  // involvement, so the shell (header + composer + content) never blanks during the new→session
  // navigation. Same side effect: kick sync.session.sync(id) whenever the id changes.
  createEffect(() => {
    const id = params.id
    if (id) void sync.session.sync(id)
  })

  return (
    <DataProvider
      data={sync.data}
      directory={props.directory}
      onNavigateToSession={(sessionID: string) => navigate(`/${slug()}/session/${sessionID}`)}
      onSessionHref={(sessionID: string) => `/${slug()}/session/${sessionID}`}
    >
      <LocalProvider>{props.children}</LocalProvider>
    </DataProvider>
  )
}

export default function Layout(props: ParentProps) {
  const params = useParams()
  const language = useLanguage()
  const navigate = useNavigate()
  let invalid = ""

  const resolved = createMemo(() => {
    if (!params.dir) return ""
    return decode64(params.dir) ?? ""
  })

  createEffect(() => {
    const dir = params.dir
    if (!dir) return
    if (resolved()) {
      invalid = ""
      return
    }
    if (invalid === dir) return
    invalid = dir
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: language.t("directory.error.invalidUrl"),
    })
    navigate("/", { replace: true })
  })

  // NON-keyed Show: switching directories must NOT remount SDKProvider/SyncProvider/DirectoryDataProvider
  // (that tears down the whole shell incl. the sidebar → full-window Splash flash on every project switch).
  // Both providers already react to a changing directory in place — SDKProvider rebuilds its client from
  // `directory()` and SyncProvider derives `current()` from `sdk.directory` — so we pass the reactive
  // `resolved` accessor through and let the tree update instead of unmount/remount.
  return (
    <Show when={resolved()}>
      <SDKProvider directory={resolved}>
        <SyncProvider>
          <DirectoryDataProvider directory={resolved()}>{props.children}</DirectoryDataProvider>
        </SyncProvider>
      </SDKProvider>
    </Show>
  )
}
