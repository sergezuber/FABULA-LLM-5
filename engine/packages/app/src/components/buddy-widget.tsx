// FABULA Buddy — the living pixel pet on the composer's top edge (Phase 7.6).
//
// A thin SolidJS wrapper around the framework-agnostic BuddyEngine (buddy-engine.ts, ported from the
// internal design reference). It renders a zero-height layer directly above the composer form so the pet
// walks the composer's top edge, derives the pet's look from the deterministic roll (mirrors the backend
// plugin/lib/buddy.ts), reacts to the session working state (think ⇄ wake), and shows a hover/click card
// with name / rarity / level / XP / stats. Other events (verify → celebrate, error → sad, level-up) can be
// fired from anywhere via `window.dispatchEvent(new CustomEvent("fabula-buddy", { detail: { kind } }))`.
//
// Off-switch: localStorage `fabula.buddy.enabled` = "0" hides it. Respects prefers-reduced-motion (engine).

import { createSignal, onMount, onCleanup, createEffect, Show, For } from "solid-js"
import { BuddyEngine, rollBones, statIcon, STAT_DEFS, type BuddyInfo, type BuddyLook, type TriggerKind } from "./buddy-engine"
import { useSettings } from "@/context/settings"
import { useLanguage } from "@/context/language"

function stableUserId(): string {
  try {
    const k = "fabula.buddy.uid"
    let v = localStorage.getItem(k)
    if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(k, v) }
    return v
  } catch { return "anon" }
}
function buddyEnabled(): boolean {
  try { return localStorage.getItem("fabula.buddy.enabled") !== "0" } catch { return true }
}

// A single global "fabula-buddy" listener routes each event to the ONE active pet (the most-recently
// mounted composer), so N mounted composers don't all react / bind N listeners (review #7).
let activeEngine: BuddyEngine | null = null
let listenerBound = false
function ensureGlobalListener() {
  if (listenerBound || typeof window === "undefined") return
  listenerBound = true
  window.addEventListener("fabula-buddy", (e: Event) => {
    const kind = (e as CustomEvent).detail?.kind as TriggerKind | undefined
    if (kind && activeEngine) activeEngine.trigger(kind)
  })
}

export function BuddyWidget(props: { working?: () => boolean; directory?: () => string | undefined }) {
  // Managed from Settings > General > "Buddy pet" (appearance.buddy); the legacy
  // localStorage kill-switch (fabula.buddy.enabled="0") stays as an emergency floor.
  const settings = useSettings()
  if (!buddyEnabled()) return null
  return (
    <Show when={settings.appearance.buddy()}>
      <BuddyWidgetInner {...props} />
    </Show>
  )
}

