// Make sure the model in the socket is loaded at the widest window it and this machine can manage.
//
// This is the only place that ever issues a load. The planner (windowplan.ts) decides the number and the
// cost model (kvcost.ts) supplies the one figure it cannot read; this module does the talking to the
// serving API, keeps the learned readings on disk, and runs the load command.
//
// DELIBERATELY ONE TRIGGER. The adapter can SEE the same discrepancy on every request and must never act
// on it: the ceiling moves as memory frees and fills, so a per-request comparison would reload, and
// reload, and reload — and every reload throws away the whole prefix cache, which costs every live
// conversation a full re-prefill measured in minutes. Worse, the owner may have loaded a model at a
// chosen window ON PURPOSE, and a background actor silently overruling that is the class of defect this
// project closed once already in the supervision stores. So: the app's model switch acts; everything else
// observes.
//
// NEVER PROBES. On unified memory a load that does not fit does not fail cleanly — it drives the whole
// machine into swap, and what becomes unusable is the desktop. The window is computed before loading; if
// nothing is known about the model's cache cost yet, we load at the SERVING DEFAULT (small), measure, and
// raise once. Small-then-up, never big-then-sorry.

import { spawn, execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir, totalmem } from "node:os"
import { planWindow, DEFAULT_POLICY, type Resident, type WindowPlan } from "./windowplan"
import { fitCost, fitCostFromSamples, addObservation, safeSecondWindow, MIN_SIGNAL_TOKENS, type Observation, type KvSample } from "./kvcost"

/** GUI-launched apps do not inherit the shell PATH, so a bare `lms` is not found — the same trap the
 *  other shell-outs in this project already carry a prefix for. */
const PATH_PREFIX = [
  join(homedir(), ".bun/bin"),
  join(homedir(), ".lmstudio/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  join(homedir(), ".local/bin"),
].join(":")

/** Read at CALL time, never at import. A value captured when the module loads is a snapshot, and this
 *  project has now been bitten by that shape three times in one day — a window cached for the life of a
 *  process, a constant in a config file, an endpoint frozen at import. The test suite caught this one by
 *  talking to the real serving API instead of its own stand-in. */
function modelApi(): string {
  return process.env.FABULA_MODEL_API || "http://localhost:1234/api/v0/models"
}

/**
 * The `lms` binary. Read at CALL time — a path captured at import is a snapshot, the shape that has
 * already bitten this file once (see modelApi above).
 *
 * `FABULA_LMS_BIN` exists so a test can point at a marker script and READ THE COMMAND. Without it the
 * load command is unobservable, and an argument silently dropped from it would pass every test — the
 * "pure core green, wiring dead" trap this project keeps finding. It is not a production knob.
 */
function lmsBin(): string {
  return process.env.FABULA_LMS_BIN || "lms"
}

function storePath(): string {
  const base = process.env.FABULA_KVCOST_FILE
  if (base) return base
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share")
  return join(data, "fabula", "kvcost.json")
}

type Store = Record<string, Observation[]>

function readStore(): Store {
  try {
    return JSON.parse(readFileSync(storePath(), "utf8")) as Store
  } catch {
    return {}
  }
}

function writeStore(s: Store): void {
  try {
    const p = storePath()
    mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2))
    renameSync(tmp, p) // atomic: a crash mid-write must not leave a half file the next read trusts
  } catch {
    /* the readings are an optimisation; losing them costs a measurement, never correctness */
  }
}


/**
 * Bytes in use on this machine right now. Read from the kernel, because nothing else reports it: the
 * serving API returns no memory field, and `lms ps` reports a SIZE that stays at 21.95 GB whether the
 * window is 32768 or 262144 — that is the weights, and a cost model built on it fits a flat line.
 */
export function usedBytes(): number {
  try {
    const out = execFileSync("vm_stat", { encoding: "utf8", timeout: 3000 })
    const page = Number(out.match(/page size of (\d+)/)?.[1]) || 16384
    const grab = (label: string) => Number(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1]) || 0
    return (grab("Pages active") + grab("Pages wired down") + grab("Pages occupied by compressor")) * page
  } catch {
    return 0
  }
}

