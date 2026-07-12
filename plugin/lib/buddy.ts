// FABULA buddy — pure core of the Proof-of-Done COMPANION (no IO). Ported from the buddy system, with
// ONE decisive change that makes it FABULA's: a buddy grows ONLY from VERIFIED work, never from time.
//
// Bones (species, rarity, eye, hat, shiny, base stats) are DETERMINISTIC from hash(userId) — regenerated
// on every read, so a rename can't break a stored buddy and a user can't hand-edit their way to a rarer
// pet. The soul (name, personality) is authored once at hatch and stored. Everything that changes —
// XP/level, stat bumps, the legendary upgrade — is EARNED, and only ever from a receipt that PASSED:
//   • a NOT DONE receipt grants nothing (growth from proven work only),
//   • gates on the receipt bump matching stats (verify→DEBUGGING, rewind→PATIENCE, …),
//   • witnesses multiply XP; three published receipts each with ≥3 witnesses upgrade the pet to legendary.
//
// The plugin (fabula-buddy.ts) does the fs, reads real receipts + the witnesses side-car, and renders.
// All the decisions (the roll, the XP curve, the state transition, the sprites) are here and unit-tested.

export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const
export type Rarity = (typeof RARITIES)[number]

// Plain string literals: plugin runtime code is NOT bundled into the app's dist/assets (the only place the
// foreign-string grep runs), so the source-code canary obfuscation from the original is unnecessary here.
export const SPECIES = [
  "duck", "goose", "blob", "cat", "dragon", "octopus", "owl", "penguin",
  "turtle", "snail", "ghost", "axolotl", "capybara", "cactus", "robot",
  "rabbit", "mushroom", "chonk",
] as const
export type Species = (typeof SPECIES)[number]

export const EYES = ["·", "✦", "×", "◉", "@", "°"] as const
export type Eye = (typeof EYES)[number]

export const HATS = ["none", "crown", "tophat", "propeller", "halo", "wizard", "beanie", "tinyduck"] as const
export type Hat = (typeof HATS)[number]

export const STAT_NAMES = ["DEBUGGING", "PATIENCE", "CHAOS", "WISDOM", "SNARK"] as const
export type StatName = (typeof STAT_NAMES)[number]

export type CompanionBones = {
  rarity: Rarity
  species: Species
  eye: Eye
  hat: Hat
  shiny: boolean
  stats: Record<StatName, number>
}
export type CompanionSoul = { name: string; personality: string }
export type Companion = CompanionBones & CompanionSoul & { hatchedAt: number }

export const RARITY_WEIGHTS = { common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 } as const satisfies Record<Rarity, number>
export const RARITY_STARS = { common: "★", uncommon: "★★", rare: "★★★", epic: "★★★★", legendary: "★★★★★" } as const satisfies Record<Rarity, string>
const RARITY_FLOOR: Record<Rarity, number> = { common: 5, uncommon: 15, rare: 25, epic: 35, legendary: 50 }

// ── Deterministic roll ────────────────────────────────────────────────────────────────────────────────
// Mulberry32 — tiny seeded PRNG, good enough for picking ducks.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// FNV-1a — pure + deterministic across environments (unit tests must be reproducible).
export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!
}

function rollRarity(rng: () => number): Rarity {
  const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0)
  let roll = rng() * total
  for (const rarity of RARITIES) {
    roll -= RARITY_WEIGHTS[rarity]
    if (roll < 0) return rarity
  }
  return "common"
}

// One peak stat, one dump stat, rest scattered. Rarity bumps the floor.
function rollStats(rng: () => number, rarity: Rarity): Record<StatName, number> {
  const floor = RARITY_FLOOR[rarity]
  const peak = pick(rng, STAT_NAMES)
  let dump = pick(rng, STAT_NAMES)
  while (dump === peak) dump = pick(rng, STAT_NAMES)
  const stats = {} as Record<StatName, number>
  for (const name of STAT_NAMES) {
    if (name === peak) stats[name] = Math.min(100, floor + 50 + Math.floor(rng() * 30))
    else if (name === dump) stats[name] = Math.max(1, floor - 10 + Math.floor(rng() * 15))
    else stats[name] = floor + Math.floor(rng() * 40)
  }
  return stats
}

const SALT = "friend-2026-401"
export type Roll = { bones: CompanionBones; inspirationSeed: number }

