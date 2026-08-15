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
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
// The memory question is asked in ONE place. Which pool it reads — unified, GPU, or plain system memory —
// is that module's decision, and on macOS its answer is byte-identical to the `os.totalmem()` / `vm_stat`
// pair these call sites used to inline. Imported under their real names: an alias that made
// `platform/memory.totalBytes` read as `totalmem` would leave the seam correct and unfindable, which in
// practice is the same as absent.
import { totalBytes, usedBytes as platformUsedBytes, memoryReading } from "./platform/memory"
import { bunBinDir, servingBinDir, systemBinDirs, localBinDir, joinPathList, dataPath } from "./platform/paths"
import { resolveSlots, readSamples as readConcurrencySamples, recordSample as recordConcurrencySample } from "./concurrency"
import { machineProfile } from "./platform/profile"
import { planWindow, DEFAULT_POLICY, policyFor, noPolicyReason, type Resident, type WindowPlan } from "./windowplan"
import { fitCost, fitCostFromSamples, addObservation, safeSecondWindow, marginalCost, MIN_SIGNAL_TOKENS, SAMPLE_DISPERSION_LIMIT, type Observation, type KvSample } from "./kvcost"
import { resolveModelDir } from "./modeldigest"

/** GUI-launched apps do not inherit the shell PATH, so a bare `lms` is not found — the same trap the
 *  other shell-outs in this project already carry a prefix for. The directories are NAMED by
 *  `platform/paths.ts` (which knows where each one is per platform); the ORDER stays here, because it is
 *  this module's decision that the serving CLI should be found before a homebrew copy of it. */
function pathPrefix(): string {
  return joinPathList([bunBinDir(), servingBinDir(), ...systemBinDirs(), localBinDir()])
}

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
  // Resolved the way the ENGINE resolves its data dir, which twenty-six hand-written copies of this line
  // did not: `MIMOCODE_HOME` moves the engine's whole tree and every one of them stayed behind.
  return dataPath("kvcost.json")
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
 *
 * WHICH kernel, and which pool, is decided in `platform/memory.ts`. It stays exported here because the
 * whole calibration path below is written in terms of it, and because this is where a reader of the cost
 * model looks for it. On macOS the answer is byte-identical to the `vm_stat` parse this used to inline.
 */
export function usedBytes(): number {
  return platformUsedBytes()
}

/**
 * A size unit as the printer MEANT it, not as it is convenient to read.
 *
 * MEASURED 2026-08-01, and the measurement is the whole point: `lms ps` prints `21.95 GB` for
 * kat-coder-v2.5-dev-optiq, and that model's weight files on disk sum to 21,950,414,309 bytes — which is
 * 21.95 × 10⁹, the DECIMAL reading, to four significant figures. The binary reading of the same string
 * (21.95 × 1024³ = 23,568,633,036) is 1.51 GiB of weights that do not exist. Applying it inflated the
 * "already spent" term in planWindow by 7.37% of the model's footprint, so every window this machine
 * planned was smaller than it could afford, and the error grew with the model.
 *
 * A suffix WITH an `i` (GiB/MiB/KiB) is binary by definition; one without is decimal. Both spellings are
 * honoured rather than one being guessed at, because which one a runtime prints is that runtime's choice
 * and nothing here can make it consistent.
 */
export function unitBytes(unit: string): number {
  const u = unit.toLowerCase()
  if (u === "gib") return 1024 ** 3
  if (u === "mib") return 1024 ** 2
  if (u === "kib") return 1024
  if (u === "gb") return 1e9
  if (u === "mb") return 1e6
  if (u === "kb") return 1e3
  return 1 // bare "B"
}

/**
 * The model's weights, from the serving runtime. This IS reported and IS stable, which is exactly why it
 * is taken from here and the per-token cost is taken from the machine — each figure from the source that
 * actually varies with it.
 */
/** One `lms ps`, parsed. Callers that need SEVERAL models' weights must use this rather than calling
 *  weightsBytesOf in a loop — each call is a process spawn with an 8s ceiling, and doing it per resident
 *  turned a hermetic test from milliseconds into 175 seconds under load. One reading answers every id. */