function BuddyWidgetInner(props: { working?: () => boolean; directory?: () => string | undefined }) {
  const settings = useSettings()
  const language = useLanguage()

  let wrap!: HTMLDivElement
  let pet!: HTMLCanvasElement
  let hit!: HTMLDivElement
  let bubble!: HTMLDivElement
  let card!: HTMLDivElement
  let cardCanvas!: HTMLCanvasElement

  const [info, setInfo] = createSignal<BuddyInfo | null>(null)
  const [open, setOpen] = createSignal(false)
  let engine: BuddyEngine | null = null
  let cardTimer: number | undefined
  let closeTimer: number | undefined

  onMount(() => {
    ensureGlobalListener()
    let disposed = false
    onCleanup(() => { disposed = true })
    void (async () => {
      // Fetch the REAL companion (identity + per-project state) so the pet matches the awarded buddy;
      // fall back to a stable local id if the route/plugin is unavailable. Uses the ROLLED eye bone.
      let uid = stableUserId()
      let backend: { userId?: string; xp?: number; legendaryEarned?: boolean; statBumps?: Record<string, number>; name?: string | null } | null = null
      try {
        const dir = props.directory?.()
        const res = await fetch("/global/fabula/buddy" + (dir ? "?dir=" + encodeURIComponent(dir) : ""))
        if (res.ok) { backend = await res.json(); if (backend?.userId) uid = String(backend.userId) }
      } catch {}
      if (disposed) return
      const look: BuddyLook = { ...rollBones(uid), scale: 2, autonomous: true, muted: false }
      engine = new BuddyEngine({ petCanvas: pet, composer: wrap, hit, bubble }, look, setInfo, uid)
      engine.mount()
      activeEngine = engine
      if (backend) engine.syncFromBackend({ xp: backend.xp, legendaryEarned: backend.legendaryEarned, statBumps: backend.statBumps, name: backend.name })
      engine.setWorking(props.working?.() ?? false) // sync initial state — the effect below only sees CHANGES
    })()
  })
  onCleanup(() => {
    if (cardTimer) clearInterval(cardTimer)
    if (closeTimer) clearTimeout(closeTimer)
    if (activeEngine === engine) activeEngine = null
    engine?.destroy()
  })

  // Reflect the agent working state: the pet stays awake & busy while it runs (never dozes mid-turn),
  // and settles back to idle when it stops. setWorking is idempotent, so re-runs are safe.
  createEffect(() => {
    const w = props.working?.() ?? false
    engine?.setWorking(w)
  })

  function cancelClose() { if (closeTimer) { clearTimeout(closeTimer); closeTimer = undefined } }
  // Delay closing so the pointer can travel from the pet across the gap onto the card.
  function scheduleClose() { cancelClose(); closeTimer = window.setTimeout(closeCard, 180) }
  function openCard() {
    if (!engine) return
    cancelClose()
    setOpen(true)
    engine.drawCardPet(cardCanvas)
    if (cardTimer) clearInterval(cardTimer)
    cardTimer = window.setInterval(() => engine && engine.drawCardPet(cardCanvas), 120)
    // place the card centered over the pet, above the shelf
    const layerH = engine.layerH
    const cw = 246
    let left = engine.petX - cw / 2
    left = Math.max(6, Math.min((wrap.clientWidth || cw) - cw - 6, left))
    card.style.left = left + "px"
    card.style.bottom = layerH + 8 + "px"
  }
  function closeCard() {
    setOpen(false)
    if (cardTimer) { clearInterval(cardTimer); cardTimer = undefined }
  }

  const stars = () => info()?.stars ?? ""

  return (
    // Zero-height, full-width layer sitting on the composer's top edge (its bottom == the form's top).
    <div ref={wrap} style={{ position: "relative", height: "0px", width: "100%", "z-index": "6" }}>
      <canvas ref={pet} style={{ position: "absolute", left: "0", bottom: "0", "pointer-events": "none", opacity: "0.8" }} />
      <div
        ref={hit}
        style={{ position: "absolute", bottom: "0", "pointer-events": "auto", cursor: "pointer" }}
        onMouseEnter={() => { engine?.setHovered(true); openCard() }}
        onMouseLeave={() => { engine?.setHovered(false); scheduleClose() }}
        onClick={() => { engine?.setHovered(true); openCard() }}
      />
      <div
        ref={bubble}
        style={{
          position: "absolute", "pointer-events": "none", opacity: "0", transform: "translate(-50%,4px)",
          transition: "opacity .15s, transform .15s", "font-family": "ui-monospace,SFMono-Regular,Menlo,monospace",
          "font-size": "12px", "white-space": "nowrap", "border-radius": "8px", padding: "3px 8px",
          background: "var(--fab-surface, #191919)", color: "var(--fab-fg, #e6e9f0)",
          border: "1px solid var(--fab-border, rgba(255,255,255,.12))", "box-shadow": "0 6px 20px rgba(0,0,0,.28)",
        }}
      />
      {/* hover/click card */}
      <div
        ref={card}
        onMouseEnter={cancelClose}
        onMouseLeave={closeCard}
        class="rounded-2xl border border-border-weak-base bg-surface-base p-3 shadow-lg"
        style={{
          position: "absolute", "z-index": "20", width: "246px",
          opacity: open() ? "1" : "0", "pointer-events": open() ? "auto" : "none",
          transition: "opacity .15s", display: "flex", "flex-direction": "column", gap: "10px",
        }}
      >
        <div style={{ display: "flex", "align-items": "center", gap: "12px" }}>
          <canvas ref={cardCanvas} style={{ width: "68px", height: "68px", "flex": "0 0 auto", "image-rendering": "pixelated", "border-radius": "10px", background: "var(--fab-surface-2, rgba(255,255,255,.04))" }} />
          <div style={{ display: "flex", "flex-direction": "column", gap: "2px", "min-width": "0", flex: "1" }}>
            <div class="text-text-strong" style={{ "font-size": "17px", "font-weight": "700", "line-height": "1", "white-space": "nowrap" }}>{info()?.soulName}</div>
            <div class="text-text-weak" style={{ "font-size": "11.5px", "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>
              {language.t("buddy.species." + (info()?.species ?? "chonk"))} · {language.t("buddy.rarity." + (info()?.rarity ?? "common"))}
            </div>
            <div style={{ "font-size": "12px", "letter-spacing": "2px", color: "#ffcf5a" }}>{stars()}</div>
            <Show when={info()?.shiny}>
              <span style={{ "align-self": "flex-start", "font-size": "9.5px", padding: "1px 6px", "border-radius": "5px", background: "rgba(255,207,90,.18)", color: "#ffcf5a", "margin-top": "1px" }}>✦ SHINY</span>
            </Show>
          </div>
        </div>
        <div style={{ display: "flex", "flex-direction": "column", gap: "5px" }}>
          <div style={{ display: "flex", "justify-content": "space-between", "align-items": "baseline" }}>
            <span class="text-text-strong" style={{ "font-size": "13px" }}>{language.t("buddy.card.level")} {info()?.level}</span>
            <span class="text-text-weak" style={{ "font-size": "11px" }}>{info()?.xpLabel}</span>
          </div>
          <div style={{ height: "8px", background: "var(--fab-surface-2, rgba(255,255,255,.08))", "border-radius": "5px", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.round(((info()?.into ?? 0) / Math.max(1, info()?.span ?? 1)) * 100)}%`, background: "#0ea5e9", "border-radius": "5px", transition: "width .4s" }} />
          </div>
        </div>
        <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
          <For each={STAT_DEFS}>
            {([k, col]) => (
              <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                <img src={statIcon(k, col)} style={{ width: "16px", height: "16px", "image-rendering": "pixelated", flex: "0 0 auto" }} alt="" />
                <span class="text-text-weak" style={{ "font-size": "10.5px", width: "76px", "letter-spacing": ".5px" }}>{k}</span>
                <div style={{ flex: "1", height: "6px", background: "var(--fab-surface-2, rgba(255,255,255,.08))", "border-radius": "4px", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${info()?.stats?.[k] ?? 0}%`, background: col, "border-radius": "4px" }} />
                </div>
                <span class="text-text-strong" style={{ "font-size": "10.5px", width: "20px", "text-align": "right" }}>{info()?.stats?.[k] ?? 0}</span>
              </div>
            )}
          </For>
        </div>
        <button
          data-action="buddy-disable"
          onClick={() => settings.appearance.setBuddy(false)}
          class="text-text-weak"
          style={{
            "margin-top": "2px", padding: "5px 8px", "border-radius": "7px", cursor: "pointer",
            border: "1px solid var(--fab-border, rgba(255,255,255,.1))", background: "transparent",
            "font-size": "11px", "text-align": "center", width: "100%",
          }}
          title={language.t("buddy.card.disable.hint")}
        >
          {language.t("buddy.card.disable")}
        </button>
      </div>
    </div>
  )
}