/**
 * The model's weights, from the serving runtime. This IS reported and IS stable, which is exactly why it
 * is taken from here and the per-token cost is taken from the machine — each figure from the source that
 * actually varies with it.
 */
export function weightsBytesOf(modelId: string): number {
  try {
    const out = execFileSync(lmsBin(), ["ps"], {
      encoding: "utf8",
      timeout: 8000,
      env: { ...process.env, PATH: `${PATH_PREFIX}:${process.env.PATH ?? ""}` },
    })
    for (const line of out.split("\n")) {
      if (!line.includes(modelId)) continue
      const m = line.match(/([\d.]+)\s*(GB|GiB|MB|MiB)/i)
      if (!m) continue
      const n = Number(m[1])
      return /g/i.test(m[2]) ? n * 1024 ** 3 : n * 1024 ** 2
    }
  } catch {
    /* fall through */
  }
  return 0
}

export interface ServedModel {
  id: string
  type?: string
  state?: string
  loadedWindow: number
  passport: number
  bytes: number
}

/** Read what the serving API says right now. Never assumes; returns [] when it cannot be reached. */
export async function readServed(timeoutMs = 2500): Promise<ServedModel[]> {
  try {
    const res = await fetch(modelApi(), { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return []
    const body: any = await res.json()
    return (body?.data ?? []).map((m: any) => ({
      id: String(m?.id ?? ""),
      type: m?.type,
      state: m?.state,
      loadedWindow: Number(m?.loaded_context_length) || 0,
      passport: Number(m?.max_context_length) || 0,
      bytes: Number(m?.size_bytes ?? m?.bytes ?? 0) || 0,
    }))
  } catch {
    return []
  }
}

/** Everything else currently holding memory. The model is not alone: an embedding model or a second
 *  model for cross-checking can be resident, and a ceiling that ignores them is wrong exactly when it
 *  matters — at the moment the second one loads. */
export function residentsOther(served: readonly ServedModel[], selfId: string): Resident[] {
  return served
    .filter((m) => m.state === "loaded" && m.id !== selfId && m.bytes > 0)
    .map((m) => ({ id: m.id, bytes: m.bytes }))
}

/** Where request-time cache readings live. Separate from the load-time store: they are different
 *  measurements of different quantities and mixing them would average a real signal with a dead one. */
function samplePath(): string {
  const base = process.env.FABULA_KVSAMPLE_FILE
  if (base) return base
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share")
  return join(data, "fabula", "kvsamples.json")
}

type SampleStore = Record<string, KvSample[]>

export function readSamples(): SampleStore {
  try {
    return JSON.parse(readFileSync(samplePath(), "utf8")) as SampleStore
  } catch {
    return {}
  }
}

function writeSamples(s: SampleStore): void {
  try {
    const p = samplePath()
    mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 2))
    renameSync(tmp, p)
  } catch {
    /* a lost reading costs a measurement, never correctness */
  }
}

/** Fold in one request-time reading, newest last, bounded. */
export function recordKvSample(modelId: string, sample: KvSample, cap = 8): void {
  if (!(sample?.contextTokens > 0 && sample?.kvBytes > 0)) return
  const store = readSamples()
  store[modelId] = [...(store[modelId] ?? []), sample].slice(-cap)
  writeSamples(store)
}

/**
 * Measure what a token of context actually costs, by asking for one and watching.
 *
 * This is where the cost is READABLE and the load-time path is not. Three independent sources agree
 * that nothing at load time carries the signal on a lazy-cache runtime, all measured 2026-07-26:
 * `lms ps` SIZE is identical at 32768 and 262144; machine memory after a load has no window term in it
 * (three real readings fitted a NEGATIVE slope); and `lms load --estimate-only` returns the same
 * 28.62 GiB whether asked for 32768, 131072 or 262144. The cache appears when tokens do.
 *
 * NOT the forbidden probe. That one loads a model bigger than the machine and finds out by drowning it.
 * This asks for a SMALL, bounded context — a fraction of what the model is already provisioned to hold —
 * and the runtime allocates exactly proportionally. It cannot overshoot, because the size is chosen, not
 * discovered.
 */