export function weightsFromLmsPs(): { line: string; bytes: number }[] {
  try {
    const out = execFileSync(lmsBin(), ["ps"], {
      encoding: "utf8",
      timeout: 8000,
      env: { ...process.env, PATH: `${pathPrefix()}:${process.env.PATH ?? ""}` },
    })
    const rows: { line: string; bytes: number }[] = []
    for (const line of out.split("\n")) {
      // The SIZE column is the only storage-scale quantity on an `lms ps` line — but not the only
      // number-with-unit TEXT: a parameter count in the model NAME reads as one too (MEASURED
      // 2026-08-15: "qwen3.8-27b-mlx" matched as 27 B, the || chain took that as known-positive
      // weights, the real 15.15 GB on disk was never asked for, and the plan over-committed the
      // machine by 14 GiB). Collect every match and keep the LARGEST in bytes: name debris is by
      // construction smaller than any real model file, and a genuine size is the biggest storage
      // number on its line.
      const matches = [...line.matchAll(/([\d.]+)\s*(GB|GiB|MB|MiB|KB|KiB|B)\b/gi)]
      const best = matches
        .map((m) => Number(m[1]) * unitBytes(m[2]!))
        .filter((b) => Number.isFinite(b) && b > 0)
        .sort((a, b) => b - a)[0]
      if (!(best > 0)) continue
      rows.push({ line, bytes: best })
    }
    return rows
  } catch {
    return []
  }
}

export function weightsBytesOf(modelId: string): number {
  if (!modelId) return 0
  for (const row of weightsFromLmsPs()) {
    if (row.line.includes(modelId)) return row.bytes
  }
  return 0
}

/**
 * Weights of a model that is NOT loaded: the sum of its files on disk.
 *
 * MEASURED GAP 2026-07-31: switching TO a model refused with "the serving runtime reported none" —
 * `lms ps` only lists LOADED models, and the serving API answers size_bytes: null for a not-loaded one.
 * So the one moment the plan is most needed (before a load) was the one moment the weight had no source.
 * For MLX the on-disk bytes ARE what the load will wire into memory (verified: 21,930,054,115 bytes on
 * disk = the 20.42 GiB the runtime reports once loaded), so the model's own directory is an honest
 * source, resolved with the same quant-suffix-tolerant matcher the weights digest already uses.
 */
export function weightsOnDisk(modelId: string): number {
  try {
    // Overridable so a test never reads the developer's real model store — the guard test for unknown
    // weights failed the moment this source landed, because "kat" prefix-matched the real kat-coder dir.
    const root = process.env.FABULA_MODELS_ROOT || join(homedir(), ".lmstudio", "models")
    const dir = resolveModelDir(modelId, root)
    if (!dir) return 0
    let sum = 0
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else sum += statSync(p).size
      }
    }
    walk(dir)
    return sum
  } catch {
    return 0
  }
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
 *  matters — at the moment the second one loads.
 *
 *  MEASURED 2026-08-01: this used to end in `.filter(m => m.bytes > 0)`, and `bytes` is
 *  `size_bytes ?? bytes ?? 0` off the serving API — which omits BOTH fields entirely on this runtime,
 *  even for the loaded model. So the filter dropped every resident there has ever been and the term
 *  could not fire once. A filter that always empties its own input is not a filter, it is an assumption
 *  that the machine is empty.
 *
 *  The size IS available, just not from that reader: `lms ps` prints a SIZE column for every loaded
 *  model, and failing that the model's own files are on disk. Both are already used for the model being
 *  loaded; a resident is the same question about a different id. A resident that STILL cannot be sized
 *  is reported with `bytes: 0` and planWindow refuses on it — never dropped, because dropping it is the
 *  reading that over-commits.
 *
 *  `resolveBytes` is injected so the decision stays testable without a running runtime. */
