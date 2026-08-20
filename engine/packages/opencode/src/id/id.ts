import z from "zod"
import { randomBytes } from "crypto"

const prefixes = {
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  user: "usr",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
  entry: "ent",
  workflow: "wf",
} as const

export function schema(prefix: keyof typeof prefixes) {
  return z.string().startsWith(prefixes[prefix])
}

const LENGTH = 26

// State for monotonic ID generation
let lastTimestamp = 0
let counter = 0

export function ascending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "ascending", given)
}

export function descending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "descending", given)
}

function generateID(prefix: keyof typeof prefixes, direction: "descending" | "ascending", given?: string): string {
  if (!given) {
    return create(prefixes[prefix], direction)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }
  return given
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let result = ""
  const bytes = randomBytes(length)
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % 62]
  }
  return result
}

export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }
  counter++

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

  now = direction === "descending" ? ~now : now

  const timeBytes = Buffer.alloc(6)
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }

  return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
}

/**
 * How often the packed time field wraps. `create` computes `timestamp * 0x1000 + counter` and packs it
 * into SIX bytes: a millisecond timestamp of this era needs 41 bits, the product needs 53, and the top
 * five are dropped. The surviving low bits are EXACT, so the true value is the decoded remainder plus a
 * whole number of these periods — 2^48 / 0x1000.
 */
const TIMESTAMP_PERIOD = 2 ** 36

/**
 * Extract the timestamp from an ascending ID. Does not work with descending IDs.
 *
 * MEASURED DEFECT this repairs (2026-08-18): the decoded value was returned raw, so it was the true
 * timestamp modulo ~2.18 years — out by 1,786,706,395,136 ms on a fresh id. Worse than the offset, the
 * offset is not CONSTANT: two ids minutes apart can sit either side of a wrap, and then the older one
 * decodes as the newer. `Truncate.cleanup` is the only consumer, and it compares decoded values against
 * a decoded cutoff to decide what to delete — so on the days when the wrap fell inside the retention
 * window it deleted spill files that were still live, which are exactly the files a truncated tool
 * result tells the reader to open. It is date-dependent, which is why it survived: the same code is
 * correct on most days and wrong on some.
 *
 * The FORMAT is deliberately untouched — ids are stored and sorted, so re-encoding them would reorder
 * existing data. Instead the dropped high bits are reconstructed from the one fact available: an id was
 * created in the past, so of all the values congruent to the remainder, the true one is the most recent
 * that is not in the future.
 *
 * LIMIT, stated rather than hidden: an id older than one full period (~2.18 years) is indistinguishable
 * from a recent one and reads as recent. That direction is deliberate — it makes an ancient file be
 * KEPT rather than a live one deleted.
 */
export function timestamp(id: string): number {
  const prefix = id.split("_")[0]
  const hex = id.slice(prefix.length + 1, prefix.length + 13)
  const encoded = BigInt("0x" + hex)
  const remainder = Number(encoded / BigInt(0x1000))
  const periods = Math.floor((Date.now() - remainder) / TIMESTAMP_PERIOD)
  if (!Number.isFinite(periods) || periods < 0) return remainder
  return remainder + periods * TIMESTAMP_PERIOD
}

export * as Identifier from "./id"