function rollFrom(rng: () => number): Roll {
  const rarity = rollRarity(rng)
  const bones: CompanionBones = {
    rarity,
    species: pick(rng, SPECIES),
    eye: pick(rng, EYES),
    hat: rarity === "common" ? "none" : pick(rng, HATS),
    shiny: rng() < 0.01,
    stats: rollStats(rng, rarity),
  }
  return { bones, inspirationSeed: Math.floor(rng() * 1e9) }
}

let rollCache: { key: string; value: Roll } | undefined
export function roll(userId: string): Roll {
  const key = userId + SALT
  if (rollCache?.key === key) return rollCache.value
  const value = rollFrom(mulberry32(hashString(key)))
  rollCache = { key, value }
  return value
}
export function rollWithSeed(seed: string): Roll {
  return rollFrom(mulberry32(hashString(seed)))
}

// ── The FABULA twist: growth from VERIFIED work ─────────────────────────────────────────────────────────
// Persisted per project in .fabula/buddy/state.json. Bones are NOT stored (regenerated from userId).
export type BuddyState = {
  soul?: CompanionSoul
  hatchedAt?: number
  xp: number
  statBumps: Partial<Record<StatName, number>>
  fedReceipts: string[] // receiptIds that already granted XP (dedupe — a receipt feeds once)
  legendaryReceipts: string[] // receiptIds published with ≥3 witnesses
  legendaryEarned: boolean
}
export function emptyState(): BuddyState {
  return { xp: 0, statBumps: {}, fedReceipts: [], legendaryReceipts: [], legendaryEarned: false }
}

// A receipt + its witness count, normalized for the pure feed logic.
export type FeedInput = {
  receiptId: string
  passed: boolean
  gates: string[]
  task: string
  witnessCount: number
}

// XP ONLY from proven work: a receipt that did not pass grants nothing.
export function buddyXpFromFeed(f: FeedInput): number {
  if (!f.passed) return 0
  let xp = 10 // base for verified work
  if (f.gates.includes("reproduce") || f.gates.includes("reproduce-gate")) xp += 5
  if (f.gates.includes("change-quiz")) xp += 5
  xp += 10 * Math.max(0, f.witnessCount)
  if (/swe-?bench/i.test(f.task)) xp += 50
  return xp
}

export function bumpStatsFromGates(gates: string[]): Partial<Record<StatName, number>> {
  const bumps: Partial<Record<StatName, number>> = {}
  const add = (k: StatName) => (bumps[k] = (bumps[k] ?? 0) + 1)
  if (gates.includes("verify")) add("DEBUGGING")
  if (gates.includes("rewind")) add("PATIENCE")
  if (gates.includes("escalate")) add("CHAOS")
  if (gates.includes("change-quiz")) add("WISDOM")
  if (gates.includes("witness") || gates.includes("refusal")) add("SNARK")
  return bumps
}

function mergeBumps(a: Partial<Record<StatName, number>>, b: Partial<Record<StatName, number>>): Partial<Record<StatName, number>> {
  const out: Partial<Record<StatName, number>> = { ...a }
  for (const k of STAT_NAMES) if (b[k]) out[k] = (out[k] ?? 0) + b[k]!
  return out
}

// Level curve: level L begins at 25·L·(L-1) XP → 50·L to the next. A base verified receipt (10) is a real
// dent; witnesses / a SWE-bench solve move the needle fast. Pure — no clamping surprises.
export function levelFromXp(xp: number): { level: number; intoLevel: number; span: number; toNext: number } {
  const need = (L: number) => 25 * L * (L - 1)
  let level = 1
  while (need(level + 1) <= xp) level++
  const intoLevel = xp - need(level)
  const span = need(level + 1) - need(level)
  return { level, intoLevel, span, toNext: span - intoLevel }
}

export type FeedResult = {
  gained: number
  alreadyFed: boolean
  reason?: string
  leveledUp: boolean
  level: number
  bumps: Partial<Record<StatName, number>>
  legendaryUpgrade: boolean
  legendaryProgress: number // of 3
}

