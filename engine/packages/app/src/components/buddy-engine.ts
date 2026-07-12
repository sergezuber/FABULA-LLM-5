// FABULA Buddy — procedural pixel-art pet engine (framework-agnostic).
//
// Ported faithfully from an internal design reference (the living-widget mode).
// Draws a 32×32 chunky-pixel companion on a canvas over the composer edge:
// it walks the shelf, roams, sleeps in a corner, and reacts to session events (send/think/verify/error).
// Everything is drawn in code — no image assets. The SolidJS wrapper (buddy-widget.tsx) owns the DOM and
// feeds this engine a `look` derived from the real deterministic roll (mirrors plugin/lib/buddy.ts).

export type Species =
  | "duck" | "goose" | "blob" | "cat" | "dragon" | "octopus" | "owl" | "penguin" | "turtle"
  | "snail" | "ghost" | "axolotl" | "capybara" | "cactus" | "robot" | "rabbit" | "mushroom" | "chonk"
export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary"
export type Eye = "·" | "✦" | "×" | "◉" | "@" | "°"
export type Hat = "none" | "crown" | "tophat" | "propeller" | "halo" | "wizard" | "beanie" | "tinyduck"

export type BuddyLook = {
  species: Species
  rarity: Rarity
  eye: Eye
  hat: Hat
  shiny: boolean
  scale: number
  autonomous: boolean
  muted: boolean
}

export type BuddyInfo = {
  soulName: string
  species: Species
  speciesLabel: string
  gaitLabel: string
  rarity: Rarity
  rarityLabel: string
  stars: string
  shiny: boolean
  level: number
  into: number
  span: number
  xpLabel: string
  stats: Record<string, number>
}

export type TriggerKind = "send" | "think" | "awaiting" | "verify" | "level" | "error" | "sleep" | "wake"
export const TRIGGER_KINDS: TriggerKind[] = ["send", "think", "awaiting", "verify", "level", "error", "sleep", "wake"]

type Dom = { petCanvas: HTMLCanvasElement; composer: HTMLElement; hit: HTMLElement; bubble: HTMLElement }
type Px = { c: HTMLCanvasElement; x: CanvasRenderingContext2D }
type SpDef = { base: string; acc: string; w: number; h: number; gait: "walk" | "float" | "slide" | "hop"; ear: number; legs: boolean; belly?: string; feet?: string; ru: string }
type Pose = { eye: string; mouth: string; bob: number; squash: number; legStep: number; fx: string | null; sit: boolean; arm: number; tuck: boolean; moving: boolean }
type Metrics = { cx: number; cy: number; rx: number; ry: number; topY: number; botY: number; feetY: number; faceX: number; faceY: number; gap: number; headTop: number; ear: number }

export const SPECIES: Species[] = ["duck","goose","blob","cat","dragon","octopus","owl","penguin","turtle","snail","ghost","axolotl","capybara","cactus","robot","rabbit","mushroom","chonk"]
export const EYES: Eye[] = ["·","✦","×","◉","@","°"]
export const HATS: Hat[] = ["none","crown","tophat","propeller","halo","wizard","beanie","tinyduck"]

const RARITY_WEIGHTS: Record<Rarity, number> = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 }
const SALT = "friend-2026-401"

/** The five buddy stats + their colors (fixed vocabulary, matches plugin/lib/buddy.ts). */
export const STAT_DEFS: [string, string][] = [["DEBUGGING","#58c3f5"],["PATIENCE","#7ee787"],["CHAOS","#ff7a9c"],["WISDOM","#c9a2ff"],["SNARK","#ffcf5a"]]

/** Pixel stat icon (16×16) as a data URL — pure, so the widget can render it without the engine. */
export function statIcon(kind: string, color: string): string {
  const c = document.createElement("canvas"); c.width = 16; c.height = 16
  const x = c.getContext("2d")!; x.imageSmoothingEnabled = false
  const P = (px: number, py: number, w: number, h: number, col: string) => { x.fillStyle = col; x.fillRect(px, py, w || 1, h || 1) }
  if (kind === "DEBUGGING") { P(6,2,4,3,color);P(4,4,2,2,color);P(10,4,2,2,color);P(5,6,6,6,color);P(3,7,2,1,color);P(11,7,2,1,color);P(3,10,2,1,color);P(11,10,2,1,color);P(6,7,1,1,"#0a0a0b");P(9,7,1,1,"#0a0a0b") }
  else if (kind === "PATIENCE") { P(4,4,3,3,color);P(9,4,3,3,color);P(3,6,10,3,color);P(4,9,8,2,color);P(6,11,4,2,color);P(7,13,2,1,color) }
  else if (kind === "CHAOS") { P(7,2,2,4,color);P(6,6,4,2,color);P(3,7,3,2,color);P(10,7,3,2,color);P(5,9,2,3,color);P(9,9,2,3,color);P(7,8,2,2,color) }
  else if (kind === "WISDOM") { P(4,3,8,2,color);P(3,5,10,7,color);P(3,12,10,1,color);P(7,4,2,8,"#0a0a0b");P(5,7,2,1,color);P(9,7,2,1,color) }
  else if (kind === "SNARK") { P(4,4,3,2,color);P(9,4,3,2,color);P(4,8,8,1,color);P(5,9,6,1,color);P(6,7,1,1,color);P(9,7,1,1,color) }
  return c.toDataURL()
}

