// FABULA buddy (§ disrupt #6, the last) — a Proof-of-Done COMPANION. A small ASCII pet sits with the
// project; its LOOK is deterministic from your user id (species/rarity/eye/hat/stats — regenerated on every
// read, so a rename can't break it and you can't hand-edit your way to a rarer pet), and its NAME + soul are
// authored once at hatch. The FABULA twist, and the whole point: it grows ONLY from VERIFIED work.
//
//   buddy        — show your companion (sprite + level + stats). Hatch first if you haven't.
//   buddy_hatch  — name your companion once (you write its name + one-line personality).
//   buddy_feed   — feed it a Proof-of-Done receipt: a PASSED receipt grants XP, its gates bump matching
//                  stats, witnesses multiply the reward. A NOT DONE receipt grants nothing — proven work only.
//
// A silent tool.execute.after hook auto-feeds the latest receipt whenever a verify_done goes green, so the
// buddy literally grows from proven work without anyone remembering to feed it; only rare milestones
// (a level-up, the legendary upgrade) surface a one-line note. Three published receipts each attested by
// ≥3 independent witnesses ([[fabula-witness]]) upgrade the pet to legendary — a badge you cannot fake.
// Logic (roll, XP curve, state transition, sprites) is the pure lib/buddy.ts; this file is the fs + render.

import { tool } from "@mimo-ai/plugin"
import type { Plugin } from "@mimo-ai/plugin"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { gate, isEnabled } from "./lib/manage"
import { parseReceipt, receiptId } from "./lib/registry"
import {
  emptyState, applyFeed, getCompanion, levelFromXp, renderCard,
  type BuddyState, type FeedInput,
} from "./lib/buddy"

const z = tool.schema
const STATE = ".fabula/buddy/state.json"
const RECEIPT = path.join(".fabula", "receipts", "latest.json")
const WITNESSES = path.join(".fabula", "receipts", "witnesses.json")

function userId(): string {
  const env = process.env.FABULA_BUDDY_USER
  if (env && env.trim()) return env.trim()
  try {
    const u = os.userInfo().username
    if (u) return u
  } catch {}
  return "anon"
}

function loadState(dir: string): BuddyState {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, STATE), "utf8"))
    if (j && typeof j === "object") {
      // Merge over the defaults, then type-correct the array fields: a present-but-wrong-type value
      // in a corrupt state file would otherwise override the default and crash applyFeed
      // (fedReceipts.includes / legendaryReceipts.length/.includes).
      const s = { ...emptyState(), ...j } as BuddyState
      if (!Array.isArray(s.fedReceipts)) s.fedReceipts = []
      if (!Array.isArray(s.legendaryReceipts)) s.legendaryReceipts = []
      return s
    }
  } catch {}
  return emptyState()
}
function saveState(dir: string, s: BuddyState): boolean {
  try {
    fs.mkdirSync(path.join(dir, ".fabula", "buddy"), { recursive: true })
    fs.writeFileSync(path.join(dir, STATE), JSON.stringify(s, null, 2), "utf8")
    return true
  } catch {
    return false
  }
}

// Count CONFIRMED, independent witnesses recorded next to a receipt (disputed ones don't count).
function witnessCount(dir: string): number {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, WITNESSES), "utf8"))
    if (rec && Array.isArray(rec.witnesses)) return rec.witnesses.filter((w: any) => w?.verdict === "confirmed").length
  } catch {}
  return 0
}

// Read a receipt (explicit path or the project's latest) → normalize to a FeedInput for the pure feed logic.
function readFeed(dir: string, from?: string): FeedInput | { error: string } {
  const p = from && from.trim() ? path.resolve(dir, from.trim()) : path.join(dir, RECEIPT)
  const file = p.endsWith(".json") ? p : path.join(p, RECEIPT)
  if (!fs.existsSync(file)) return { error: `no receipt at ${file} — a verified run mints one; feed that.` }
  let json: string
  try {
    json = fs.readFileSync(file, "utf8")
  } catch (e) {
    return { error: `could not read ${file}: ${e instanceof Error ? e.message : String(e)}` }
  }
  const parsed = parseReceipt(json)
  if (!parsed.ok) return { error: `receipt at ${file} is invalid: ${parsed.error}` }
  const r = parsed.receipt
  let patch: string | undefined
  const rel = r.artifact?.patch
  if (rel) {
    const pa = path.resolve(path.dirname(file), "..", "..", rel)
    if (fs.existsSync(pa)) patch = fs.readFileSync(pa, "utf8")
  }
  const rid = patch && r.verification?.cmd ? receiptId(patch, r.verification.cmd) : createHash("sha256").update(json).digest("hex")
  return {
    receiptId: rid,
    passed: r.verification?.passed === true,
    gates: (Array.isArray(r.gates) ? r.gates : []).map((g) => g?.id).filter((x): x is string => typeof x === "string"),
    task: (r.task || "").replace(/^"+|"+$/g, ""),
    witnessCount: path.dirname(file).endsWith("receipts") ? witnessCount(path.resolve(path.dirname(file), "..", "..")) : 0,
  }
}