// Pure state transition. Only a PASSED, not-yet-fed receipt changes anything.
export function applyFeed(state: BuddyState, f: FeedInput): { state: BuddyState; result: FeedResult } {
  const level = levelFromXp(state.xp).level
  if (!f.passed) {
    return { state, result: { gained: 0, alreadyFed: false, reason: "NOT DONE — a buddy grows only from PROVEN work", leveledUp: false, level, bumps: {}, legendaryUpgrade: false, legendaryProgress: state.legendaryReceipts.length } }
  }
  if (state.fedReceipts.includes(f.receiptId)) {
    return { state, result: { gained: 0, alreadyFed: true, leveledUp: false, level, bumps: {}, legendaryUpgrade: false, legendaryProgress: state.legendaryReceipts.length } }
  }
  const gained = buddyXpFromFeed(f)
  const bumps = bumpStatsFromGates(f.gates)
  const legendaryReceipts =
    f.witnessCount >= 3 && !state.legendaryReceipts.includes(f.receiptId)
      ? [...state.legendaryReceipts, f.receiptId]
      : state.legendaryReceipts
  const next: BuddyState = {
    ...state,
    xp: state.xp + gained,
    fedReceipts: [...state.fedReceipts, f.receiptId],
    statBumps: mergeBumps(state.statBumps, bumps),
    legendaryReceipts,
  }
  const legendaryNow = legendaryReceipts.length >= 3
  const legendaryUpgrade = legendaryNow && !state.legendaryEarned
  next.legendaryEarned = state.legendaryEarned || legendaryNow
  const afterLevel = levelFromXp(next.xp).level
  return {
    state: next,
    result: { gained, alreadyFed: false, leveledUp: afterLevel > level, level: afterLevel, bumps, legendaryUpgrade, legendaryProgress: legendaryReceipts.length },
  }
}

function applyStatBumps(base: Record<StatName, number>, bumps: Partial<Record<StatName, number>>): Record<StatName, number> {
  const out = {} as Record<StatName, number>
  for (const k of STAT_NAMES) out[k] = Math.min(100, base[k] + (bumps[k] ?? 0))
  return out
}

// The buddy as displayed: deterministic bones + stored soul + earned growth (effective rarity, bumped stats).
export function getCompanion(userId: string, state: BuddyState): Companion | undefined {
  if (!state.soul || !state.hatchedAt) return undefined
  const { bones } = roll(userId)
  const rarity: Rarity = state.legendaryEarned ? "legendary" : bones.rarity
  return { ...state.soul, hatchedAt: state.hatchedAt, ...bones, rarity, stats: applyStatBumps(bones.stats, state.statBumps) }
}