export function residentsOther(
  served: readonly ServedModel[],
  selfId: string,
  resolveBytes?: (id: string) => number,
): Resident[] {
  const others = served.filter((m) => m.state === "loaded" && m.id !== selfId && m.id !== "")
  if (!others.length) return []
  // ONE `lms ps` for the whole set, read lazily — a spawn per resident is an 8s ceiling per resident.
  const resolve =
    resolveBytes ??
    (() => {
      let rows: { line: string; bytes: number }[] | undefined
      return (id: string) => {
        if (others.every((m) => m.bytes > 0)) return 0 // nothing to look up; never spawn
        rows ??= weightsFromLmsPs()
        return rows.find((r) => r.line.includes(id))?.bytes ?? weightsOnDisk(id)
      }
    })()
  return others.map((m) => ({ id: m.id, bytes: m.bytes > 0 ? m.bytes : Math.max(0, resolve(m.id) || 0) }))
}

/** Where request-time cache readings live. Separate from the load-time store: they are different
 *  measurements of different quantities and mixing them would average a real signal with a dead one. */
function samplePath(): string {
  const base = process.env.FABULA_KVSAMPLE_FILE
  if (base) return base
  return dataPath("kvsamples.json")
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
/** One repeat of the calibration filler. Ordinary prose, so a tokenizer treats it the way it treats
 *  real text; its LENGTH is what matters, and the ratio to tokens is measured per model, never assumed. */
const FILLER_UNIT = "the quarterly inventory audit completed without material discrepancy. "

/** A calibration's filler must be UNIQUE to that calibration.
 *
 *  MEASURED 2026-08-01, and it is this project's most-repeated measurement error arriving for the third
 *  time. A calibration ran against the resident model and reported 29,132 B/token where the stored
 *  reading for the same model at the same provisioning said 123,758 — 4.25× apart, and in the direction
 *  the module itself names as the dangerous one. The cause is that every calibration built its filler by
 *  repeating one CONSTANT sentence, so the second calibration of a model sends a prefix the runtime has
 *  already cached. A prefix-cache HIT allocates nothing, `peak - before` collapses, and the marginal
 *  reports a fraction of the truth. The same shape is on record twice already: "a shared-prefix
 *  benchmark of a prefix-cache mechanism measures nothing" (W5) and the 40x phantom concurrency win
 *  that turned out to be a warm cache.
 *
 *  A nonce in front of the filler makes the prefix new every time, so the tokens really are allocated
 *  and the growth really is the cache. */
function fillerFor(chars: number, nonce: string): string {
  const body = FILLER_UNIT.repeat(Math.max(1, Math.ceil(chars / FILLER_UNIT.length)))
  return `${nonce} ${body}`
}

/** What happened to a reading offered to the store. `admitted:false` is not a failure — it is the store
 *  refusing to be made worse by a reading it cannot reconcile. */
export interface SampleAdmission {
  admitted: boolean
  reason: string
}

export function recordKvSample(modelId: string, sample: KvSample, cap = 8): SampleAdmission {
  if (!(sample?.contextTokens > 0 && sample?.kvBytes > 0)) {
    return { admitted: false, reason: "the reading carries no usable numbers" }
  }
  // A reading the fit will discard must never be WRITTEN. Storing it accomplishes nothing and does real
  // harm: the store is FIFO-capped, so sub-floor readings evict good ones, and a run of them looks like
  // agreement to the dispersion guard. Measured 2026-07-31: six discarded readings accumulated for one
  // model while the fit reported "no readings", and four more would have evicted the only true one.
  if (sample.contextTokens < MIN_SIGNAL_TOKENS) {
    return {
      admitted: false,
      reason: `taken over ${sample.contextTokens} tokens, below the ${MIN_SIGNAL_TOKENS}-token floor where drift outweighs the cache`,
    }
  }
  const store = readSamples()
  const existing = store[modelId] ?? []

  // A NEW reading that cannot be reconciled with the old ones must not be allowed to break the store.
  //
  // MEASURED 2026-08-01: one honest calibration wrote a disagreeing reading and moved this model's fit
  // from a usable 123,758 B/token to REFUSING — so planWindow could no longer size a window at all, and
  // the loader went silent, all from a measurement that was itself the wrong one. The dispersion guard
  // downstream behaved correctly; the defect was that the store admitted a reading it already had every
  // reason to distrust. Screening on the floor alone was never enough: agreement is the other half.
  //
  // On a real disagreement the SAFE reading is the more expensive one. Under-reading is the direction
  // that grants a window the machine cannot pay for and drives the desktop into swap; over-reading only
  // costs some window. So a cheaper outlier is refused outright, and a dearer one REPLACES the store and
  // says it did — never quietly averaged in, which is how a disagreement becomes a confident wrong number.
  const newRate = sample.kvBytes / sample.contextTokens
  const rates = existing
    .filter((s) => s.contextTokens >= MIN_SIGNAL_TOKENS && s.kvBytes > 0)
    .map((s) => s.kvBytes / s.contextTokens)
  if (rates.length) {
    const lo = Math.min(...rates, newRate)
    const hi = Math.max(...rates, newRate)
    if (lo > 0 && hi / lo > SAMPLE_DISPERSION_LIMIT) {
      const known = Math.max(...rates)
      if (newRate < known) {
        return {
          admitted: false,
          reason:
            `${Math.round(newRate).toLocaleString()} B/token disagrees with the ${Math.round(known).toLocaleString()} ` +
            `B/token already measured for this model (${(known / newRate).toFixed(1)}×) and is the CHEAPER of the two; ` +
            `a cheaper reading is the one that over-commits the machine, so the store keeps what it had`,
        }
      }
      store[modelId] = [sample]
      writeSamples(store)
      return {
        admitted: true,
        reason:
          `${Math.round(newRate).toLocaleString()} B/token disagrees with the ${Math.round(known).toLocaleString()} ` +
          `B/token previously stored and is DEARER; the older readings were discarded because trusting the ` +
          `cheaper one is what over-commits the machine`,
      }
    }
  }
  store[modelId] = [...existing, sample].slice(-cap)
  writeSamples(store)
  return { admitted: true, reason: `recorded ${Math.round(newRate).toLocaleString()} B/token` }
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
  opts: { tokens?: number; endpoint?: string; timeoutMs?: number; settleMs?: number } = {},
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
  const url = (opts.endpoint || process.env.FABULA_GRAPH_URL || "http://localhost:1235/v1").replace(/\/+$/, "")
  const deadline = opts.timeoutMs ?? 600_000
  // How long to let memory stop moving before taking a baseline.
  //
  // Real-world value, and ZERO under a test runner — not as a convenience but because it is the correct
  // number there: the settle exists to let a real serving runtime finish moving memory after a request,
  // and a test drives a marker script that moves none. MEASURED 2026-08-05: three settles put 8.2s of
  // pure sleep into one test, which on a loaded machine crossed the runner's own ceiling and made the
  // verdict depend on what else happened to be running — the same non-hermetic shape the pinned memory
  // readings already removed from this file's neighbours. An explicit `settleMs` still wins either way.
  const settleMs = opts.settleMs ?? (underTest ? 0 : 3000)

  // One nonce for the whole calibration: the two sized probes must SHARE a prefix with each other (that
  // is what makes the marginal cancel the warm pool) while sharing none with any earlier calibration.
  const nonce = `calibration ${Date.now().toString(36)}-${process.pid.toString(36)}:`

  /** One sized request: returns what the runtime says it held and what the machine grew by. */
  const probe = async (chars: number): Promise<{ tokens: number; grew: number } | null> => {
    const filler = fillerFor(chars, nonce)
    // Settle before the baseline: memory keeps moving for a moment after the previous request.
    await new Promise((r) => setTimeout(r, settleMs))
    const before = usedBytes()
    let peak = before
    const ticker = setInterval(() => {
      const now = usedBytes()
      if (now > peak) peak = now
    }, 750)
    try {
      const startedAt = Date.now()
      const res = await fetch(`${url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: `${filler}\n\nReply with one word: ok` }],
          max_tokens: 8, temperature: 0, stream: false,
        }),
        signal: AbortSignal.timeout(deadline),
      })
      if (!res.ok) return null
      const body: any = await res.json()
      const tokens = Number(body?.usage?.prompt_tokens) || 0
      const now = usedBytes()
      if (now > peak) peak = now
        // A REAL request of KNOWN size just happened at the currently-provisioned slot count, so the one
        // quantity nobody was measuring is free here. Normalised per thousand prompt tokens, because two
        // probes of different sizes are otherwise not comparable. Nothing is concluded from one reading:
        // a comparison appears only once this machine has been run at two different counts, which is
        // exactly when there is something to compare.
        if (tokens > 0) {
          const ms = Date.now() - startedAt
          if (ms > 0) {
            recordConcurrencySample({
              fingerprint: machineProfile().fingerprint,
              slots: plannedSlots(),
              msPerCall: (ms / tokens) * 1000,
              calls: 1,
            })
          }
        }
      return tokens > 0 ? { tokens, grew: peak - before } : null
    } catch {
      return null
    } finally {
      clearInterval(ticker)
    }
  }

  // WARM FIRST. A model sitting idle has its weights COMPRESSED; the first request forces them back to
  // wired, and because compressed pages hold less than the pages they expand into, that transition reads
  // as memory growth. Measured: a baseline taken while idle reported 485 248 bytes per token — four and a
  // half times the truth — because 22 GiB of weights coming back from compression landed in the number as
  // if it were cache.
  try {
    await fetch(`${url}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1, temperature: 0, stream: false }),
      signal: AbortSignal.timeout(deadline),
    })
  } catch {
    /* the warm-up only improves the baseline; a failure leaves it cold and the guards below refuse */
  }

  // LEARN THIS MODEL'S OWN CHARACTERS-PER-TOKEN, never assume it.
  //
  // MEASURED 2026-07-31: the floor was enforced on the REQUESTED size using a written-down 5.306
  // chars/token, while the sample recorded the runtime's own prompt_tokens. Ornith tokenizes this filler
  // at 7.77 chars/token, so every calibration asked for 32 768 and produced 22 373 — below the floor that
  // discards it. Six readings were written, every one thrown away, and the cold-start branch re-fired on
  // every call: an unbounded loop burning a 22k-token prefill each time, which can never converge.
  const cal = await probe(4096)
  if (!cal) return { ok: false, reason: "calibration probe produced no usable reading" }
  const charsPerToken = Math.max(1, 4096 / cal.tokens)

  // TWO SIZES, AND THE MARGINAL BETWEEN THEM — this is the correction that matters.
  //
  // MEASURED 2026-07-31 on this machine: two back-to-back calibrations of the SAME resident model at the
  // SAME size, seconds apart with no reload between, reported 3.44 GiB and then 1.22 GiB — 2.8x apart.
  // Only the FIRST request after a load allocates; every later one is served from a warm pool, so an
  // absolute single-point reading measures a cache HIT and reports a cost far below the truth. Six such
  // readings clustered near 60 000 B/token against a first-reading truth of 165 058.
  //
  // Under-reading is the DANGEROUS direction: at 60 000 the planner grants the full 262 144 passport,
  // which at the real cost needs 59.3 GiB of weights+cache on a 48 GiB Mac — precisely the drive-the-
  // desktop-into-swap failure this module exists to prevent.
  //
  // The marginal is immune to the pool: whatever is already warm serves BOTH requests, so it cancels,
  // and the extra tokens still have to be allocated from somewhere. This is also the method behind the
  // one measurement on record that ever agreed with itself (60 332 and 131 021 tokens, marginal 108 910).
  // The DELTA is what has to clear the floor, so the second probe carries headroom. Measured 2026-07-31:
  // sizing large = small x2 produced a delta of 31 491 tokens against a 32 768 floor — four percent
  // short, and the reading was correctly refused. The ratio learned from a short probe underestimates
  // how densely a tokenizer packs a long repeated passage, so the gap must not be sized to land exactly
  // on the floor.
  const small = Math.round(MIN_SIGNAL_TOKENS * charsPerToken)
  const large = Math.round(small * 2.6)
  const a = await probe(small)
  const b = await probe(large)
  if (!a || !b) return { ok: false, reason: "one of the two sized calibration requests failed" }

  // The arithmetic lives in the pure core, where it is tested exactly; this function only obtains the
  // two readings and hands them over.
  const m = marginalCost({ tokens: a.tokens, bytes: a.grew }, { tokens: b.tokens, bytes: b.grew })
  if (!(m.bytesPerToken > 0)) return { ok: false, reason: m.reason }
  const sample: KvSample = { contextTokens: m.deltaTokens, kvBytes: m.deltaBytes }
  const admission = recordKvSample(modelId, sample)
  // A refused reading is reported as such rather than as a success. The caller decides what to do about
  // a calibration the store would not take; pretending it landed is how a store silently stops matching
  // what the caller believes it holds.
  return {
    ok: admission.admitted, sample,
    reason: admission.admitted
      ? `${m.reason} (${m.bytesPerToken.toLocaleString()} B/token)`
      : `${m.reason} (${m.bytesPerToken.toLocaleString()} B/token) — NOT recorded: ${admission.reason}`,
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
 * The highest window that may be granted on load-time evidence ALONE — before even one request-time
 * reading exists for the model.
 *
 * MEASURED 2026-08-14, live on a 48 GB Mac with a freshly added MLX model: the load-time footprints
 * were 16384→9.12 GB, 32768→8.50 GB (the footprint FELL on a doubling — drift, not cache),
 * 65536→11.25 GB, 262144→12.61 GB. The fit through them reported 14,505 B/token while the model's
 * real cache cost is ~65,536 (16 full-attention layers × 4 KV heads × head dim 256 × fp16) — 4.5×
 * the fit. The plan therefore granted the full 262,144 passport, the runtime grew two ~200k-token
 * caches at once (retention plus in-flight), and the machine sat at 47 of 48 GiB until the owner
 * killed it by hand. On a lazy runtime a load-time fit prices DRIFT; the documented guard (refuse a
 * negative slope) only catches drift that happens to fall — drift that happens to rise reads as a
 * cheap cache and unlocks exactly the window the machine cannot pay for.
 *
 * The number is not a guess about caches: it is the smallest window at which the request-time
 * calibration itself can run — its large probe is 2.6 × MIN_SIGNAL_TOKENS (see calibrateCost), and
 * the third floor is headroom for output and drift. A window granted without samples is therefore a
 * MEASUREMENT rung: it exists to make the real reading possible, and the next switch plans from that
 * reading rather than from this cap.
 */
export const MAX_UNCALIBRATED_WINDOW =
  Math.ceil((3 * MIN_SIGNAL_TOKENS) / DEFAULT_POLICY.quantumTokens) * DEFAULT_POLICY.quantumTokens

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
  return plannedSlotsExplained(env).slots
}

