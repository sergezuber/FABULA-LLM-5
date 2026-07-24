import { createSignal, createEffect, onCleanup } from "solid-js"

// Is out-of-band work running for this session? A background producer cancels the turn and keeps going
// in its own process, so the session status reads "idle" while real work is in flight — and that is
// precisely when the interface must not look asleep. The companion dozed and the progress line stopped
// while a book was being analysed for minutes, which reads as a hang.
//
// Polled rather than pushed: the producer is a separate process with no channel into the event bus, and
// its heartbeat is the only thing that knows it is alive. The poll is cheap, stops when nothing is
// running, and a producer that dies simply stops refreshing its heartbeat — no cleanup, no stuck state.

const IDLE_MS = 4000 // nothing running: check occasionally, cost is negligible
const ACTIVE_MS = 1500 // work in flight: keep the indicators responsive

export type BackgroundWork = { active: boolean; state?: string; done?: number; total?: number }

export function useBackgroundWork(sessionID: () => string | undefined) {
  const [work, setWork] = createSignal<BackgroundWork>({ active: false })

  createEffect(() => {
    const id = sessionID()
    if (!id) {
      setWork({ active: false })
      return
    }
    let stopped = false
    let timer: number | undefined

    const tick = async () => {
      if (stopped) return
      try {
        const r = await fetch(`/session/${encodeURIComponent(id)}/background-work`)
        if (r.ok) setWork((await r.json()) as BackgroundWork)
      } catch {
        // A failed poll must never claim work is running — an indicator stuck "busy" on a network
        // hiccup is the same lie in the other direction.
        setWork({ active: false })
      }
      if (!stopped) timer = window.setTimeout(tick, work().active ? ACTIVE_MS : IDLE_MS)
    }

    tick()
    onCleanup(() => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    })
  })

  return work
}