// ── Sprites (data) ──────────────────────────────────────────────────────────────────────────────────────
// Each sprite is 5 lines tall, 12 wide (after {E}→1char). Line 0 is the hat slot (blank in frames 0-1).
const BODIES: Record<Species, string[][]> = {
  duck: [
    ["            ", "    __      ", "  <({E} )___  ", "   (  ._>   ", "    `--´    "],
    ["            ", "    __      ", "  <({E} )___  ", "   (  ._>   ", "    `--´~   "],
    ["            ", "    __      ", "  <({E} )___  ", "   (  .__>  ", "    `--´    "],
  ],
  goose: [
    ["            ", "     ({E}>    ", "     ||     ", "   _(__)_   ", "    ^^^^    "],
    ["            ", "    ({E}>     ", "     ||     ", "   _(__)_   ", "    ^^^^    "],
    ["            ", "     ({E}>>   ", "     ||     ", "   _(__)_   ", "    ^^^^    "],
  ],
  blob: [
    ["            ", "   .----.   ", "  ( {E}  {E} )  ", "  (      )  ", "   `----´   "],
    ["            ", "  .------.  ", " (  {E}  {E}  ) ", " (        ) ", "  `------´  "],
    ["            ", "    .--.    ", "   ({E}  {E})   ", "   (    )   ", "    `--´    "],
  ],
  cat: [
    ["            ", "   /\\_/\\    ", "  ( {E}   {E})  ", "  (  ω  )   ", "  (\")_(\")   "],
    ["            ", "   /\\_/\\    ", "  ( {E}   {E})  ", "  (  ω  )   ", "  (\")_(\")~  "],
    ["            ", "   /\\-/\\    ", "  ( {E}   {E})  ", "  (  ω  )   ", "  (\")_(\")   "],
  ],
  dragon: [
    ["            ", "  /^\\  /^\\  ", " <  {E}  {E}  > ", " (   ~~   ) ", "  `-vvvv-´  "],
    ["            ", "  /^\\  /^\\  ", " <  {E}  {E}  > ", " (        ) ", "  `-vvvv-´  "],
    ["   ~    ~   ", "  /^\\  /^\\  ", " <  {E}  {E}  > ", " (   ~~   ) ", "  `-vvvv-´  "],
  ],
  octopus: [
    ["            ", "   .----.   ", "  ( {E}  {E} )  ", "  (______)  ", "  /\\/\\/\\/\\  "],
    ["            ", "   .----.   ", "  ( {E}  {E} )  ", "  (______)  ", "  \\/\\/\\/\\/  "],
    ["     o      ", "   .----.   ", "  ( {E}  {E} )  ", "  (______)  ", "  /\\/\\/\\/\\  "],
  ],
  owl: [
    ["            ", "   /\\  /\\   ", "  (({E})({E}))  ", "  (  ><  )  ", "   `----´   "],
    ["            ", "   /\\  /\\   ", "  (({E})({E}))  ", "  (  ><  )  ", "   .----.   "],
    ["            ", "   /\\  /\\   ", "  (({E})(-))  ", "  (  ><  )  ", "   `----´   "],
  ],
  penguin: [
    ["            ", "  .---.     ", "  ({E}>{E})     ", " /(   )\\    ", "  `---´     "],
    ["            ", "  .---.     ", "  ({E}>{E})     ", " |(   )|    ", "  `---´     "],
    ["  .---.     ", "  ({E}>{E})     ", " /(   )\\    ", "  `---´     ", "   ~ ~      "],
  ],
  turtle: [
    ["            ", "   _,--._   ", "  ( {E}  {E} )  ", " /[______]\\ ", "  ``    ``  "],
    ["            ", "   _,--._   ", "  ( {E}  {E} )  ", " /[______]\\ ", "   ``  ``   "],
    ["            ", "   _,--._   ", "  ( {E}  {E} )  ", " /[======]\\ ", "  ``    ``  "],
  ],
  snail: [
    ["            ", " {E}    .--.  ", "  \\  ( @ )  ", "   \\_`--´   ", "  ~~~~~~~   "],
    ["            ", "  {E}   .--.  ", "  |  ( @ )  ", "   \\_`--´   ", "  ~~~~~~~   "],
    ["            ", " {E}    .--.  ", "  \\  ( @  ) ", "   \\_`--´   ", "   ~~~~~~   "],
  ],
  ghost: [
    ["            ", "   .----.   ", "  / {E}  {E} \\  ", "  |      |  ", "  ~`~``~`~  "],
    ["            ", "   .----.   ", "  / {E}  {E} \\  ", "  |      |  ", "  `~`~~`~`  "],
    ["    ~  ~    ", "   .----.   ", "  / {E}  {E} \\  ", "  |      |  ", "  ~~`~~`~~  "],
  ],
  axolotl: [
    ["            ", "}~(______)~{", "}~({E} .. {E})~{", "  ( .--. )  ", "  (_/  \\_)  "],
    ["            ", "~}(______){~", "~}({E} .. {E}){~", "  ( .--. )  ", "  (_/  \\_)  "],
    ["            ", "}~(______)~{", "}~({E} .. {E})~{", "  (  --  )  ", "  ~_/  \\_~  "],
  ],
  capybara: [
    ["            ", "  n______n  ", " ( {E}    {E} ) ", " (   oo   ) ", "  `------´  "],
    ["            ", "  n______n  ", " ( {E}    {E} ) ", " (   Oo   ) ", "  `------´  "],
    ["    ~  ~    ", "  u______n  ", " ( {E}    {E} ) ", " (   oo   ) ", "  `------´  "],
  ],
  cactus: [
    ["            ", " n  ____  n ", " | |{E}  {E}| | ", " |_|    |_| ", "   |    |   "],
    ["            ", "    ____    ", " n |{E}  {E}| n ", " |_|    |_| ", "   |    |   "],
    [" n        n ", " |  ____  | ", " | |{E}  {E}| | ", " |_|    |_| ", "   |    |   "],
  ],
  robot: [
    ["            ", "   .[||].   ", "  [ {E}  {E} ]  ", "  [ ==== ]  ", "  `------´  "],
    ["            ", "   .[||].   ", "  [ {E}  {E} ]  ", "  [ -==- ]  ", "  `------´  "],
    ["     *      ", "   .[||].   ", "  [ {E}  {E} ]  ", "  [ ==== ]  ", "  `------´  "],
  ],
  rabbit: [
    ["            ", "   (\\__/)   ", "  ( {E}  {E} )  ", " =(  ..  )= ", "  (\")__(\")  "],
    ["            ", "   (|__/)   ", "  ( {E}  {E} )  ", " =(  ..  )= ", "  (\")__(\")  "],
    ["            ", "   (\\__/)   ", "  ( {E}  {E} )  ", " =( .  . )= ", "  (\")__(\")  "],
  ],
  mushroom: [
    ["            ", " .-o-OO-o-. ", "(__________)", "   |{E}  {E}|   ", "   |____|   "],
    ["            ", " .-O-oo-O-. ", "(__________)", "   |{E}  {E}|   ", "   |____|   "],
    ["   . o  .   ", " .-o-OO-o-. ", "(__________)", "   |{E}  {E}|   ", "   |____|   "],
  ],
  chonk: [
    ["            ", "  /\\    /\\  ", " ( {E}    {E} ) ", " (   ..   ) ", "  `------´  "],
    ["            ", "  /\\    /|  ", " ( {E}    {E} ) ", " (   ..   ) ", "  `------´  "],
    ["            ", "  /\\    /\\  ", " ( {E}    {E} ) ", " (   ..   ) ", "  `------´~ "],
  ],
}

