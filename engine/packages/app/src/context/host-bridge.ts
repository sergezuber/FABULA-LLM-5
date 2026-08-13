/**
 * Asking the desktop host to restart the engine.
 *
 * ONE definition, because there are two hosts and the call must mean the same thing in both. The macOS
 * host already answered `{action:"restart"}` on the `fabulaPlugins` channel; the Tauri shell forwards
 * that channel to a Rust command, so it is taught the same verb rather than given a second channel —
 * the frontend must not know which window it is running in.
 *
 * MEASURED CAVEAT that shaped this: the Tauri shim posts `String(body)`, so an OBJECT arrived as
 * "[object Object]". The shim now serialises properly; this function sends the object either way and
 * lets each host parse it, so neither side has to know what the other does with it.
 *
 * It reports whether a host was there to ask. A page served in a plain browser has no host and no engine
 * to restart — saying so is better than a button that appears to work.
 */
export function requestEngineRestart(): boolean {
  const bridge = (
    globalThis as unknown as {
      webkit?: { messageHandlers?: { fabulaPlugins?: { postMessage: (m: unknown) => unknown } } }
    }
  ).webkit?.messageHandlers?.fabulaPlugins
  if (!bridge) return false
  try {
    bridge.postMessage({ action: "restart" })
    return true
  } catch {
    return false
  }
}

/** Is there a desktop host at all? Used to decide whether to offer a restart or ask for a reopen. */
export function hasHostBridge(): boolean {
  return !!(
    globalThis as unknown as {
      webkit?: { messageHandlers?: { fabulaPlugins?: unknown } }
    }
  ).webkit?.messageHandlers?.fabulaPlugins
}