export async function calibrateCost(
  modelId: string,
  opts: { tokens?: number; endpoint?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; sample?: KvSample; reason: string }> {
  // Below the floor the reading measures drift rather than cache — measured, see MIN_SIGNAL_TOKENS.
  // A caller asking for less gets the floor: a cheap wrong number is worse than a slower right one.
  // A calibration is a REAL request to a REAL model. Under a test runner that is a live call from a
  // suite that is supposed to be hermetic — the same rule `lib/moa.ts` applies to cloud endpoints, and
  // wiring this into the cold-start path is exactly what surfaced it: two modelload tests began
  // reaching localhost and timing out. Callers that mean to exercise it name their own endpoint.
  const env = process.env
  const underTest = env.NODE_ENV === "test" || !!env.BUN_TEST || !!env.FABULA_TEST
  if (underTest && !opts.endpoint) {
    return { ok: false, reason: "calibration skipped under a test runner (no endpoint named)" }
  }
  const tokens = Math.max(MIN_SIGNAL_TOKENS, Math.floor(opts.tokens ?? MIN_SIGNAL_TOKENS))
  const url = (opts.endpoint || process.env.FABULA_GRAPH_URL || "http://localhost:1235/v1").replace(/\/+$/, "")
  // Measured on this machine: 5.306 characters per token for ordinary prose. The exact ratio does not
  // matter — the sample records the prompt_tokens the runtime ITSELF reports, not this estimate.
  const filler = "the quarterly inventory audit completed without material discrepancy. ".repeat(
    Math.ceil((tokens * 5.306) / 70),
  )
  // WARM FIRST, and this was learned by getting it wrong twice. A model sitting idle has its weights
  // COMPRESSED; the first request forces them back to wired, and because compressed pages hold less than
  // the pages they expand into, that transition reads as memory growth. Measured: a calibration whose
  // baseline was taken while the model was idle reported 485 248 bytes per token — four and a half times
  // the truth — because 22 GiB of weights coming back from compression landed in the number as if it
  // were cache. The careful reading that gave the right answer took its baseline AFTER the model was
  // already resident. So: one throwaway request to bring the weights in, then the baseline, then the
  // measurement. The warm-up is deliberately tiny — it exists to move weights, not to allocate cache.
  try {
    await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1, temperature: 0, stream: false }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
    })
  } catch {
    /* the warm-up is an optimisation of the baseline; a failure here just leaves it cold and the
       dispersion guard will refuse the reading rather than trust it */
  }
  // Let the transition settle before reading: memory moves for a moment after a request finishes.
  await new Promise((r) => setTimeout(r, 3000))

  const before = usedBytes()
  let peak = before
  const ticker = setInterval(() => {
    const now = usedBytes()
    if (now > peak) peak = now
  }, 1500)
  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: `${filler}\n\nReply with one word: ok` }],
        max_tokens: 8,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
    })
    if (!res.ok) return { ok: false, reason: `calibration request returned HTTP ${res.status}` }
    const body: any = await res.json()
    // The runtime's own count, never our estimate — the whole point is to measure, not to assume.
    const measured = Number(body?.usage?.prompt_tokens) || 0
    const now = usedBytes()
    if (now > peak) peak = now
    const grew = peak - before
    if (!(measured > 0 && grew > 0)) {
      return { ok: false, reason: `nothing measurable: ${measured} tokens, ${grew} bytes of growth` }
    }
    const sample: KvSample = { contextTokens: measured, kvBytes: grew }
    recordKvSample(modelId, sample)
    return { ok: true, sample, reason: `${measured} tokens allocated ${(grew / 1024 ** 3).toFixed(2)} GiB of cache` }
  } catch (e: any) {
    return { ok: false, reason: `calibration failed: ${String(e?.message ?? e).slice(0, 160)}` }
  } finally {
    clearInterval(ticker)
  }
}

export interface EnsureResult {
  acted: boolean
  window: number
  plan?: WindowPlan
  reason: string
}

const inFlight = new Map<string, Promise<EnsureResult>>()

/** How far above the computed ceiling a loaded window may sit before it is worth a reload to correct.
 *  POLICY: the ceiling moves as memory frees and fills, and a reload costs every live conversation its
 *  prefix cache, so only a real over-shoot is acted on — not ordinary breathing. */
export const OVERSHOOT_MARGIN = 0.15