const HAT_LINES: Record<Hat, string> = {
  none: "",
  crown: "   \\^^^/    ",
  tophat: "   [___]    ",
  propeller: "    -+-     ",
  halo: "   (   )    ",
  wizard: "    /^\\     ",
  beanie: "   (___)    ",
  tinyduck: "    ,>      ",
}

export function renderSprite(bones: CompanionBones, frame = 0): string[] {
  const frames = BODIES[bones.species]
  const body = frames[frame % frames.length]!.map((line) => line.replaceAll("{E}", bones.eye))
  const lines = [...body]
  if (bones.hat !== "none" && !lines[0]!.trim()) lines[0] = HAT_LINES[bones.hat]
  if (!lines[0]!.trim() && frames.every((f) => !f[0]!.trim())) lines.shift()
  return lines
}

export function spriteFrameCount(species: Species): number {
  return BODIES[species].length
}

export function renderFace(bones: CompanionBones): string {
  const eye: Eye = bones.eye
  switch (bones.species) {
    case "duck":
    case "goose":
      return `(${eye}>`
    case "blob":
      return `(${eye}${eye})`
    case "cat":
      return `=${eye}ω${eye}=`
    case "dragon":
      return `<${eye}~${eye}>`
    case "octopus":
      return `~(${eye}${eye})~`
    case "owl":
      return `(${eye})(${eye})`
    case "penguin":
      return `(${eye}>)`
    case "turtle":
      return `[${eye}_${eye}]`
    case "snail":
      return `${eye}(@)`
    case "ghost":
      return `/${eye}${eye}\\`
    case "axolotl":
      return `}${eye}.${eye}{`
    case "capybara":
      return `(${eye}oo${eye})`
    case "cactus":
      return `|${eye}  ${eye}|`
    case "robot":
      return `[${eye}${eye}]`
    case "rabbit":
      return `(${eye}..${eye})`
    case "mushroom":
      return `|${eye}  ${eye}|`
    case "chonk":
      return `(${eye}.${eye})`
  }
}

// A text status card for the tool output — sprite + identity + level bar + stats.
export function renderCard(c: Companion, level: number, intoLevel: number, span: number, toNext: number): string {
  const sprite = renderSprite(c).join("\n")
  const stars = RARITY_STARS[c.rarity]
  const shiny = c.shiny ? " ✨shiny" : ""
  const hat = c.hat !== "none" ? ` · ${c.hat}` : ""
  const filled = span > 0 ? Math.round((intoLevel / span) * 10) : 10
  const bar = "█".repeat(filled) + "░".repeat(10 - filled)
  const stats = STAT_NAMES.map((s) => `${s} ${String(c.stats[s]).padStart(3)}`).join("  ")
  return [
    sprite,
    "",
    `${c.name} — ${c.species} ${stars} (${c.rarity})${shiny}${hat}`,
    c.personality,
    `Lv.${level}  [${bar}]  ${toNext} XP to next`,
    stats,
  ].join("\n")
}
