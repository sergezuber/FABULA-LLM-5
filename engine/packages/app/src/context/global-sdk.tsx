import type { Event, GlobalEvent } from "@mimo-ai/sdk/v2/client"
import { createSimpleContext } from "@mimo-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { batch, onCleanup, onMount } from "solid-js"
import z from "zod"
import { createSdkForServer } from "@/utils/server"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { useServer } from "./server"

const abortError = z.object({
  name: z.literal("AbortError"),
})

// Read a same-origin `text/event-stream` through the browser's native EventSource. Each `data:` line is
// the engine's event object (`{ directory?, payload }`); we yield it parsed, matching what the
// fetch-based SDK stream yields. Reconnection, heartbeat-timeout and backoff stay owned by the caller:
// EventSource's own auto-reconnect is suppressed (we `.close()` on any error and let the outer loop
// reconnect), so this generator behaves like a single attempt that ends on error or abort.
//
// The pending/wake handoff is race-free because the Promise executor runs synchronously: between
// observing an empty queue and installing `resolve`, no `onmessage` macrotask can interleave, so a
// later message always finds `resolve` set and wakes the await.
async function* eventSourceIterator(url: string, signal: AbortSignal): AsyncGenerator<GlobalEvent> {
  const es = new EventSource(url)
  const pending: GlobalEvent[] = []
  let resolve: (() => void) | undefined
  let finished = false
  const wake = () => {
    resolve?.()
    resolve = undefined
  }
  es.onmessage = (e) => {
    try {
      pending.push(JSON.parse(e.data) as GlobalEvent)
    } catch {
      // A malformed frame is dropped, not fatal — the next well-formed one still arrives.
    }
    wake()
  }
  // On any transport error, end this attempt; the caller decides whether to retry.
  es.onerror = () => {
    finished = true
    es.close()
    wake()
  }
  const onAbort = () => {
    finished = true
    es.close()
    wake()
  }
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    while (!finished) {
      while (pending.length) yield pending.shift() as GlobalEvent
      if (finished) break
      await new Promise<void>((r) => {
        resolve = r
      })
    }
  } finally {
    finished = true
    es.close()
    signal.removeEventListener("abort", onAbort)
  }
}

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const language = useLanguage()
    const server = useServer()
    const platform = usePlatform()
    const abort = new AbortController()

    const eventFetch = (() => {
      if (!platform.fetch || !server.current) return
      try {
        const url = new URL(server.current.http.url)
        const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
        if (url.protocol === "http:" && !loopback) return platform.fetch
      } catch {
        return
      }
    })()

    const currentServer = server.current
    if (!currentServer) throw new Error(language.t("error.globalSDK.noServerAvailable"))

    // The engine origin when it is the loopback HTTP server the desktop shells load. On this origin the
    // page and the event stream are same-origin and there is no auth, so the event stream can be read
    // with the browser's native EventSource — which matters on Windows: WebView2 delivers a `fetch()`
    // response body all-at-once (MicrosoftEdge/WebView2Feedback#3519), so a fetch-based SSE reader never
    // sees an event until the connection closes, and ours is held open by a heartbeat. EventSource uses
    // Chromium's dedicated event-stream loader, not the fetch ReadableStream path, so it streams
    // event-by-event in WKWebView, WebKitGTK and WebView2 alike. The password-protected remote origin
    // (EventSource cannot send an Authorization header) stays on fetch below.
    const eventSourceOrigin = (() => {
      try {
        const url = new URL(currentServer.http.url)
        const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
        if (url.protocol === "http:" && loopback) return new URL("/global/event", url).href
      } catch {
        // fall through
      }
    })()
    const useEventSource = !!eventSourceOrigin

    const eventSdk = createSdkForServer({
      signal: abort.signal,
      fetch: eventFetch,
      server: currentServer.http,
    })
    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    type Queued = { directory: string; payload: Event }
    const FLUSH_FRAME_MS = 16
    const STREAM_YIELD_MS = 8
    const RECONNECT_DELAY_MS = 250

    let queue: Queued[] = []
    let buffer: Queued[] = []
    const coalesced = new Map<string, number>()
    const staleDeltas = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0

    const deltaKey = (directory: string, messageID: string, partID: string) => `${directory}:${messageID}:${partID}`

    const key = (directory: string, payload: Event) => {
      if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`
      if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part
        return `message.part.updated:${directory}:${part.messageID}:${part.id}`
      }
    }

    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined

      if (queue.length === 0) return

      const events = queue
      const skip = staleDeltas.size > 0 ? new Set(staleDeltas) : undefined
      queue = buffer
      buffer = events
      queue.length = 0
      coalesced.clear()
      staleDeltas.clear()

      last = Date.now()
      batch(() => {
        for (const event of events) {
          if (skip && event.payload.type === "message.part.delta") {
            const props = event.payload.properties
            if (skip.has(deltaKey(event.directory, props.messageID, props.partID))) continue
          }
          emitter.emit(event.directory, event.payload)
        }
      })

      buffer.length = 0
    }

    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
    }

    let streamErrorLogged = false
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const aborted = (error: unknown) => abortError.safeParse(error).success

    let attempt: AbortController | undefined
    let run: Promise<void> | undefined
    let started = false
    const HEARTBEAT_TIMEOUT_MS = 15_000
    let lastEventAt = Date.now()
    let heartbeat: ReturnType<typeof setTimeout> | undefined
    const resetHeartbeat = () => {
      lastEventAt = Date.now()
      if (heartbeat) clearTimeout(heartbeat)
      heartbeat = setTimeout(() => {
        attempt?.abort()
      }, HEARTBEAT_TIMEOUT_MS)
    }
    const clearHeartbeat = () => {
      if (!heartbeat) return
      clearTimeout(heartbeat)
      heartbeat = undefined
    }

    const start = () => {
      if (started) return run
      started = true
      run = (async () => {
        // oxlint-disable-next-line no-unmodified-loop-condition -- `started` is set to false by stop() which also aborts; both flags are checked to allow graceful exit
        while (!abort.signal.aborted && started) {
          attempt = new AbortController()
          const attemptSignal = attempt.signal
          lastEventAt = Date.now()
          const onAbort = () => {
            attempt?.abort()
          }
          abort.signal.addEventListener("abort", onAbort)
          try {
            let yielded = Date.now()
            resetHeartbeat()
            // On the loopback engine origin read the stream through native EventSource (Windows:
            // WebView2 buffers a fetch() stream to all-at-once). The authenticated remote origin keeps
            // the fetch-based SDK reader, which EventSource cannot authenticate.
            const eventIterable: AsyncIterable<GlobalEvent> = useEventSource
              ? eventSourceIterator(eventSourceOrigin as string, attemptSignal)
              : {
                  async *[Symbol.asyncIterator]() {
                    const events = await eventSdk.global.event({
                      signal: attemptSignal,
                      onSseError: (error) => {
                        if (aborted(error)) return
                        if (streamErrorLogged) return
                        streamErrorLogged = true
                        console.error("[global-sdk] event stream error", {
                          url: currentServer.http.url,
                          fetch: eventFetch ? "platform" : "webview",
                          error,
                        })
                      },
                    })
                    yield* events.stream
                  },
                }
            for await (const event of eventIterable) {
              resetHeartbeat()
              streamErrorLogged = false
              const directory = event.directory ?? "global"
              if (event.payload.type === "sync") {
                continue
              }

              const payload = event.payload as Event

              const k = key(directory, payload)
              if (k) {
                const i = coalesced.get(k)
                if (i !== undefined) {
                  queue[i] = { directory, payload }
                  if (payload.type === "message.part.updated") {
                    const part = payload.properties.part
                    staleDeltas.add(deltaKey(directory, part.messageID, part.id))
                  }
                  continue
                }
                coalesced.set(k, queue.length)
              }
              queue.push({ directory, payload })
              schedule()

              if (Date.now() - yielded < STREAM_YIELD_MS) continue
              yielded = Date.now()
              await wait(0)
            }
          } catch (error) {
            if (!aborted(error) && !streamErrorLogged) {
              streamErrorLogged = true
              console.error("[global-sdk] event stream failed", {
                url: currentServer.http.url,
                fetch: eventFetch ? "platform" : "webview",
                error,
              })
            }
          } finally {
            abort.signal.removeEventListener("abort", onAbort)
            attempt = undefined
            clearHeartbeat()
          }

          if (abort.signal.aborted || !started) return
          await wait(RECONNECT_DELAY_MS)
        }
      })().finally(() => {
        run = undefined
        flush()
      })
      return run
    }

    const stop = () => {
      started = false
      attempt?.abort()
      clearHeartbeat()
    }

    onMount(() => {
      makeEventListener(document, "visibilitychange", () => {
        if (document.visibilityState !== "visible") return
        if (!started) return
        if (Date.now() - lastEventAt < HEARTBEAT_TIMEOUT_MS) return
        attempt?.abort()
      })
    })

    onCleanup(() => {
      stop()
      abort.abort()
      flush()
    })

    const sdk = createSdkForServer({
      server: server.current.http,
      fetch: platform.fetch,
      throwOnError: true,
    })

    return {
      url: currentServer.http.url,
      client: sdk,
      event: {
        on: emitter.on.bind(emitter),
        listen: emitter.listen.bind(emitter),
        start,
      },
      createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
        const s = server.current
        if (!s) throw new Error(language.t("error.globalSDK.serverNotAvailable"))
        return createSdkForServer({
          server: s.http,
          fetch: platform.fetch,
          ...opts,
        })
      },
    }
  },
})