/**
 * How many concurrent request slots to provision the runtime with.
 *
 * MEASURED 2026-07-26: `parallel N` does not divide the window — one request of 131 021 tokens went
 * through a model loaded at 262144 with `parallel 4`, twice what a divided window would have allowed.
 * Each slot can therefore fill the window on its own, and provisioning N of them costs N times the
 * cache. On this machine the runtime had inherited `parallel 4` from whatever was set last — a number
 * nothing in the harness chose — while the planner sized the window for one slot. 262144 × 4 needs
 * 64 GiB of cache on a 48 GiB Mac, and the Mac sat in swap.
 *
 * The count is not a new policy knob, because a second knob would drift from the first. Slots beyond
 * what the admission gate will ever let through are pure loss: they buy no concurrency and they take
 * window away from the one request that IS running. So the provisioning simply follows the gate —
 * `FABULA_MAX_CONCURRENT_UPSTREAM`, the same number that decides how many calls reach the model at
 * once. Raise the gate and the provisioning follows on the next load; nothing has to be kept in sync
 * by hand.
 */
export function plannedSlots(env: Record<string, string | undefined> = process.env): number {
  const n = Math.floor(Number(env.FABULA_MAX_CONCURRENT_UPSTREAM))
  // 0 means "unlimited" at the gate. Unlimited is not a provisioning a machine can be sized for, so the
  // honest reading is one slot — the gate will still admit more, and the runtime grows its cache lazily.
  return n > 0 ? n : 1
}

/** Memory in use with the model unloaded, captured by the most recent load. See lmsLoad. */
let lastBaseline = 0

/** The model's own footprint: everything the machine holds now, less what it held without the model. */
function footprintBytes(): number {
  const now = usedBytes()
  return lastBaseline > 0 && now > lastBaseline ? now - lastBaseline : 0
}

/** Run `lms load`. Resolves with the command's own words so a failure is reportable, not guessed at. */

/**
 * Is any instance of this model still loaded? Asked of the runtime, not remembered — and matched on the
 * MODEL name rather than the identifier, because a second copy is called `<id>:2` and an identifier check
 * would miss precisely the thing this guards against.
 */
export function stillResident(modelId: string): boolean {
  try {
    const out = execFileSync(lmsBin(), ["ps"], {
      encoding: "utf8",
      timeout: 8000,
      env: { ...process.env, PATH: `${PATH_PREFIX}:${process.env.PATH ?? ""}` },
    })
    return out.split("\n").some((l) => l.includes(modelId) && !/IDENTIFIER/.test(l))
  } catch {
    return false // cannot ask → do not block; the runtime's own guardrail is the backstop
  }
}

/** Is the runtime generating right now? `lms ps` says PROCESSINGPROMPT / GENERATING while it works. */
export async function anyModelBusy(): Promise<boolean> {
  try {
    const out = execFileSync(lmsBin(), ["ps"], {
      encoding: "utf8",
      timeout: 8000,
      env: { ...process.env, PATH: `${PATH_PREFIX}:${process.env.PATH ?? ""}` },
    })
    return /PROCESSING|GENERATING/i.test(out)
  } catch {
    return true // cannot tell → assume busy: waiting costs a delay, guessing cost a crashed run
  }
}