function card(dir: string): string {
  const st = loadState(dir)
  const c = getCompanion(userId(), st)
  if (!c) return "You have no companion yet. Call buddy_hatch to name one — it grows only from VERIFIED work."
  const l = levelFromXp(st.xp)
  const legend = st.legendaryEarned ? "" : `\n(${st.legendaryReceipts.length}/3 receipts with ≥3 witnesses toward a legendary upgrade)`
  return renderCard(c, l.level, l.intoLevel, l.span, l.toNext) + legend
}

export const FabulaBuddy: Plugin = async (input: any) => {
  const dir: string = input?.directory || process.cwd()
  return gate("buddy", {
    tool: {
      buddy: tool({
        description: "Show your Proof-of-Done companion — a small ASCII pet whose look is fixed by your user id but whose level and stats are EARNED from verified work. Hatch one first if you haven't.",
        args: {},
        async execute() {
          return card(dir)
        },
      }),

      buddy_hatch: tool({
        description: "Name your companion (once). Its species/rarity/look are already fixed by your user id — you choose only its name and a one-line personality. After this it grows from every PASSED Proof-of-Done receipt.",
        args: {
          name: z.string().describe("A name for the companion."),
          personality: z.string().describe("One line of personality/voice for the companion."),
        },
        async execute(args: any) {
          const st = loadState(dir)
          const name = String(args?.name || "").trim()
          const personality = String(args?.personality || "").trim()
          if (!name) return "buddy_hatch: give it a name."
          if (st.soul && st.hatchedAt) return `You already hatched ${st.soul.name}. A companion is hatched once.\n\n${card(dir)}`
          st.soul = { name, personality: personality || "quietly watches the diffs go green" }
          st.hatchedAt = st.hatchedAt || Date.now()
          if (!saveState(dir, st)) return "buddy_hatch: could not write .fabula/buddy/state.json (permissions?)"
          return `Hatched!\n\n${card(dir)}`
        },
      }),

      buddy_feed: tool({
        description: "Feed your companion a Proof-of-Done receipt (this project's latest, or a given path). A PASSED receipt grants XP (base + reproduce/quiz gates + 10×witnesses + SWE-bench bonus) and bumps stats from its gates; a NOT DONE receipt grants nothing — a buddy grows only from proven work. Feeding the same receipt twice does nothing.",
        args: { from: z.string().nullish().describe("Receipt.json path or a project dir (default: this project's latest receipt).") },
        async execute(args: any) {
          let st = loadState(dir)
          if (!st.soul || !st.hatchedAt) {
            // allow feeding to imply a hatch stamp so the first verified work brings the buddy to life
            if (!st.soul) return "You have no companion yet. Call buddy_hatch first."
            st.hatchedAt = Date.now()
          }
          const feed = readFeed(dir, args?.from ? String(args.from) : undefined)
          if ("error" in feed) return `buddy_feed: ${feed.error}`
          const { state, result } = applyFeed(st, feed)
          if (!saveState(dir, state)) return "buddy_feed: could not write state (permissions?)"
          if (result.alreadyFed) return `Already fed that receipt — no double-dipping.\n\n${card(dir)}`
          if (result.gained === 0) return `${result.reason || "No XP"}.\n\n${card(dir)}`
          const bits: string[] = [`+${result.gained} XP`]
          const bumped = Object.entries(result.bumps).map(([k, v]) => `${k}+${v}`)
          if (bumped.length) bits.push(bumped.join(" "))
          if (result.leveledUp) bits.push(`⤴ LEVEL ${result.level}!`)
          if (result.legendaryUpgrade) bits.push("🌟 LEGENDARY — three receipts, nine witnesses. Unfakeable.")
          return `${bits.join("  ·  ")}\n\n${card(dir)}`
        },
      }),
    },

    // The buddy grows from proven work on its own: a green verify_done auto-feeds the latest receipt. Silent
    // except for rare milestones (a level-up or the legendary upgrade), so it never adds noise to the loop.
    "tool.execute.after": async (hookInput: any, output: any) => {
      try {
        if (!output || hookInput?.tool !== "verify_done") return
        if (output?.metadata?.passed !== true) return
        if (!isEnabled("buddy")) return
        if (process.env.FABULA_BUDDY_AUTO === "0") return
        const st = loadState(dir)
        if (!st.soul) return // nothing to grow until hatched
        if (!st.hatchedAt) st.hatchedAt = Date.now()
        const feed = readFeed(dir)
        if ("error" in feed || !feed.passed) return
        const { state, result } = applyFeed(st, feed)
        if (result.gained === 0) return
        saveState(dir, state)
        if ((result.leveledUp || result.legendaryUpgrade) && typeof output.output === "string") {
          const note = result.legendaryUpgrade
            ? `\n\n🌟 ${state.soul!.name} reached LEGENDARY from your verified work.`
            : `\n\n⤴ ${state.soul!.name} reached level ${result.level} from your verified work.`
          output.output = output.output + note
          if (output.metadata && typeof output.metadata === "object") output.metadata.buddy = "grew"
        }
      } catch {
        // a companion never breaks the loop
      }
    },
  })
}