// FNV-1a + mulberry32 — identical to plugin/lib/buddy.ts so bones match the backend roll.
function hashStr(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
function mulberry32(a: number): () => number { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
function pick<T>(rng: () => number, arr: readonly T[]): T { return arr[Math.floor(rng() * arr.length)]! }

/** Deterministic bones from a user id — same shape/weights as the backend, so the app shows the real pet. */
export function rollBones(userId: string): { species: Species; rarity: Rarity; eye: Eye; hat: Hat; shiny: boolean } {
  const rng = mulberry32(hashStr((userId || "anon") + SALT))
  const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0)
  let roll = rng() * total
  let rarity: Rarity = "common"
  for (const r of Object.keys(RARITY_WEIGHTS) as Rarity[]) { roll -= RARITY_WEIGHTS[r]; if (roll < 0) { rarity = r; break } }
  return { rarity, species: pick(rng, SPECIES), eye: pick(rng, EYES), hat: rarity === "common" ? "none" : pick(rng, HATS), shiny: rng() < 0.01 }
}

export class BuddyEngine {
  private dom: Dom
  private cfg: BuddyLook
  private onInfo: (info: BuddyInfo) => void

  private readonly G = 32
  private readonly PIVY = 27
  private readonly EYE = "#241c17"
  private readonly WHITE = "#ffffff"
  private readonly BLUSH = "#ff9db0"
  private readonly SP: Record<Species, SpDef> = {
    duck:{base:"#ffde7a",acc:"#ff9e3d",w:15,h:12,gait:"walk",ear:0,legs:true,ru:"Утёнок"},
    goose:{base:"#fbfbf6",acc:"#ff9e3d",w:12,h:12,gait:"walk",ear:0,legs:true,ru:"Гусь"},
    blob:{base:"#9de7c4",acc:"#5fd0a2",w:15,h:13,gait:"walk",ear:0,legs:true,ru:"Блоб"},
    cat:{base:"#ffcba4",acc:"#ff9db0",w:15,h:12,gait:"walk",ear:4,legs:true,ru:"Котик"},
    dragon:{base:"#c4b0ff",acc:"#fff0c2",w:15,h:12,gait:"walk",ear:3,legs:true,ru:"Дракоша"},
    octopus:{base:"#ffbad9",acc:"#f58fb9",w:16,h:11,gait:"walk",ear:0,legs:false,ru:"Осьминожка"},
    owl:{base:"#e6c79c",acc:"#b98d5c",w:15,h:13,gait:"walk",ear:3,legs:true,ru:"Совёнок"},
    penguin:{base:"#3e4a63",acc:"#ff9e3d",w:13,h:15,gait:"walk",ear:0,legs:true,belly:"#f4f6fb",ru:"Пингвинчик"},
    turtle:{base:"#a7e59e",acc:"#c98f4f",w:16,h:10,gait:"walk",ear:0,legs:true,ru:"Черепашка"},
    snail:{base:"#f2d6b8",acc:"#f0a35a",w:15,h:11,gait:"slide",ear:0,legs:false,ru:"Улитка"},
    ghost:{base:"#eff0fb",acc:"#cfd2ea",w:14,h:15,gait:"float",ear:0,legs:false,ru:"Привидение"},
    axolotl:{base:"#ffb6dd",acc:"#ff6f9c",w:15,h:11,gait:"walk",ear:3,legs:true,ru:"Аксолотль"},
    capybara:{base:"#c9a87c",acc:"#9c7f57",w:17,h:12,gait:"walk",ear:2,legs:true,ru:"Капибара"},
    cactus:{base:"#8fd59a",acc:"#ff7a9c",w:12,h:15,gait:"hop",ear:0,legs:false,ru:"Кактус"},
    robot:{base:"#a9dce8",acc:"#38445a",w:14,h:13,gait:"walk",ear:0,legs:true,ru:"Робот"},
    rabbit:{base:"#fbfbf6",acc:"#ff9db0",w:13,h:12,gait:"hop",ear:7,legs:true,ru:"Кролик"},
    mushroom:{base:"#ff8f9e",acc:"#ffffff",w:15,h:11,gait:"hop",ear:0,legs:true,belly:"#f3e6d8",ru:"Грибочек"},
    chonk:{base:"#c9cdd6",acc:"#aeb4c0",w:18,h:14,gait:"walk",ear:4,legs:true,ru:"Толстик"},
  }
  private readonly RARITY: Record<Rarity, { stars: number; c: string; ru: string }> = {
    common:{stars:1,c:"#8b93a7",ru:"common"},uncommon:{stars:2,c:"#56d364",ru:"uncommon"},rare:{stars:3,c:"#58c3f5",ru:"rare"},epic:{stars:4,c:"#c9a2ff",ru:"epic"},legendary:{stars:5,c:"#ffcf5a",ru:"legendary"},
  }
  readonly STATS = STAT_DEFS
  private readonly NAMES: Record<Species, string[]> = {
    duck:["Кряк","Пиксель","Утя"],goose:["Гоготун","Гуся","Хонк"],blob:["Кисель","Желе","Плюх"],cat:["Мурчик","Пиксель","Котлета"],dragon:["Игнис","Драко","Уголёк"],octopus:["Октя","Кальмарчик","Восьмик"],owl:["Угу","Филя","Совунья"],penguin:["Пингви","Ласты","Айсберг"],turtle:["Панцирь","Тортила","Шелдон"],snail:["Слим","Улит","Тягун"],ghost:["Бу","Призрак","Туман"],axolotl:["Аксель","Жабрик","Розик"],capybara:["Капи","Спокуш","Мудрец"],cactus:["Колючка","Кактя","Пустыш"],robot:["Бип","Бот-9","Винтик"],rabbit:["Ушастик","Прыг","Морковка"],mushroom:["Гриня","Шляпка","Спор"],chonk:["Толстик","Пухля","Батон"],
  }

  // runtime state
  private oc!: HTMLCanvasElement; private octx!: CanvasRenderingContext2D; private _px!: Px
  private ctx: CanvasRenderingContext2D | null = null
  private reduced = false
  private S = 3; private time = 0; private act = "idle"; private actT = 0; private actDur = 2
  private x = 80; private facing = 1; private phase = 0; private stridePhase = 0
  private jump = 0; private jumpActive = false; private bounce: { t: number; dur: number; h: number; n: number } | null = null
  private blinkOn = false; private blinkNext = 1.5
  private idleSince = 0; private sleeping = false; private busy = false; private hovered = false; private targetX: number | null = null; private afterWalk: (() => void) | null = null
  private _rng = mulberry32(1234); private xp = 95; private level = 1; private _into = 0; private _span = 60
  private trackW = 300; private _layerH = 100; private _m: Metrics | null = null
  private last = 0; private raf = 0; private ro: ResizeObserver | null = null; private _onVis: (() => void) | null = null
  private _bubbleUntil = 0
  private _soul: { name: string; stats: Record<string, number> } = { name: "", stats: {} }
  private _pc: Partial<Record<Species, any>> = {}

  private userId: string
  constructor(dom: Dom, cfg: BuddyLook, onInfo: (info: BuddyInfo) => void, userId = "anon") {
    this.dom = dom; this.cfg = cfg; this.onInfo = onInfo; this.userId = userId || "anon"
    this.tick = this.tick.bind(this)
  }

  /** Current pet x (center) along the shelf — for placing the hover card. */
  get petX(): number { return this.x }
  /** Height of the pet layer band above the composer. */
  get layerH(): number { return this._layerH }
  get sleepingNow(): boolean { return this.sleeping }

  // ---------- lifecycle ----------
  mount() {
    this.oc = document.createElement("canvas"); this.oc.width = 32; this.oc.height = 32
    this.octx = this.oc.getContext("2d")!; this.octx.imageSmoothingEnabled = false
    this._px = { c: this.oc, x: this.octx }
    this.reduced = !!(typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    this.S = this.cfg.scale
    this.regenSoul()
    this.refreshLevel()
    this.syncLabels()
    this.measure()
    if (typeof ResizeObserver !== "undefined") { this.ro = new ResizeObserver(() => this.measure()); this.ro.observe(this.dom.composer) }
    // Pause the loop while the window/tab is hidden (saves CPU/battery; the browser throttles rAF too).
    if (typeof document !== "undefined") {
      this._onVis = () => {
        if (document.hidden) { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0 }
        else if (!this.raf) { this.last = typeof performance !== "undefined" ? performance.now() : 0; this.raf = requestAnimationFrame(this.tick) }
      }
      document.addEventListener("visibilitychange", this._onVis)
    }
    this.last = (typeof performance !== "undefined" ? performance.now() : 0)
    this.raf = requestAnimationFrame(this.tick)
  }
  destroy() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; if (this.ro) this.ro.disconnect(); if (this._onVis && typeof document !== "undefined") document.removeEventListener("visibilitychange", this._onVis) }

  setCfg(partial: Partial<BuddyLook>) {
    const speciesChanged = partial.species != null && partial.species !== this.cfg.species
    this.cfg = { ...this.cfg, ...partial }
    if (partial.scale != null) { this.S = partial.scale; this.measure() }
    if (speciesChanged) { this.regenSoul(); this.idleSince = this.time }
    this.syncLabels()
  }

  /** Align the pet with the REAL backend companion (fabula-buddy plugin, .fabula/buddy/state.json):
   *  seed XP→level, apply the legendary upgrade, stat bumps and the hatched name. */
  syncFromBackend(s: { xp?: number; legendaryEarned?: boolean; statBumps?: Record<string, number>; name?: string | null }) {
    if (typeof s.xp === "number" && isFinite(s.xp)) { this.xp = Math.max(0, s.xp); this.refreshLevel() }
    if (s.legendaryEarned && this.cfg.rarity !== "legendary") this.cfg = { ...this.cfg, rarity: "legendary" }
    if (s.statBumps && typeof s.statBumps === "object") {
      for (const k of Object.keys(s.statBumps)) {
        if (this._soul.stats[k] != null) this._soul.stats[k] = Math.min(100, this._soul.stats[k] + (Number(s.statBumps[k]) || 0))
      }
    }
    if (s.name) this._soul.name = s.name
    this.emitInfo()
  }

  measure() {
    const comp = this.dom.composer, cv = this.dom.petCanvas; if (!comp || !cv) return
    const w = comp.clientWidth
    if (!w || w <= 0) return // not laid out yet — keep the current size; the ResizeObserver re-fires when it gets a width
    const S = this.S; const layerH = Math.round(34 * S)
    this.trackW = w; cv.width = w; cv.height = layerH; cv.style.width = w + "px"; cv.style.height = layerH + "px"
    this._layerH = layerH; if (this.x > w - 16) this.x = Math.max(20, w - 40)
    const ctx = cv.getContext("2d")!; ctx.imageSmoothingEnabled = false; this.ctx = ctx
  }

  private tick(now: number) {
    let dt = (now - this.last) / 1000; this.last = now; if (dt > 0.05) dt = 0.05
    if (!this.reduced) this.update(dt)
    this.tickOverlays() // position hit/bubble + expire bubbles EVERY frame, even under reduced motion
    this.draw()
    this.raf = requestAnimationFrame(this.tick)
  }

  // Wall-clock bubble expiry + overlay positioning — must run regardless of reduced-motion so the
  // hover card, hit-area and speech bubbles work (they used to live in update(), which reduced-motion skips).
  private tickOverlays() {
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now()
    if (this._bubbleUntil && nowMs > this._bubbleUntil) {
      const b = this.dom.bubble; if (b) { b.style.opacity = "0"; b.style.transform = "translate(-50%,4px)" }
      this._bubbleUntil = 0
    }
    this.positionOverlays()
  }

  private update(dt: number) {
    this.time += dt; this.actT += dt; this.phase += dt * 1.6
    this.blinkNext -= dt; if (this.blinkNext <= 0) { this.blinkOn = !this.blinkOn; this.blinkNext = this.blinkOn ? 0.12 : (1 + this._rng() * 3.5) }
    if (this.bounce) { this.bounce.t += dt; const total = this.bounce.dur * this.bounce.n; if (this.bounce.t >= total) { this.jump = 0; this.jumpActive = false; this.bounce = null } else { const local = (this.bounce.t % this.bounce.dur) / this.bounce.dur; this.jump = Math.sin(Math.PI * local) * this.bounce.h; this.jumpActive = true } }
    const gait = this.SP[this.cfg.species].gait
    if (this.act === "walk") {
      let spd = gait === "slide" ? 12 : gait === "float" ? 34 : gait === "hop" ? 30 : 44
      spd *= this.S
      if (this.targetX != null) { const d = this.targetX - this.x; this.facing = d >= 0 ? 1 : -1; this.x += Math.sign(d) * Math.min(Math.abs(d), spd * dt); this.stridePhase += spd * dt / (6 * this.S); if (Math.abs(d) < 2) { this.x = this.targetX; this.targetX = null; const cb = this.afterWalk; this.afterWalk = null; if (cb) cb(); else this.chooseNext() } }
    }
    if (this.x < 20) this.x = 20; if (this.x > this.trackW - 20) this.x = this.trackW - 20
    if (this.actT >= this.actDur && this.act !== "walk") {
      if (this.act === "celebrate" || this.act === "wave" || this.act === "hop") { this.jump = 0; this.jumpActive = false; this.bounce = null }
      this.chooseNext()
    }
    if (this.cfg.autonomous && !this.busy && !this.hovered && !this.sleeping && (this.act === "idle" || this.act === "sit") && this.time - this.idleSince > 14) this.forceSleep()
  }

  private positionOverlays() {
    const S = this.S, hit = this.dom.hit, bub = this.dom.bubble, layerH = this._layerH || 100
    const s = this.SP[this.cfg.species]
    const bodyW = Math.round((s.w + 4) * S)
    // Hit area = just the pet's rough body box at the BOTTOM of the band, NOT the full ~102px layer —
    // otherwise the invisible click-catcher covers the composer's plan-approve bar / menus above it.
    const bodyH = Math.max(Math.round(14 * S), Math.round((s.h + s.ear + 8) * S))
    const petLeft = Math.round(this.x - bodyW / 2)
    if (hit) { hit.style.left = petLeft + "px"; hit.style.width = bodyW + "px"; hit.style.height = bodyH + "px"; hit.style.bottom = "0px" }
    if (bub && this._bubbleUntil) { bub.style.left = Math.round(this.x) + "px"; bub.style.bottom = (layerH + 4) + "px" }
  }

  private draw() {
    const ctx = this.ctx; if (!ctx) return; const S = this.S, cw = this.trackW, ch = this._layerH
    ctx.clearRect(0, 0, cw, ch)
    const pose = this.computePose()
    const jw = Math.max(0.3, 1 - this.jump / 9)
    const sw = Math.round((this.SP[this.cfg.species].w + 3) * S * jw)
    ctx.fillStyle = "rgba(0,0,0," + (0.22 * jw) + ")"
    const scx = Math.round(this.x)
    ctx.fillRect(scx - Math.round(sw / 2), ch - Math.round(1.5 * S), sw, Math.max(2, Math.round(1.6 * S)))
    ctx.fillRect(scx - Math.round(sw / 2) + Math.round(S), ch - Math.round(2.5 * S), sw - 2 * Math.round(S), Math.round(S))
    const sprite = this.composeSprite(pose)
    const drawW = 32 * S, drawH = 32 * S
    const left = Math.round(this.x - 16 * S)
    const top = Math.round(ch - this.PIVY * S - this.jump * S)
    ctx.imageSmoothingEnabled = false
    ctx.save()
    if (this.facing < 0) { ctx.translate(left + drawW, 0); ctx.scale(-1, 1); ctx.drawImage(sprite, 0, 0, 32, 32, 0, top, drawW, drawH) }
    else { ctx.drawImage(sprite, 0, 0, 32, 32, left, top, drawW, drawH) }
    ctx.restore()
  }

  // ---------- color utils ----------
  private hx(h: string): number[] { h = h.replace("#", ""); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] }
  private th(r: number, g: number, b: number): string { const c = (n: number) => ("0" + Math.max(0, Math.min(255, Math.round(n))).toString(16)).slice(-2); return "#" + c(r) + c(g) + c(b) }
  private mix(a: string, b: string, t: number): string { const A = this.hx(a), B = this.hx(b); return this.th(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t) }
  private scaleHex(h: string, f: number): string { const A = this.hx(h); return this.th(A[0] * f, A[1] * f, A[2] * f) }
  private pal(sp: Species): any { if (this._pc[sp]) return this._pc[sp]; const s = this.SP[sp]; const base = s.base, acc = s.acc; const P = { base, shade: this.scaleHex(base, 0.82), hi: this.mix(base, "#ffffff", 0.42), acc, accHi: this.mix(acc, "#ffffff", 0.35), accSh: this.scaleHex(acc, 0.82), belly: s.belly || this.mix(base, "#ffffff", 0.55), feet: s.feet || acc }; this._pc[sp] = P; return P }
  private gs(): Species { return this.cfg.species }
  private gh(): Hat { return this.cfg.hat }
  private gr(): Rarity { return this.cfg.rarity }
  private gsh(): boolean { return this.cfg.shiny }

  // ---------- pixel painter ----------
  private pr(px: Px, x: number, y: number, w: number, h: number, c: string, a?: number) { const g = px.x; g.globalAlpha = (a == null ? 1 : a); g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))); g.globalAlpha = 1 }
  private ps(px: Px, x: number, y: number, c: string, a?: number) { this.pr(px, x, y, 1, 1, c, a) }
  private pblob(px: Px, cx: number, cy: number, rx: number, ry: number, c: string, a?: number) { for (let y = Math.round(cy - ry); y <= Math.round(cy + ry); y++) { const t = (y - cy) / ry; const w = Math.sqrt(Math.max(0, 1 - t * t)) * rx; if (w < 0.3) continue; const x0 = Math.round(cx - w), x1 = Math.round(cx + w); this.pr(px, x0, y, x1 - x0 + 1, 1, c, a) } }

  private metrics(pose: Pose): Metrics {
    const sp = this.gs(), s = this.SP[sp]
    let rx = s.w / 2, ry = s.h / 2
    rx *= (1 + pose.squash * 0.14); ry *= (1 - pose.squash * 0.20)
    const feetY = this.PIVY
    const bodyBot = feetY - 1 - (pose.sit ? -1 : 0)
    const cy = bodyBot - ry + pose.bob
    const topY = cy - ry
    // face anchor — where eyes+mouth sit (overridden for necked/stalked/shelled species).
    // The canonical sprite faces RIGHT while walking; it faces the viewer when idle.
    const FB = pose.moving ? 2 : 0
    let faceX = 16 + FB, faceY = Math.round(cy + ry * 0.12), gap = 3, headTop = topY - s.ear
    if (sp === "chonk" || sp === "capybara") gap = 4
    else if (sp === "snail") { faceX = 19; gap = 3; headTop = topY - 2 }
    else if (sp === "turtle") { faceY = Math.round(cy + 2); gap = 3 }
    return { cx: 16, cy, rx, ry, topY, botY: bodyBot, feetY, faceX, faceY, gap, headTop, ear: s.ear }
  }

  private drawBody(px: Px, m: Metrics) { const P = this.pal(this.gs()); this.pblob(px, m.cx, m.cy + 0.5, m.rx, m.ry, P.shade); this.pblob(px, m.cx, m.cy - 0.5, m.rx - 0.4, m.ry - 0.6, P.base); this.pblob(px, m.cx - m.rx * 0.34, m.cy - m.ry * 0.44, m.rx * 0.42, m.ry * 0.34, P.hi) }

  private drawLegs(px: Px, m: Metrics, pose: Pose) {
    const s = this.SP[this.gs()]; if (!s.legs) return
    const P = this.pal(this.gs())
    const legTop = Math.round(m.botY - 1)
    let legLen = m.feetY - legTop; if (pose.sit) legLen = Math.max(1, legLen - 1); legLen = Math.max(2, legLen)
    let off = 0
    if (pose.legStep >= 0) { const st = pose.legStep; off = [-1, 0, 1, 0][st] }
    if (pose.tuck) legLen = Math.max(1, legLen - 2)
    const lx = m.cx - 3 - off, rx = m.cx + 1 + off
    const lh = legLen - (pose.legStep === 0 ? 1 : 0), rh = legLen - (pose.legStep === 2 ? 1 : 0)
    this.pr(px, lx, m.feetY - lh, 2, lh, P.feet); this.pr(px, rx, m.feetY - rh, 2, rh, P.feet)
    this.pr(px, lx, m.feetY - 1, 2, 1, P.accSh || P.feet); this.pr(px, rx, m.feetY - 1, 2, 1, P.accSh || P.feet)
  }

  private drawFeatures(px: Px, m: Metrics) {
    const sp = this.gs(), P = this.pal(sp), t = this.time; const cx = m.cx, fx = m.faceX
    if (sp === "duck") { this.pr(px, fx - 1, m.faceY + 3, 3, 2, P.acc); this.ps(px, fx + 2, m.faceY + 3, P.acc); this.ps(px, fx, m.faceY + 4, P.accSh); this.pr(px, cx, m.topY - 2, 1, 2, P.acc); this.ps(px, cx - 1, m.topY - 2, P.acc) }
    else if (sp === "goose") { this.pr(px, fx - 1, m.faceY + 3, 4, 2, P.acc); this.ps(px, fx + 3, m.faceY + 3, P.acc); this.ps(px, fx, m.faceY + 4, P.accSh); this.pr(px, cx, m.topY - 2, 1, 2, P.acc) }
    else if (sp === "cat") { this._ears(px, m, P.base, P.acc); this._whisk(px, m) }
    else if (sp === "chonk") { this._ears(px, m, P.base, P.acc); this.pblob(px, cx, m.cy + m.ry * 0.55, m.rx * 0.55, m.ry * 0.35, P.hi, 0.5) }
    else if (sp === "dragon") { const wx = Math.round(cx - m.rx), wy = Math.round(m.cy - 1); this.pr(px, wx - 1, wy - 1, 3, 2, P.accSh); this.pr(px, wx - 2, wy + 1, 2, 2, P.accSh); this.pr(px, wx, wy + 1, 2, 2, P.accSh); this.ps(px, wx - 2, wy + 3, P.accSh); this.ps(px, wx + 1, wy + 3, P.accSh); this.ps(px, wx - 1, wy - 2, this.mix(P.acc, "#ffffff", 0.25)); this.pr(px, cx - 3, m.topY - 2, 1, 2, P.acc); this.ps(px, cx - 4, m.topY - 3, P.acc); this.pr(px, cx + 3, m.topY - 2, 1, 2, P.acc); this.ps(px, cx + 4, m.topY - 3, P.acc) }
    else if (sp === "octopus") { const legs = 6, base = Math.round(cx - m.rx); for (let i = 0; i < legs; i++) { const x = base + Math.round(i * (m.rx * 2) / (legs - 1)) - 1; const dh = ((i + Math.floor(t * 4)) % 2) ? 1 : 0; this.pr(px, x, m.botY, 2, 3 + dh, P.acc); this.ps(px, x, m.botY + 3 + dh, P.accSh) } }
    else if (sp === "owl") { this.pr(px, cx - m.rx + 1, m.topY - 2, 2, 3, P.base); this.pr(px, cx + m.rx - 2, m.topY - 2, 2, 3, P.base); this.ps(px, cx - m.rx + 1, m.topY - 3, P.base); this.ps(px, cx + m.rx - 1, m.topY - 3, P.base); this.pr(px, fx, m.faceY + 2, 2, 2, P.acc); this.ps(px, fx, m.faceY + 4, P.accSh); this.pblob(px, cx, m.cy + m.ry * 0.55, m.rx * 0.55, m.ry * 0.35, P.belly) }
    else if (sp === "penguin") { this.pblob(px, cx, m.cy + 2.2, m.rx - 2.2, m.ry - 1.9, P.belly); this.pblob(px, fx, m.faceY + 0.5, 3.2, 2.8, P.belly); this.pr(px, fx - 1, m.faceY + 3, 3, 2, P.acc); this.ps(px, fx + 2, m.faceY + 3, P.acc); this.pr(px, cx - m.rx + 0.5, m.cy, 2, 4, P.shade); this.pr(px, cx + m.rx - 1.5, m.cy, 1, 4, P.shade) }
    else if (sp === "turtle") { this.pblob(px, cx, m.cy - 2.5, m.rx - 0.4, m.ry - 0.5, P.acc); this.pblob(px, cx, m.cy - 3, m.rx - 2.4, m.ry - 2, this.mix(P.acc, "#ffffff", 0.3)); this.ps(px, cx - 3, m.cy - 3, P.accSh); this.ps(px, cx + 3, m.cy - 3, P.accSh); this.ps(px, cx, m.cy - 1, P.accSh); this.ps(px, cx - 2, m.cy - 1, P.accSh); this.ps(px, cx + 2, m.cy - 1, P.accSh) }
    else if (sp === "snail") { const shx = cx - m.rx + 3, shy = m.cy - 1.5, sr = Math.min(m.ry + 0.5, m.rx * 0.68); this.pblob(px, shx, shy, sr + 0.5, sr + 0.5, P.accSh); this.pblob(px, shx, shy, sr - 0.5, sr - 0.5, P.acc); this.ps(px, shx, shy, P.accSh); this.ps(px, shx + 1, shy, P.accSh); this.ps(px, shx + 1, shy - 1, P.accSh); this.ps(px, shx, shy - 2, P.accSh); this.ps(px, shx - 1, shy - 1, P.accSh); this.ps(px, shx - 2, shy + 1, P.accSh); this.ps(px, shx + 1, shy + 2, P.accSh); this.pr(px, fx - 1, m.faceY - 5, 1, 3, P.base); this.ps(px, fx - 1, m.faceY - 6, P.base); this.pr(px, fx + 1, m.faceY - 5, 1, 3, P.base); this.ps(px, fx + 1, m.faceY - 6, P.base) }
    else if (sp === "ghost") { const b = m.botY + 1; for (let x = Math.round(cx - m.rx); x <= Math.round(cx + m.rx); x++) { const w = Math.round(Math.sin((x + t * 4) * 1.1) * 0.5 + 1.2); this.pr(px, x, b, 1, w, P.base) } }
    else if (sp === "axolotl") { for (const dir of [-1, 1]) { const bx = cx + dir * Math.round(m.rx - 0.5); this.pr(px, bx, m.faceY - 2, 1, 2, P.acc); this.ps(px, bx + dir, m.faceY - 3, P.acc); this.pr(px, bx, m.faceY, 1, 2, P.acc); this.ps(px, bx + dir, m.faceY + 1, P.acc); this.pr(px, bx, m.faceY + 2, 1, 2, P.acc) } }
    else if (sp === "capybara") { this.pr(px, cx - m.rx + 1, m.topY, 2, 2, P.base); this.pr(px, cx + m.rx - 3, m.topY, 2, 2, P.base); this.pblob(px, fx, m.faceY + 3, m.rx * 0.5, 1.6, P.accSh) }
    else if (sp === "cactus") { this.pr(px, cx - m.rx - 1, m.cy, 2, 3, P.base); this.pr(px, cx - m.rx - 1, m.cy - 1, 1, 2, P.base); this.pr(px, cx + m.rx - 1, m.cy - 1, 2, 3, P.base); this.pr(px, cx + m.rx, m.cy - 2, 1, 2, P.base); for (let y = m.topY + 2; y < m.botY - 1; y += 3) { this.ps(px, cx - 3, y, P.shade); this.ps(px, cx + 3, y, P.shade); this.ps(px, cx, y + 1, P.shade) } this.pr(px, cx - 1, m.topY - 2, 3, 1, P.acc); this.pr(px, cx, m.topY - 3, 1, 3, P.acc); this.ps(px, cx, m.topY - 2, P.accHi) }
    else if (sp === "robot") { this.pr(px, cx, m.topY - 3, 1, 3, P.accSh); this.pblob(px, cx, m.topY - 4, 1.4, 1.4, "#ff7a9c"); this.ps(px, cx - m.rx, m.cy, P.accSh); this.ps(px, cx + m.rx - 1, m.cy, P.accSh) }
    else if (sp === "rabbit") { this.pr(px, cx - 3, m.topY - 7, 2, 8, P.base); this.pr(px, cx + 2, m.topY - 7, 2, 8, P.base); this.pr(px, cx - 3, m.topY - 6, 2, 5, P.acc); this.pr(px, cx + 2, m.topY - 6, 2, 5, P.acc); this.ps(px, cx - 3, m.topY - 7, P.base); this.ps(px, cx + 3, m.topY - 7, P.base) }
    else if (sp === "mushroom") { this.pblob(px, cx, m.cy + 1.5, m.rx - 1, m.ry - 1, P.belly); this.pblob(px, cx, m.topY + 2, m.rx + 0.6, 3.6, P.base); this.pr(px, cx - Math.round(m.rx), m.topY + 2, Math.round(m.rx * 2) + 1, 2, P.base); this.pblob(px, cx - 3, m.topY + 1, 1.2, 1.2, "#ffffff"); this.pblob(px, cx + 2, m.topY, 1.2, 1.2, "#ffffff"); this.ps(px, cx + 1, m.topY + 3, "#ffffff") }
    else if (sp === "blob") { this.ps(px, cx + m.rx - 2, m.cy + m.ry - 1, P.hi); this.pr(px, cx - 1, m.topY, 2, 1, P.hi, 0.55) }
  }
  private _ears(px: Px, m: Metrics, base: string, inner: string) { const cx = m.cx; this.pr(px, cx - m.rx + 1, m.topY - 2, 2, 3, base); this.ps(px, cx - m.rx + 2, m.topY - 3, base); this.ps(px, cx - m.rx + 2, m.topY - 1, inner); this.pr(px, cx + m.rx - 2, m.topY - 2, 2, 3, base); this.ps(px, cx + m.rx - 3, m.topY - 3, base); this.ps(px, cx + m.rx - 2, m.topY - 1, inner) }
  private _whisk(px: Px, m: Metrics) { const cx = m.faceX, y = m.faceY + 2, P = this.pal(this.gs()); this.pr(px, cx - m.rx - 2, y, 2, 1, P.shade); this.pr(px, cx + m.rx, y, 2, 1, P.shade) }

  private drawEyes(px: Px, m: Metrics, pose: Pose) {
    const cx = m.faceX, y = m.faceY, gap = m.gap
    const lx = cx - gap, rx = cx + gap - 1
    this._eye(px, lx, y, pose.eye); this._eye(px, rx, y, pose.eye)
    if (pose.eye !== "closed" && pose.eye !== "happy" && pose.eye !== "°") { this.ps(px, lx - 1, y + 2, this.BLUSH); this.ps(px, rx + 1, y + 2, this.BLUSH) }
  }
  private _eye(px: Px, x: number, y: number, st: string) {
    const E = this.EYE, W = this.WHITE
    if (st === "closed") { this.pr(px, x, y + 1, 2, 1, E); return }
    if (st === "°") { this.pr(px, x, y + 1, 2, 1, E); this.ps(px, x, y, E, 0.5); return }
    if (st === "happy") { this.ps(px, x, y + 1, E); this.ps(px, x + 1, y, E); this.ps(px, x + 2, y + 1, E); return }
    if (st === "×") { this.ps(px, x, y, E); this.ps(px, x + 1, y + 1, E); this.ps(px, x + 1, y, E, 0.6); this.ps(px, x, y + 1, E, 0.6); return }
    if (st === "✦") { this.ps(px, x, y + 1, "#fff5c8"); this.ps(px, x + 2, y + 1, "#fff5c8"); this.ps(px, x + 1, y, "#fff5c8"); this.ps(px, x + 1, y + 2, "#fff5c8"); this.pr(px, x, y, 3, 3, "#ffcf5a", 0.55); this.ps(px, x + 1, y + 1, E); return }
    if (st === "◉") { this.pr(px, x, y, 2, 2, E); this.ps(px, x, y, "#fff", 0.9); return }
    if (st === "@") { const f = Math.floor(this.time * 8) % 4; this.pr(px, x, y, 2, 2, E); this.ps(px, x + (f % 2), y + (f > 1 ? 1 : 0), "#fff", 0.85); return }
    this.pr(px, x, y, 2, 2, E); this.ps(px, x, y, W)
  }

  private drawMouth(px: Px, m: Metrics, pose: Pose) {
    const cx = m.faceX, y = m.faceY + 3, sp = this.gs()
    if (pose.mouth === "none") return
    if (sp === "cat" || sp === "chonk" || sp === "rabbit" || sp === "capybara" || sp === "dragon") this.ps(px, cx, m.faceY + 2, "#e0899a") // little nose
    const beaked = sp === "duck" || sp === "goose" || sp === "penguin"
    if (beaked && (pose.mouth === "dot" || pose.mouth === "line")) return // beak already reads as the mouth
    if (pose.mouth === "smile") { this.ps(px, cx - 1, y, this.EYE); this.ps(px, cx, y + 1, this.EYE); this.ps(px, cx + 1, y, this.EYE); return }
    if (pose.mouth === "sad") { this.ps(px, cx - 1, y + 1, this.EYE); this.ps(px, cx, y, this.EYE); this.ps(px, cx + 1, y + 1, this.EYE); return }
    if (pose.mouth === "line") { this.pr(px, cx - 1, y, 2, 1, this.EYE); return }
    this.ps(px, cx, y, this.EYE)
  }

  private drawHat(px: Px, m: Metrics) {
    const type = this.gh(); if (type === "none") return
    const cx = m.cx, hy = m.headTop - 1
    if (type === "crown") { this.pr(px, cx - 3, hy - 1, 7, 2, "#ffcf5a"); this.ps(px, cx - 3, hy - 2, "#ffcf5a"); this.ps(px, cx, hy - 3, "#ffcf5a"); this.ps(px, cx + 3, hy - 2, "#ffcf5a"); this.ps(px, cx, hy, "#ff7a9c") }
    else if (type === "tophat") { this.pr(px, cx - 4, hy, 9, 1, "#20202a"); this.pr(px, cx - 2, hy - 4, 5, 4, "#20202a"); this.pr(px, cx - 2, hy - 1, 5, 1, "#ff7a9c") }
    else if (type === "propeller") { this.pblob(px, cx, hy, 3.5, 1.8, "#58c3f5"); const f = Math.floor(this.time * 10) % 2; if (f) this.pr(px, cx - 3, hy - 2, 7, 1, "#e8e8ee"); else this.pr(px, cx, hy - 3, 1, 3, "#e8e8ee"); this.ps(px, cx, hy - 1, "#ffcf5a") }
    else if (type === "halo") { this.pr(px, cx - 3, hy - 2, 7, 1, "#ffe08a", 0.95); this.ps(px, cx - 3, hy - 1, "#ffe08a", 0.6); this.ps(px, cx + 3, hy - 1, "#ffe08a", 0.6) }
    else if (type === "wizard") { this.ps(px, cx, hy - 4, "#8a6cff"); this.pr(px, cx - 1, hy - 3, 3, 2, "#8a6cff"); this.pr(px, cx - 2, hy - 1, 5, 2, "#8a6cff"); this.pr(px, cx - 3, hy + 1, 7, 1, "#6a4cd8"); this.ps(px, cx, hy - 2, "#fff5c8"); this.ps(px, cx + 1, hy, "#fff5c8") }
    else if (type === "beanie") { this.pblob(px, cx, hy + 1, 4, 2.4, "#ff7a9c"); this.pr(px, cx - 4, hy + 1, 9, 1, this.mix("#ff7a9c", "#fff", 0.3)); this.ps(px, cx, hy - 3, "#fff") }
    else if (type === "tinyduck") { this.pblob(px, cx, hy - 1, 2.4, 2, "#ffde7a"); this.pr(px, cx + 1, hy - 1, 3, 1, "#ff9e3d"); this.ps(px, cx - 1, hy - 2, this.EYE) }
  }

  private drawAura(px: Px, m: Metrics) {
    const R = this.RARITY[this.gr()]; if (!R || R.stars < 2) return; const t = this.time
    const pulse = 0.10 + Math.sin(t * 2.5) * 0.05
    if (R.stars >= 3) this.pblob(px, m.cx, m.cy, m.rx + 2.5, m.ry + 2.5, R.c, pulse)
    this.pblob(px, m.cx, m.cy, m.rx + 1, m.ry + 1, R.c, pulse + 0.08)
    if (R.stars >= 4) { for (let i = 0; i < 3; i++) { const a = t * 2 + i * 2.09; this.ps(px, m.cx + Math.cos(a) * (m.rx + 3), m.cy + Math.sin(a) * (m.ry + 3), R.c, 0.9) } }
    if (R.stars >= 5) { for (let i = 0; i < 5; i++) { const a = -t * 1.6 + i * 1.256; const fl = (Math.sin(t * 6 + i) * 0.5 + 0.5); this.ps(px, m.cx + Math.cos(a) * (m.rx + 3.5), m.cy + Math.sin(a) * (m.ry + 3), "#fff5c8", fl) } }
  }

  private drawShiny(px: Px, m: Metrics) {
    if (!this.gsh()) return; const t = this.time
    const sp: number[][] = [[m.cx - m.rx, m.topY + 1], [m.cx + m.rx - 1, m.cy], [m.cx, m.topY - 1]]
    sp.forEach((p, i) => { const fl = Math.sin(t * 5 + i * 2) * 0.5 + 0.5; if (fl > 0.4) { this.ps(px, p[0], p[1], "#fff5c8", fl); this.ps(px, p[0] - 1, p[1], "#fff", fl * 0.5); this.ps(px, p[0] + 1, p[1], "#fff", fl * 0.5); this.ps(px, p[0], p[1] - 1, "#fff", fl * 0.5); this.ps(px, p[0], p[1] + 1, "#fff", fl * 0.5) } })
    const gx = m.cx - m.rx + ((t * 10) % (m.rx * 2)); this.ps(px, gx, m.cy - m.ry * 0.5, "#ffffff", 0.7)
  }

  private drawFx(px: Px, m: Metrics, pose: Pose) {
    const t = this.time, cx = m.cx
    if (pose.fx === "zzz") { for (let k = 0; k < 3; k++) { const yo = (t * 3 + k) % 3; const y = m.headTop - 2 - k * 3 - yo; const x = cx + 3 + k; const a = 1 - k * 0.28 - yo * 0.2; this.pr(px, x, y, 3, 1, "#cfd2ea", a); this.ps(px, x + 2, y + 1, "#cfd2ea", a); this.ps(px, x + 1, y + 1, "#cfd2ea", a); this.ps(px, x, y + 1, "#cfd2ea", a); this.pr(px, x, y + 2, 3, 1, "#cfd2ea", a) } }
    else if (pose.fx === "q") { const y = m.headTop - 6; this.pr(px, cx - 1, y, 3, 1, "#58c3f5"); this.ps(px, cx + 1, y + 1, "#58c3f5"); this.ps(px, cx, y + 2, "#58c3f5"); this.ps(px, cx, y + 4, "#58c3f5") }
    else if (pose.fx === "dots") { const y = m.headTop - 3; const n = Math.floor(t * 3) % 3 + 1; for (let i = 0; i < n; i++) this.ps(px, cx - 2 + i * 2, y, "#8f8f99") }
    else if (pose.fx === "confetti") { const cols = ["#ff7a9c", "#58c3f5", "#ffcf5a", "#7ee787", "#c9a2ff"]; for (let i = 0; i < 9; i++) { const y = m.topY - 3 + ((t * 16 + i * 5) % 20); const x = cx - 8 + ((i * 7 + Math.floor(t * 3)) % 16); this.ps(px, x, y, cols[i % 5]) } }
  }

  private computePose(): Pose {
    const st = this.cfg, act = this.act, ph = this.phase
    const pose: Pose = { eye: st.eye, mouth: "dot", bob: 0, squash: 0, legStep: -1, fx: null, sit: false, arm: 0, tuck: false, moving: act === "walk" }
    if (this.blinkOn && st.eye === "·") pose.eye = "closed"
    switch (act) {
      case "idle": { const b = Math.floor(ph * 1.6) % 3; pose.bob = (b === 1 ? -1 : 0); if (b === 2) pose.squash = 0.22; break }
      case "walk": { pose.legStep = Math.floor(this.stridePhase) % 4; pose.bob = (pose.legStep === 1 || pose.legStep === 3) ? -1 : 0; const g = this.SP[st.species].gait; if (g === "hop") { pose.bob = -Math.round(Math.abs(Math.sin(this.stridePhase * 1.5)) * 3); pose.legStep = -1; pose.tuck = pose.bob < -1 } if (g === "float") { pose.bob = Math.round(Math.sin(this.time * 3) * 1.5); pose.legStep = -1 } if (g === "slide") { pose.legStep = -1; pose.bob = 0 } break }
      case "sit": { pose.sit = true; pose.bob = 1; break }
      case "sleep": { pose.sit = true; pose.bob = 1; pose.eye = "closed"; pose.mouth = "none"; pose.fx = "zzz"; break }
      case "think": { pose.eye = "@"; pose.mouth = "line"; pose.fx = "dots"; const b = Math.floor(ph * 2.5) % 2; pose.bob = b ? -1 : 0; break }
      case "awaiting": { pose.eye = "◉"; pose.fx = "q"; const b = Math.floor(ph * 1.8) % 2; pose.bob = b ? -1 : 0; break }
      case "sad": { pose.eye = "°"; pose.mouth = "sad"; pose.bob = 1; break }
      case "wave": { pose.eye = "happy"; pose.mouth = "smile"; pose.arm = 1; break }
      case "celebrate": { pose.eye = "✦"; pose.mouth = "smile"; pose.fx = "confetti"; break }
      default: break
    }
    if (this.jumpActive) { pose.tuck = true; if (this.jump < 1.4) pose.squash = 0.5; else pose.squash = -0.14 }
    if (this.SP[st.species].gait === "float") pose.legStep = -1
    return pose
  }

  private composeSprite(pose: Pose): HTMLCanvasElement {
    const px = this._px; px.x.clearRect(0, 0, 32, 32)
    const m = this.metrics(pose); this._m = m
    this.drawAura(px, m)
    this.drawLegs(px, m, pose)
    this.drawBody(px, m)
    this.drawFeatures(px, m)
    if (pose.arm) { const P = this.pal(this.gs()); const ax = m.cx + Math.round(m.rx) - 1, ay = m.cy - Math.round(m.ry * 0.2) - Math.round(Math.abs(Math.sin(this.time * 12)) * 1); this.pr(px, ax, ay - 2, 2, 3, P.base); this.ps(px, ax, ay - 3, P.base) }
    this.drawEyes(px, m, pose)
    this.drawMouth(px, m, pose)
    this.drawHat(px, m)
    this.drawShiny(px, m)
    this.drawFx(px, m, pose)
    return px.c
  }

  // ---------- behavior ----------
  private setAct(a: string, dur?: number) { this.act = a; this.actT = 0; this.actDur = (dur == null ? Infinity : dur); if (a !== "sleep") this.sleeping = false; if (a === "wave") this.startBounce(4, 0.42, 1); if (a === "hop") this.startBounce(8, 0.5, 1); if (a === "celebrate") this.startBounce(7, 0.42, 3) }
  private gotoX(tx: number, after?: () => void) { this.targetX = tx; this.afterWalk = after || null; this.act = "walk"; this.actT = 0; this.actDur = Infinity; this.facing = (tx > this.x) ? 1 : -1 }
  private startBounce(h: number, dur: number, n: number) { this.bounce = { t: 0, dur, h, n } }
  private forceSleep() { const cx = (this.x < this.trackW / 2) ? 20 : this.trackW - 20; this.gotoX(cx, () => { this.setAct("sleep", Infinity); this.sleeping = true }) }
  private chooseNext() {
    // Agent is working → stay awake and look busy (think / pace); never fall through to idle-sleep.
    if (this.busy && !this.sleeping) {
      if (this._rng() < 0.6) this.setAct("think", 2 + this._rng() * 2)
      else { const tx = 20 + this._rng() * (this.trackW - 40); this.gotoX(tx, () => this.setAct("think", 1.5 + this._rng() * 1.5)) }
      return
    }
    if (this.sleeping) { this.setAct("sleep", Infinity); return }
    if (!this.cfg.autonomous) { this.setAct("idle", 9999); return }
    // While the pointer hovers the pet, keep it awake and attentive — never nap under the cursor.
    if (this.hovered) {
      if (this._rng() < 0.5) this.setAct("idle", 0.8 + this._rng())
      else { const tx = 20 + this._rng() * (this.trackW - 40); this.gotoX(tx, () => this.setAct("idle", 0.6 + this._rng())) }
      return
    }
    if (this.time - this.idleSince > 14) { this.forceSleep(); return }
    const r = this._rng()
    if (r < 0.4) this.setAct("idle", 1 + this._rng() * 2.5)
    else if (r < 0.78) { const tx = 20 + this._rng() * (this.trackW - 40); this.gotoX(tx, () => this.setAct("idle", 0.6 + this._rng() * 1.5)) }
    else if (r < 0.9) this.setAct("sit", 1.5 + this._rng() * 2)
    else this.setAct("hop", 0.5)
  }
  /** Reflect the agent's working state: while it runs the pet stays awake and looks busy (thinks/paces
   *  the shelf), so it never autonomously falls asleep MID-TURN. Idempotent. */
  setWorking(on: boolean) {
    if (on === this.busy) return
    this.busy = on
    this.idleSince = this.time
    if (on) { this.sleeping = false; this.trigger("think") }
    else if (!this.sleeping) this.setAct("idle", 1.2) // agent finished → settle back to idle (wakes if it had dozed)
  }
  /** Pointer entered/left the pet's hit area: while hovered the pet stays awake and attentive (the
   *  chooseNext + autonomous-sleep guards both honor `hovered`). Entering wakes a sleeping pet with a
   *  perky hop so a nap ends the moment the cursor lands on it — never asleep under the mouse. */
  setHovered(on: boolean) {
    if (on === this.hovered) return
    this.hovered = on
    if (!on) return
    this.idleSince = this.time
    if (this.sleeping) { this.sleeping = false; this.setAct("hop", 0.5); this.bubble("!", 0.8) }
    else if (this.act === "sit" || this.act === "idle") this.setAct("hop", 0.5)
  }
  trigger(kind: TriggerKind) {
    if (!TRIGGER_KINDS.includes(kind)) return // ignore untrusted/unknown kinds from the window event
    if (kind !== "sleep") this.idleSince = this.time
    if (kind === "send") { this.setAct("wave", 0.9); this.bubble("!", 0.9) }
    else if (kind === "think") { this.gotoX(this.trackW * 0.5, () => this.setAct("think", 3.4)); this.bubble("...", 1.2) }
    else if (kind === "awaiting") { const bx = this.trackW - 24 * this.S; this.gotoX(bx, () => this.setAct("awaiting", 4)); this.bubble("need your ok?", 2.2) }
    else if (kind === "verify") { this.setAct("celebrate", 1.9); const gain = 10 + Math.floor(this._rng() * 35); this.addXp(gain); this.bubble("+" + gain + " XP", 2) }
    else if (kind === "level") { this.setAct("celebrate", 2.1); this.addXp(Math.max(1, this._span - this._into)); this.bubble("Level " + this.level + "!", 2.4) }
    else if (kind === "error") { this.setAct("sad", 1.8); this.bubble("NOT DONE…", 1.8) }
    else if (kind === "sleep") { this.forceSleep() }
    else if (kind === "wake") { this.sleeping = false; this.idleSince = this.time; this.setAct("idle", 1.2) }
  }
  private addXp(n: number) { this.xp += n; this.refreshLevel() }
  private refreshLevel() { let lvl = 1, need = 40, rem = this.xp; while (rem >= need) { rem -= need; lvl++; need = Math.round(40 + (lvl - 1) * 22) } this.level = lvl; this._into = rem; this._span = need; this.emitInfo() }
  private bubble(text: string, dur: number) { if (this.cfg.muted) return; this._bubbleUntil = (typeof performance !== "undefined" ? performance.now() : Date.now()) + dur * 1000; const b = this.dom.bubble; if (b) { b.textContent = text; b.style.opacity = "1"; b.style.transform = "translate(-50%,0)" } }

  // ---------- soul / card ----------
  private regenSoul() { const sp = this.cfg.species; const rng = mulberry32(hashStr(this.userId + "|" + sp) + 7); const names = this.NAMES[sp] || ["Buddy"]; this._soul = { name: names[Math.floor(rng() * names.length)], stats: {} }; this.STATS.forEach(([k]) => { this._soul.stats[k] = 15 + Math.floor(rng() * 85) }); this.emitInfo() }
  private syncLabels() { this.emitInfo() }
  private emitInfo() {
    const sp = this.cfg.species, R = this.RARITY[this.cfg.rarity]
    const gl = ({ walk: "walks", float: "floats", slide: "slides", hop: "hops" } as Record<string, string>)[this.SP[sp].gait]
    this.onInfo({
      soulName: this._soul.name, species: sp, speciesLabel: this.SP[sp].ru, gaitLabel: gl,
      rarity: this.cfg.rarity, rarityLabel: R.ru, stars: "★".repeat(R.stars) + "☆".repeat(5 - R.stars),
      shiny: this.cfg.shiny, level: this.level, into: this._into, span: this._span,
      xpLabel: this._into + " / " + this._span + " XP", stats: { ...this._soul.stats },
    })
  }

  /** Draw the pet large into a card canvas (used by the hover card). */
  drawCardPet(cv: HTMLCanvasElement) {
    const CS = 6; cv.width = 32 * CS; cv.height = 32 * CS
    const ctx = cv.getContext("2d")!; ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, cv.width, cv.height)
    const pose = this.computePose(); pose.eye = this.cfg.eye; pose.fx = null; pose.bob = Math.floor(this.time * 1.4) % 2 ? -1 : 0
    const sprite = this.composeSprite(pose)
    ctx.drawImage(sprite, 0, 0, 32, 32, 0, 2 * CS, 32 * CS, 32 * CS)
  }
}