function lmsLoad(modelId: string, window: number, timeoutMs: number, slots = plannedSlots()): Promise<{ ok: boolean; out: string }> {
  // Unload first. Loading a model that is ALREADY resident asks the machine to hold two copies for the
  // moment of the swap, and the runtime's guardrail — rightly — refuses: measured live, a load at 65536
  // was rejected for "insufficient system resources" while the same model sat at 32768, and the very
  // same command succeeded once the old copy was gone. The guardrail was reading the true cost of what
  // it was asked to do; the request was the thing that was wrong.
  try {
    execFileSync(lmsBin(), ["unload", modelId], {
      timeout: 30_000,
      env: { ...process.env, PATH: `${PATH_PREFIX}:${process.env.PATH ?? ""}` },
      stdio: "ignore",
    })
  } catch {
    /* not loaded, or nothing to unload — the load below is what matters */
  }
  // VERIFY the unload, never assume it. Swallowing its failure is what wrecked a live run: the model was
  // BUSY serving an eight-minute turn, `lms unload` could not take it, the error was caught and ignored,
  // and the load below brought up a SECOND copy — `kat-coder…:2`, two lots of 21.95 GB of weights on a
  // 48 GB machine. It went into swap, the original instance was killed, and the user's work died with it
  // as "the model has crashed (Exit code: null)". The planner even reported the second copy honestly,
  // capping it at 135168 because it counted the first as a resident — every part behaved as written, on
  // a premise that should never have existed.
  if (stillResident(modelId)) {
    return {
      ok: false,
      out: `refusing to load: ${modelId} is still resident and could not be unloaded (busy?). Loading now `
        + `would start a SECOND copy and take the machine into swap.`,
    }
  }
  // The baseline, taken with the model GONE. Machine-wide memory drifts — a build, a browser tab, the app
  // itself — and measured live that drift went straight into the slope: the cost came out roughly twice
  // its true value and the plan capped a 262144-capable model at 135168. Paired around the unload, the
  // drift cancels: what is left is the model's own footprint and nothing else.
  lastBaseline = usedBytes()
  return new Promise((resolve) => {
    const args = ["load", modelId, "--context-length", String(window), "--parallel", String(slots), "-y"]
    const child = spawn(lmsBin(), args, {
      env: { ...process.env, PATH: `${PATH_PREFIX}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    child.stdout?.on("data", (d) => (out += String(d)))
    child.stderr?.on("data", (d) => (out += String(d)))
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ ok: false, out: `${out}\n[timed out after ${timeoutMs}ms]` })
    }, timeoutMs)
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ ok: false, out: `${out}\n${String(e)}` })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, out })
    })
  })
}

/**
 * Ensure `modelId` is loaded at its planned window.
 *
 * Single-flight per model: a second caller joins the first rather than racing it into a double load.
 * Returns without acting whenever it cannot be sure — a model already at or above its plan, an
 * unreachable serving API, no learned cost yet on a model that is already loaded, or the kill switch.
 */
export async function ensureLoadedAtPlannedWindow(
  modelId: string,
  opts: { loadTimeoutMs?: number; quiet?: () => Promise<boolean> } = {},
): Promise<EnsureResult> {
  if (process.env.FABULA_AUTO_WINDOW === "0") {
    return { acted: false, window: 0, reason: "disabled by FABULA_AUTO_WINDOW=0" }
  }
  const running = inFlight.get(modelId)
  if (running) return running

  const job = (async (): Promise<EnsureResult> => {
    const served = await readServed()
    if (!served.length) return { acted: false, window: 0, reason: "serving API not reachable" }
    const me = served.find((m) => m.id === modelId)
    if (!me) return { acted: false, window: 0, reason: `${modelId} is not known to the serving API` }
    if (!(me.passport > 0)) {
      return { acted: false, window: 0, reason: `${modelId} reports no maximum window; nothing to plan from` }
    }

    // Fold in what this load is teaching us before planning the next one.
    const store = readStore()
    if (me.state === "loaded" && me.loadedWindow > 0 && footprintBytes() > 0) {
      store[modelId] = addObservation(store[modelId] ?? [], {
        windowTokens: me.loadedWindow,
        totalBytes: footprintBytes() || 0, // the model's own footprint, drift removed — see lmsLoad
      })
      writeStore(store)
    }

    // Prefer the request-time readings: they measure the quantity being governed. The load-time fit is
    // kept as the fallback for a runtime that really does pre-allocate its cache — refusing to model
    // that would tie this file to one serving stack.
    const sampled = fitCostFromSamples(readSamples()[modelId] ?? [])
    const cost = sampled.bytesPerToken > 0 ? sampled : fitCost(store[modelId] ?? [])
    if (!(cost.bytesPerToken > 0)) {
      // Cold start. If it is already loaded, this reading plus the next one at a different window will
      // give us the line — so wait rather than load blind. If it is NOT loaded, letting the serving
      // default bring it up is the safe small step that produces that second reading.
      // One reading is a deadlock unless we go and take the second one: the fit needs two windows, and a
      // second window only exists if something loads at one. Doubling is provably safe from the single
      // reading alone — see safeSecondWindow — so this is a measured step, not a probe.
      // The basis for a measuring step is simply where the model sits now. It does NOT need a stored
      // reading first: the very first footprint can only be taken by a load, because a load is what
      // establishes the baseline (it unloads before it loads). Requiring a prior reading here was the
      // deadlock one layer down — no baseline, no footprint, no reading, no step, forever.
      const basis = { windowTokens: me.loadedWindow || 0, totalBytes: 1 }
      const free = Math.max(0, totalmem() - usedBytes() - DEFAULT_POLICY.systemReserveBytes)
      const second = basis.windowTokens > 0 ? safeSecondWindow(basis, free, me.passport) : 0
      if (!second) {
        return {
          acted: false,
          window: me.loadedWindow,
          reason: `cache cost for ${modelId} not learned yet (${cost.reason}); no safe second window to measure at`,
        }
      }
      if (opts.quiet && !(await opts.quiet())) {
        return { acted: false, window: me.loadedWindow, reason: `would measure at ${second}, but the machine is busy` }
      }
      // Ask the cache what it costs BEFORE spending a reload to find out. On a lazy-allocation runtime
      // the load-time reading carries no window term at all (three sources agree — see calibrateCost),
      // so a request-time sample is both cheaper and the only one that measures the right quantity: it
      // costs one prefill instead of an unload-plus-load, and it leaves the serving cache warm.
      if (me.state === "loaded") {
        const cal = await calibrateCost(modelId)
        if (cal.ok) {
          return {
            acted: false,
            window: me.loadedWindow,
            reason: `measured the cache cost from a real request (${cal.reason}); the next switch can plan the full window`,
          }
        }
      }
      const probe = await lmsLoad(modelId, second, opts.loadTimeoutMs ?? 180_000)
      const measured = probe.ok ? (await readServed()).find((m) => m.id === modelId) : undefined
      if (measured && measured.loadedWindow > 0) {
        const s3 = readStore()
        s3[modelId] = addObservation(s3[modelId] ?? [], { windowTokens: measured.loadedWindow, totalBytes: footprintBytes() })
        writeStore(s3)
      }
      return {
        acted: probe.ok,
        window: measured?.loadedWindow ?? me.loadedWindow,
        reason: probe.ok
          ? `took a second reading at ${measured?.loadedWindow ?? second} (safe from the first alone); the next switch can plan the full window`
          : `could not take a second reading: ${probe.out.trim().slice(0, 200)}`,
      }
    }

    // Weights are the largest term in the budget, so an unknown one cannot be treated as zero — that
    // hands the plan the model's entire footprint as if it were free memory. The request-time fit goes
    // through the origin and reports no weights BY DESIGN (there is no constant to recover), so this
    // fallback chain can genuinely arrive at zero, and the honest answer then is to refuse.
    // Weights, from whichever source actually has them. `lms ps` reports a SIZE that does not move with
    // the window — that is the weights, and it is the best source. The through-origin request-time fit
    // reports none by construction (there is no constant to recover when the baseline is subtracted), so
    // it cannot stand in. The serving API's own figure is the last resort: on this runtime it is absent,
    // but a runtime that does report it should not be refused for the sake of the one that does not.
    //
    // Zero still refuses rather than plans. A missing weight silently read as zero would hand the planner
    // the model's entire footprint as free memory — the one arithmetic mistake here that ends in swap.
    const weights = weightsBytesOf(modelId) || cost.weightsBytes || me.bytes
    if (!(weights > 0)) {
      return {
        acted: false,
        window: me.loadedWindow,
        reason: `cannot size a window for ${modelId} without knowing its weights; the serving runtime reported none`,
      }
    }

    const plan = planWindow({
      passportTokens: me.passport,
      totalBytes: totalmem(),
      weightsBytes: weights,
      bytesPerToken: cost.bytesPerToken,
      residents: residentsOther(served, modelId),
      // Provision exactly the concurrency the gate will admit — see plannedSlots. A slot the gate never
      // uses buys nothing and takes window away from the request that IS running.
      slots: plannedSlots(),
    })

    if (!plan.fits) return { acted: false, window: me.loadedWindow, plan, reason: plan.reason }
    // A window ABOVE the ceiling is not a preference to respect, it is a provisioning the machine cannot
    // pay for — and the damage is silent. MEASURED 2026-07-26: this model sat at 262144 against a
    // computed ceiling of 135168, and the Mac lived at 0.6 GiB free with 18 GiB compressed and 8.8 GiB
    // of swap while the model was IDLE. Raising only was written when the risk was believed to be a
    // window loaded too SMALL; the opposite risk turned out to be the live one.
    //
    // The margin exists so a ceiling that breathes with free memory cannot cause a reload every time a
    // browser tab opens — and every reload throws away the whole prefix cache. Only a window that
    // over-shoots by more than the margin is worth the reload it costs.
    const over = me.loadedWindow > plan.tokens * (1 + OVERSHOOT_MARGIN)
    if (me.state === "loaded" && me.loadedWindow >= plan.tokens && !over) {
      return { acted: false, window: me.loadedWindow, plan, reason: `already at ${me.loadedWindow}; ${plan.reason}` }
    }

    // A reload discards every cached prefix, so a live turn pays for it. Wait for quiet when the caller
    // supplies a way to ask; if quiet never comes, say so plainly rather than interrupting real work.
    if (opts.quiet && !(await opts.quiet())) {
      return {
        acted: false,
        window: me.loadedWindow,
        plan,
        reason: `would raise ${me.loadedWindow} -> ${plan.tokens}, but the machine never went quiet; leaving it alone`,
      }
    }

    const r = await lmsLoad(modelId, plan.tokens, opts.loadTimeoutMs ?? 180_000)
    if (!r.ok) {
      return { acted: false, window: me.loadedWindow, plan, reason: `load failed: ${r.out.trim().slice(0, 300)}` }
    }

    // Record what the new window actually cost, so the next plan rests on one more point.
    const after = (await readServed()).find((m) => m.id === modelId)
    if (after && after.loadedWindow > 0) {
      const s2 = readStore()
      s2[modelId] = addObservation(s2[modelId] ?? [], {
        windowTokens: after.loadedWindow,
        totalBytes: footprintBytes(),
      })
      writeStore(s2)
    }

    return {
      acted: true,
      window: after?.loadedWindow ?? plan.tokens,
      plan,
      reason: `${me.loadedWindow && plan.tokens < me.loadedWindow ? "lowered" : "raised"} ${me.loadedWindow || "unloaded"} -> ${after?.loadedWindow ?? plan.tokens}: ${plan.reason}`,
    }
  })()

  inFlight.set(modelId, job)
  try {
    return await job
  } finally {
    inFlight.delete(modelId)
  }
}

/**
 * Bring the engine's own idea of the window into line with what is actually loaded.
 *
 * The engine keeps a `limit.context` per model in its config and prunes and compacts against it. That
 * figure is typed by hand, so it is the same defect one layer up — and measured on this machine it was
 * WRONG BY HALF: the config said 131072 while the model was serving 262144, so the engine was throwing
 * conversation away at the halfway mark of a window it actually had. Nothing warns about this: both
 * numbers look reasonable on their own.
 *
 * Written by the machine from a live reading, never authored — and only ever to match the measured
 * window, so it cannot invent a limit the model does not have. The engine reads its config at startup,
 * so the corrected figure applies from the next start; a stale entry costs pruning headroom, never
 * correctness, which is why this does not force a restart.
 */
export function syncEngineLimit(configPath: string, modelId: string, window: number): { changed: boolean; from?: number; reason: string } {
  if (!(window > 0)) return { changed: false, reason: "no measured window to sync from" }
  try {
    const raw = readFileSync(configPath, "utf8")
    const cfg = JSON.parse(raw)
    const providers = cfg?.provider ?? {}
    let from: number | undefined
    let changed = false
    for (const p of Object.values<any>(providers)) {
      const m = p?.models?.[modelId]
      if (!m?.limit) continue
      if (Number(m.limit.context) === window) continue
      from = Number(m.limit.context) || undefined
      m.limit.context = window
      changed = true
    }
    if (!changed) return { changed: false, reason: `engine limit for ${modelId} already ${window}` }
    const tmp = `${configPath}.tmp`
    writeFileSync(tmp, JSON.stringify(cfg, null, 2))
    renameSync(tmp, configPath)
    return { changed: true, from, reason: `engine limit for ${modelId}: ${from ?? "unset"} -> ${window} (measured)` }
  } catch (e) {
    return { changed: false, reason: `could not sync engine limit: ${String(e)}` }
  }
}