/**
 * The same number, with WHERE it came from — which a bare integer cannot say.
 *
 * Three answers in order: what the operator set, what was measured on THIS machine, and one as the
 * declared unmeasured floor. The 1 in use was itself a real measurement, but on one machine: two
 * concurrent requests there cost 48.4s against 41.9s serialized, because concurrent prefill degrades
 * both instead of overlapping them. Sound for that machine, and not a fact about every machine — a host
 * with two accelerators can answer differently, and until this the core count was never even asked.
 */
export function plannedSlotsExplained(
  env: Record<string, string | undefined> = process.env,
): { slots: number; source: "operator" | "measured" | "unmeasured-floor" } {
  const e = env as NodeJS.ProcessEnv
  // 0 at the gate means "unlimited", which is not a provisioning a machine can be sized for — the honest
  // reading is one slot, and the gate still admits more while the runtime grows its cache lazily.
  return resolveSlots({
    envSlots: Number(env.FABULA_MAX_CONCURRENT_UPSTREAM),
    samples: readConcurrencySamples(e),
    fingerprint: machineProfile(e).fingerprint,
  })
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
      env: { ...process.env, PATH: `${pathPrefix()}:${process.env.PATH ?? ""}` },
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
      env: { ...process.env, PATH: `${pathPrefix()}:${process.env.PATH ?? ""}` },
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
      env: { ...process.env, PATH: `${pathPrefix()}:${process.env.PATH ?? ""}` },
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
      env: { ...process.env, PATH: `${pathPrefix()}:${process.env.PATH ?? ""}` },
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
    // that would tie this file to one serving stack. Which of the two spoke is remembered: a window
    // granted on the load-time fit alone is capped (see MAX_UNCALIBRATED_WINDOW), because on a lazy
    // runtime that fit prices drift, not cache.
    const samples = readSamples()[modelId] ?? []
    const sampled = fitCostFromSamples(samples)
    const fromSamples = sampled.bytesPerToken > 0
    const cost = fromSamples ? sampled : fitCost(store[modelId] ?? [])
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
      const free = Math.max(0, totalBytes() - usedBytes() - DEFAULT_POLICY.systemReserveBytes)
      // The doubling never climbs past the measurement rung: a window nobody has measured at is exactly
      // what MAX_UNCALIBRATED_WINDOW exists to prevent, whether it arrives by plan or by ladder.
      const second = basis.windowTokens > 0
        ? Math.min(safeSecondWindow(basis, free, me.passport), MAX_UNCALIBRATED_WINDOW)
        : 0
      if (!(second > basis.windowTokens)) {
        return {
          acted: false,
          window: me.loadedWindow,
          reason:
            `cache cost for ${modelId} not learned yet (${cost.reason}); no window above the measurement ` +
            `rung to take one at (loaded ${basis.windowTokens || "nothing"}, rung ${MAX_UNCALIBRATED_WINDOW})`,
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
    const weights = weightsBytesOf(modelId) || weightsOnDisk(modelId) || cost.weightsBytes || me.bytes
    if (!(weights > 0)) {
      return {
        acted: false,
        window: me.loadedWindow,
        reason: `cannot size a window for ${modelId} without knowing its weights; the serving runtime reported none`,
      }
    }

    // THE POLICY IS DERIVED FROM THIS MACHINE, never carried across from another. The four numbers were
    // measured on unified memory, where the reserve is a JUDGEMENT — how much to leave a desktop that
    // shares the pool. A discrete card has no desktop in its pool and nothing to judge: what must be left
    // alone is what is ALREADY HELD, and the driver reports that figure. So the same field is a choice on
    // one machine and a reading on another, and both are honest. Only `unknown` still refuses, because it
    // is not a description of a machine but the absence of one — and a plan built on it would be a guess
    // wearing a measurement's clothes. Before this, a user with a graphics card got no plan at all.
    const reading = memoryReading()
    const pool = reading.kind === "discrete-vram"
      ? { kind: reading.kind, totalBytes: reading.total, usedBytes: reading.used }
      : { kind: reading.kind, totalBytes: totalBytes(), usedBytes: usedBytes() }
    const policy = policyFor(pool)
    if (!policy) {
      return { acted: false, window: me.loadedWindow, reason: noPolicyReason(pool) }
    }

    const plan = planWindow({
      policy,
      passportTokens: me.passport,
      // Size against the pool the cache will actually live in — the card's memory where there is one.
      totalBytes: pool.totalBytes,
      weightsBytes: weights,
      bytesPerToken: cost.bytesPerToken,
      residents: residentsOther(served, modelId),
      // Provision exactly the concurrency the gate will admit — see plannedSlots. A slot the gate never
      // uses buys nothing and takes window away from the request that IS running.
      slots: plannedSlots(),
    })

    if (!plan.fits) return { acted: false, window: me.loadedWindow, plan, reason: plan.reason }

    // A window computed from load-time readings alone is not trusted with its own size. On a lazy
    // runtime those readings carry no cache term, so the fit prices drift — measured 2026-08-14, a
    // drift fit four and a half times under the truth granted a full passport and put the machine at
    // 47 of 48 GiB. The grant is capped at the measurement rung and the real reading is taken THERE,
    // so the next switch plans from a measurement instead of a guess.
    const grant = fromSamples ? plan.tokens : Math.min(plan.tokens, MAX_UNCALIBRATED_WINDOW)
    let note = !fromSamples && grant < plan.tokens
      ? `; capped at ${grant} of ${plan.tokens} because no request-time reading exists for this model yet — the cap is the window the calibration needs, so the next switch plans from a real measurement`
      : ""
    // A window ABOVE the ceiling is not a preference to respect, it is a provisioning the machine cannot
    // pay for — and the damage is silent. MEASURED 2026-07-26: this model sat at 262144 against a
    // computed ceiling of 135168, and the Mac lived at 0.6 GiB free with 18 GiB compressed and 8.8 GiB
    // of swap while the model was IDLE. Raising only was written when the risk was believed to be a
    // window loaded too SMALL; the opposite risk turned out to be the live one.
    //
    // The margin exists so a ceiling that breathes with free memory cannot cause a reload every time a
    // browser tab opens — and every reload throws away the whole prefix cache. Only a window that
    // over-shoots by more than the margin is worth the reload it costs.
    const over = me.loadedWindow > grant * (1 + OVERSHOOT_MARGIN)
    if (me.state === "loaded" && me.loadedWindow >= grant && !over) {
      return { acted: false, window: me.loadedWindow, plan, reason: `already at ${me.loadedWindow}; ${plan.reason}${note}` }
    }

    // A reload discards every cached prefix, so a live turn pays for it. Wait for quiet when the caller
    // supplies a way to ask; if quiet never comes, say so plainly rather than interrupting real work.
    if (opts.quiet && !(await opts.quiet())) {
      return {
        acted: false,
        window: me.loadedWindow,
        plan,
        reason: `would raise ${me.loadedWindow} -> ${grant}, but the machine never went quiet; leaving it alone`,
      }
    }

    const r = await lmsLoad(modelId, grant, opts.loadTimeoutMs ?? 180_000)
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

    // DID THE RUNTIME ACTUALLY DO IT? A load command that returns success is not a window that changed.
    //
    // MEASURED 2026-07-31: `lms load ornith-1.0-35b --context-length 143360` exited 0, printed no error,
    // and left the model at 183 296 — the flag was accepted and silently ignored (that model's own config
    // carries a preferred window the CLI does not override; the same flag is honoured for other models).
    // The old text then reported "lowered 183296 -> 183296", which is the loader announcing an action it
    // did not perform. Worse, the refusal is the DANGEROUS direction: the runtime keeps a window WIDER
    // than the plan, so the machine carries an over-commit the planner believes it removed.
    //
    // So the result now states the refusal and prices it, rather than reporting a number nobody honoured.
    const got = after?.loadedWindow ?? 0
    const overshoot = got > 0 && grant > 0 ? got / grant : 1
    if (got > 0 && overshoot > 1 + OVERSHOOT_MARGIN) {
      const perTok = cost.bytesPerToken || 0
      const needGiB = perTok > 0 ? ((weights + got * perTok) / 1024 ** 3).toFixed(1) : "?"
      return {
        acted: true,
        window: got,
        plan,
        reason:
          `the runtime REFUSED the window: asked for ${grant}, it loaded at ${got} ` +
          `(${overshoot.toFixed(2)}x the plan). Nothing here can lower it — that model's own configuration ` +
          `outranks the load flag. At the measured cost this provisioning needs ${needGiB} GiB, and the ` +
          `machine is sized for ${((totalBytes() - DEFAULT_POLICY.systemReserveBytes) * DEFAULT_POLICY.commitFraction / 1024 ** 3).toFixed(1)} GiB.`,
      }
    }

    // THE POINT OF THE CAPPED RUNG: take the real reading now, at a window the calibration's probes fit
    // in, so the next switch plans from a measurement. A calibration that does not land is reported as
    // such — the next switch retries it, and until one lands the window stays at the rung.
    if (!fromSamples && grant < plan.tokens) {
      const cal = await calibrateCost(modelId)
      note += cal.ok
        ? `; calibration at ${grant} recorded the real cost (${cal.reason}) — the next switch plans from it`
        : `; calibration at ${grant} did not land and is retried on the next switch`
    }

    return {
      acted: true,
      window: got || grant,
      plan,
      reason: `${me.loadedWindow && grant < me.loadedWindow ? "lowered" : "raised"} ${me.loadedWindow || "unloaded"} -> ${after?.loadedWindow ?? grant}: ${plan.reason}${note}`,
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
