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

import { spawn } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir, totalmem } from "node:os"
import { planWindow, type Resident, type WindowPlan } from "./windowplan"
import { fitCost, addObservation, type Observation } from "./kvcost"

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

export interface EnsureResult {
  acted: boolean
  window: number
  plan?: WindowPlan
  reason: string
}

const inFlight = new Map<string, Promise<EnsureResult>>()

/** Run `lms load`. Resolves with the command's own words so a failure is reportable, not guessed at. */
function lmsLoad(modelId: string, window: number, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const args = ["load", modelId, "--context-length", String(window), "-y"]
    const child = spawn("lms", args, {
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
    if (me.state === "loaded" && me.loadedWindow > 0 && me.bytes > 0) {
      store[modelId] = addObservation(store[modelId] ?? [], {
        windowTokens: me.loadedWindow,
        totalBytes: me.bytes,
      })
      writeStore(store)
    }

    const cost = fitCost(store[modelId] ?? [])
    if (!(cost.bytesPerToken > 0)) {
      // Cold start. If it is already loaded, this reading plus the next one at a different window will
      // give us the line — so wait rather than load blind. If it is NOT loaded, letting the serving
      // default bring it up is the safe small step that produces that second reading.
      return {
        acted: false,
        window: me.loadedWindow,
        reason: `cache cost for ${modelId} not learned yet (${cost.reason}); staying at the serving default until a second reading exists`,
      }
    }

    const plan = planWindow({
      passportTokens: me.passport,
      totalBytes: totalmem(),
      weightsBytes: cost.weightsBytes,
      bytesPerToken: cost.bytesPerToken,
      residents: residentsOther(served, modelId),
    })

    if (!plan.fits) return { acted: false, window: me.loadedWindow, plan, reason: plan.reason }
    if (me.state === "loaded" && me.loadedWindow >= plan.tokens) {
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
    if (after?.bytes && after.loadedWindow > 0) {
      const s2 = readStore()
      s2[modelId] = addObservation(s2[modelId] ?? [], {
        windowTokens: after.loadedWindow,
        totalBytes: after.bytes,
      })
      writeStore(s2)
    }

    return {
      acted: true,
      window: after?.loadedWindow ?? plan.tokens,
      plan,
      reason: `raised ${me.loadedWindow || "unloaded"} -> ${after?.loadedWindow ?? plan.tokens}: ${plan.reason}`,
    }
  })()

  inFlight.set(modelId, job)
  try {
    return await job
  } finally {
    inFlight.delete(modelId)
  }
}
