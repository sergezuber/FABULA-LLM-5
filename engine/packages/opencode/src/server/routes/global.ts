import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Effect } from "effect"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { GlobalBus } from "@/bus/global"
import { AppRuntime } from "@/effect/app-runtime"
import { AsyncQueue } from "@/util/queue"
import { Instance } from "../../project/instance"
import { Installation } from "@/installation"
import { instanceDirectoryAllowed } from "./instance/middleware"

// FABULA: sessions that must be EXCLUDED from every fabula/* data surface (chat list, usage, stats,
// search). Two independent sources:
//   1. external_import — sessions the engine's importers pulled in from other tools.
//   2. Sessions that ran a model whose provider FABULA does not ship. FABULA is a local-first app
//      configured with lmstudio / nvidia / zai / mimo providers only; it has NO `anthropic` provider,
//      so a session that used an anthropic-provider model is foreign history (a coding-tool transcript)
//      that entered the shared engine DB WITHOUT an external_import row. Such sessions leaked into the
//      stats ("By models" showing anthropic/* models) — this second source closes that gap.
// `dirs` (JSON array of the app's project directories) optionally narrows results to workspaces opened
// in FABULA. Providers FABULA never ships — any session using one is foreign. Kept as a set for easy
// extension; matched against the exact `model.providerID` field (not chat text) via json_extract.
const FABULA_FOREIGN_PROVIDERS = ["anthropic"] as const
// The foreign scan is a full json_extract pass over the message table and the result only changes when
// history is imported (disabled in the app), so a short TTL keeps the hot routes cheap.
let fabulaExcludedCache: { at: number; ids: Set<string> } | undefined
const FABULA_EXCLUDED_TTL_MS = 30_000
async function fabulaImportedSessionIds(): Promise<Set<string>> {
  const now = Date.now()
  if (fabulaExcludedCache && now - fabulaExcludedCache.at < FABULA_EXCLUDED_TTL_MS) return fabulaExcludedCache.ids
  const { Database } = await import("@/storage")
  const { ExternalImportTable } = await import("@/session/external-import.sql")
  const { sql, inArray } = await import("drizzle-orm")
  const { MessageTable } = await import("@/session/session.sql")
  const ids = Database.use((db) => {
    const imported = db.select({ id: ExternalImportTable.session_id }).from(ExternalImportTable).all()
    const foreign = db
      .selectDistinct({ id: MessageTable.session_id })
      .from(MessageTable)
      .where(inArray(sql`json_extract(${MessageTable.data}, '$.model.providerID')`, [...FABULA_FOREIGN_PROVIDERS]))
      .all()
    return new Set<string>([...imported.map((row) => row.id), ...foreign.map((row) => row.id)])
  })
  fabulaExcludedCache = { at: now, ids }
  return ids
}

// FABULA: the Verified-Autonomy telemetry below scans the whole part table with leading-wildcard
// LIKEs (no index can serve them) on the synchronous sqlite driver, and the Home widget hits
// /fabula/usage on every render — so memoize the aggregate per (days, dirs) for a short TTL.
// Capped so arbitrary `dirs` query strings cannot grow the map without bound.
type FabulaVerifiedStats = {
  verifiedRuns: number
  failedVerifies: number
  notDoneVerdicts: number
  autoRewinds: number
  receiptsMinted: number
  secondOpinions: number
}
const fabulaVerifiedCache = new Map<string, { at: number; value: FabulaVerifiedStats }>()
const FABULA_VERIFIED_TTL_MS = 60_000
const FABULA_VERIFIED_CACHE_MAX = 32

function fabulaParseDirs(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return undefined
    const dirs = parsed.filter((d): d is string => typeof d === "string" && d.length > 0)
    return dirs.length ? dirs.map((d) => d.replace(/\/+$/, "")) : undefined
  } catch {
    return undefined
  }
}

function fabulaDirMatch(directory: string, dirs: string[] | undefined): boolean {
  if (!dirs) return true
  const d = directory.replace(/\/+$/, "")
  return dirs.some((base) => d === base || d.startsWith(base + "/"))
}
import { InstallationVersion } from "@/installation/version"
import { Log } from "../../util"
import { lazy } from "../../util/lazy"
import { Config } from "../../config"
import { ExternalImport } from "../../session/external-import"
import { errors } from "../error"
import nodePath from "path"
import nodeOs from "node:os"
import nodeFs from "fs"
import { Global } from "@/global"

const log = Log.create({ service: "server" })

// Cap on buffered SSE events per connection. The bus delta firehose is pushed
// into the queue synchronously and never blocks the producer, so a slow/stalled
// consumer would otherwise grow it without limit and exhaust server memory.
// Events are best-effort telemetry (DB authoritative + heartbeat) so drop-oldest
// is safe under sustained backpressure. At ~1KB/event the default is ≈10MB
// worst-case per stalled connection. See routes/instance/event.ts for the full
// rationale (incl. heartbeat/sentinel lag under saturation). Tune via env.
const EVENT_QUEUE_CAPACITY = Number(process.env["MIMOCODE_EVENT_QUEUE_CAPACITY"]) || 10_000

export const GlobalDisposedEvent = BusEvent.define("global.disposed", z.object({}))

// ---- FABULA registries (skills / agents / commands are plain markdown files) ----
// Everything lives under the config dir (MIMOCODE_CONFIG_DIR in the app launch env), so
// CRUD = file CRUD; the engine picks changes up on the next start — same contract as plugins.
type RegistryKind = "skills" | "agents" | "commands"
const REGISTRY_BUILTINS: Record<RegistryKind, string[]> = {
  skills: [],
  agents: ["build", "plan", "compose"],
  commands: ["init", "review", "dream", "distill", "goal"],
}
function fabulaConfigDir() {
  const dir = process.env["MIMOCODE_CONFIG_DIR"]
  return dir && dir.length > 0 ? dir : Global.Path.config
}
function registryRoot(kind: RegistryKind, scope?: string, dir?: string) {
  // Project scope maps to the engine's own per-project config dir contract (<project>/.mimocode);
  // skills have no project-level loader, so they stay global-only.
  if (scope === "project" && dir && kind !== "skills") {
    return nodePath.join(dir, ".mimocode", kind === "agents" ? "agent" : "command")
  }
  if (kind === "skills") return process.env["FABULA_SKILLS_DIR"] || nodePath.join(fabulaConfigDir(), "skills")
  if (kind === "agents") return nodePath.join(fabulaConfigDir(), "agent")
  return nodePath.join(fabulaConfigDir(), "command")
}
function frontmatterField(content: string, field: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return undefined
  const line = match[1].split("\n").find((l) => l.trimStart().startsWith(field + ":"))
  if (!line) return undefined
  return line
    .slice(line.indexOf(":") + 1)
    .trim()
    .replace(/^["']|["']$/g, "")
}
async function listRegistry(kind: RegistryKind, root: string) {
  // Disabled items stay on disk as `<file>.md.disabled` (skills: `SKILL.md.disabled`) — the engine
  // scanner only picks up `.md`, so the rename IS the off switch; the list shows both states.
  const out: { name: string; file: string; description?: string; content: string; enabled: boolean }[] = []
  const isDir = await nodeFs.promises
    .stat(root)
    .then((s) => s.isDirectory())
    .catch(() => false)
  if (!isDir) return out
  for (const entry of await nodeFs.promises.readdir(root, { withFileTypes: true })) {
    if (kind === "skills") {
      if (!entry.isDirectory()) continue
      const active = nodePath.join(root, entry.name, "SKILL.md")
      const disabled = nodePath.join(root, entry.name, "SKILL.md.disabled")
      const file = (await Bun.file(active).exists()) ? active : disabled
      const content = await Bun.file(file)
        .text()
        .catch(() => undefined)
      if (content === undefined) continue
      out.push({
        name: entry.name,
        file,
        description: frontmatterField(content, "description"),
        content,
        enabled: file === active,
      })
      continue
    }
    if (!entry.isFile()) continue
    const enabled = entry.name.endsWith(".md")
    if (!enabled && !entry.name.endsWith(".md.disabled")) continue
    const file = nodePath.join(root, entry.name)
    const content = await Bun.file(file)
      .text()
      .catch(() => "")
    out.push({
      name: entry.name.replace(/\.md(\.disabled)?$/, ""),
      file,
      description: frontmatterField(content, "description"),
      content,
      enabled,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
function registryTemplate(kind: RegistryKind, name: string) {
  if (kind === "skills")
    return `---\nname: ${name}\ndescription: Describe when to use this skill\n---\n\nSkill instructions.\n`
  if (kind === "agents")
    return `---\ndescription: When to use this agent\nmode: subagent\n---\n\nAgent system prompt.\n`
  return `---\ndescription: What the command does\n---\n\nCommand prompt template. Arguments: $ARGUMENTS\n`
}

// ---- FABULA git helpers (direct shell-outs; NOT gated by MIMOCODE_DISABLE_GIT, which only
// affects the engine's project discovery) ----
async function runGit(dir: string, args: string[]) {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" })
    const [rawOut, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    // raw preserves leading whitespace — REQUIRED for porcelain parsing, where the first
    // column of the very first line is significant (trim() was eating it).
    return { code, out: rawOut.trim(), raw: rawOut, err: err.trim() }
  } catch (e) {
    return { code: 127, out: "", raw: "", err: String(e) }
  }
}

// One OpenAI-compatible call to the configured default model (same config resolution as the
// prompt-enhance route): resolves {file:PATH}/{env:VAR}/${VAR} apiKey refs, strips <think>.
async function fabulaModelCall(
  system: string,
  user: string,
  modelRef?: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const cfgPath = process.env["MIMOCODE_CONFIG"]
  const cfg = cfgPath
    ? await Bun.file(cfgPath)
        .json()
        .catch(() => ({}))
    : {}
  const ref = modelRef || (cfg as { model?: string }).model || ""
  const slash = ref.indexOf("/")
  const providerID = slash > 0 ? ref.slice(0, slash) : ref
  const modelID = slash > 0 ? ref.slice(slash + 1) : ref
  const prov = ((cfg as { provider?: Record<string, { options?: { baseURL?: string; apiKey?: string } }> })
    .provider ?? {})[providerID]
  const baseURL = prov?.options?.baseURL
  if (!baseURL) return { ok: false, error: "no baseURL for provider" }
  const resolveKey = async (raw?: string): Promise<string> => {
    if (!raw) return "x"
    const file = raw.match(/^\{file:(.+)\}$/)
    if (file)
      return (
        (
          await Bun.file(file[1].trim())
            .text()
            .catch(() => "")
        ).trim() || "x"
      )
    const env = raw.match(/^\{env:(.+)\}$/) || raw.match(/^\$\{?([A-Z0-9_]+)\}?$/)
    if (env) return (process.env[env[1].trim()] || "x").trim()
    return raw
  }
  const apiKey = await resolveKey(prov?.options?.apiKey)
  const resp = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelID,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
      stream: false,
    }),
  }).catch((e) => ({ ok: false, statusText: String(e) }) as Response)
  if (!("ok" in resp) || !resp.ok) return { ok: false, error: "model call failed" }
  const data = (await (resp as Response).json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[]
  }
  const text = (data.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
  if (!text) return { ok: false, error: "empty response" }
  return { ok: true, text }
}

async function streamEvents(c: Context, subscribe: (q: AsyncQueue<string | null>) => () => void) {
  return streamSSE(c, async (stream) => {
    const q = new AsyncQueue<string | null>({ capacity: EVENT_QUEUE_CAPACITY })
    let done = false

    q.push(
      JSON.stringify({
        payload: {
          type: "server.connected",
          properties: {},
        },
      }),
    )

    // Send heartbeat every 10s to prevent stalled proxy streams.
    const heartbeat = setInterval(() => {
      q.push(
        JSON.stringify({
          payload: {
            type: "server.heartbeat",
            properties: {},
          },
        }),
      )
    }, 10_000)

    const stop = () => {
      if (done) return
      done = true
      clearInterval(heartbeat)
      unsub()
      q.push(null)
      if (q.dropped > 0) log.warn("global event dropped under backpressure", { dropped: q.dropped })
      log.info("global event disconnected", { buffered: q.size })
    }

    const unsub = subscribe(q)

    stream.onAbort(stop)

    try {
      for await (const data of q) {
        if (data === null) return
        await stream.writeSSE({ data })
      }
    } finally {
      stop()
    }
  })
}

export const GlobalRoutes = lazy(() =>
  new Hono()
    .get(
      "/health",
      describeRoute({
        summary: "Get health",
        description: "Get health information about the FABULA server.",
        operationId: "global.health",
        responses: {
          200: {
            description: "Health information",
            content: {
              "application/json": {
                schema: resolver(z.object({ healthy: z.literal(true), version: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ healthy: true, version: InstallationVersion })
      },
    )
    .get(
      "/event",
      describeRoute({
        summary: "Get global events",
        description: "Subscribe to global events from the engine using server-sent events.",
        operationId: "global.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      directory: z.string(),
                      project: z.string().optional(),
                      workspace: z.string().optional(),
                      payload: z.union([...BusEvent.payloads(), ...SyncEvent.payloads()]),
                    })
                    .meta({
                      ref: "GlobalEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global event connected")
        c.header("Cache-Control", "no-cache, no-transform")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")

        return streamEvents(c, (q) => {
          async function handler(event: any) {
            q.push(JSON.stringify(event))
          }
          GlobalBus.on("event", handler)
          return () => GlobalBus.off("event", handler)
        })
      },
    )
    .get(
      "/config",
      describeRoute({
        summary: "Get global configuration",
        description: "Retrieve the current global engine configuration settings and preferences.",
        operationId: "global.config.get",
        responses: {
          200: {
            description: "Get global config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal())))
      },
    )
    .patch(
      "/config",
      describeRoute({
        summary: "Update global configuration",
        description: "Update global engine configuration settings and preferences.",
        operationId: "global.config.update",
        responses: {
          200: {
            description: "Successfully updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        const next = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.updateGlobal(config)))
        return c.json(next)
      },
    )
    // FABULA: the full set of externally-imported session ids, so the client can exclude them from
    // per-project session stores (sidebar previews, palettes) that go through the generic session.list.
    .get(
      "/fabula/imported-ids",
      describeRoute({
        summary: "Imported session ids",
        operationId: "fabula.importedIds",
        responses: { 200: { description: "Ids" } },
      }),
      async (c) => c.json({ ids: [...(await fabulaImportedSessionIds())] }),
    )
    // FABULA: directories whose sessions ALL came from external importers — the app removes such
    // projects from its registry automatically (they were never worked on through FABULA).
    .get(
      "/fabula/import-only-dirs",
      describeRoute({
        summary: "Directories that contain only imported sessions",
        operationId: "fabula.importOnlyDirs",
        responses: { 200: { description: "Directories" } },
      }),
      async (c) => {
        const { Database } = await import("@/storage")
        const { SessionTable } = await import("@/session/session.sql")
        const imported = await fabulaImportedSessionIds()
        if (imported.size === 0) return c.json({ dirs: [] })
        const rows = Database.use((db) =>
          db.select({ id: SessionTable.id, directory: SessionTable.directory }).from(SessionTable).all(),
        )
        const byDir = new Map<string, { imported: number; native: number }>()
        for (const row of rows) {
          const entry = byDir.get(row.directory) ?? { imported: 0, native: 0 }
          if (imported.has(row.id)) entry.imported++
          else entry.native++
          byDir.set(row.directory, entry)
        }
        const dirs = [...byDir.entries()].filter(([, n]) => n.imported > 0 && n.native === 0).map(([d]) => d)
        return c.json({ dirs })
      },
    )
    // FABULA: application data locations for Settings ▸ General (read-only; the DB lives in data).
    .get(
      "/fabula/paths",
      describeRoute({
        summary: "FABULA data locations",
        description: "Absolute paths of the config, data, state and log directories.",
        operationId: "fabula.paths",
        responses: { 200: { description: "Paths" } },
      }),
      async (c) =>
        c.json({
          config: Global.Path.config,
          data: Global.Path.data,
          state: Global.Path.state,
          log: Global.Path.log,
        }),
    )
    // FABULA: plugin enable/disable backed by the same fabula-state.json convention the
    // plugins' own self-gating reads (lib/manage.ts). Toggles apply on the next engine start.
    .get(
      "/fabula/plugins",
      describeRoute({
        summary: "List FABULA plugins",
        description: "List configured plugin modules with their enabled state.",
        operationId: "fabula.plugins.list",
        responses: { 200: { description: "Plugins" } },
      }),
      async (c) => {
        // FABULA plugins are the `fabula-*.ts` files the engine scans in the config-dir plugin
        // folder (~/.config/mimocode/plugin, a symlink to the repo plugin/). Enabled state lives
        // in fabula-state.json alongside it (same file lib/manage.ts reads for self-gating).
        const pluginDir = nodePath.join(Global.Path.config, "plugin")
        const files = await nodeFs.promises.readdir(pluginDir).catch(() => [] as string[])
        const statePath = nodePath.join(Global.Path.config, "fabula-state.json")
        const state = await Bun.file(statePath)
          .json()
          .catch(() => ({ disabled: [] as string[] }))
        const disabled = Array.isArray(state?.disabled) ? state.disabled.map(String) : []
        // Human names/descriptions come from the plugin folder's own i18n table (single source of
        // truth — the same one list_plugins and the native menu render). Bun transpiles the TS on
        // the fly; a missing/broken table just means bare ids (fail-open, never a 500).
        const i18n = await import(nodePath.join(pluginDir, "lib", "i18n.ts"))
          .then((m) => (m?.PLUGIN_I18N ?? m?.default ?? {}) as Record<string, Record<string, unknown>>)
          .catch(() => ({}) as Record<string, Record<string, unknown>>)
        const str = (v: unknown) => (typeof v === "string" && v.length ? v : undefined)
        const list = files
          .filter((f) => /^fabula-.*\.ts$/.test(f) && !f.endsWith(".d.ts"))
          .sort()
          .map((f) => {
            const id = f.replace(/\.ts$/, "").replace(/^fabula-/, "")
            const meta = i18n[id] ?? {}
            return {
              id,
              file: `plugin/${f}`,
              enabled: !disabled.includes(id),
              name: str(meta.nameEn) ?? str(meta.name),
              nameRu: str(meta.nameRu),
              desc: str(meta.descEn),
              descRu: str(meta.descRu),
              tags: Array.isArray(meta.tags) ? meta.tags.filter((t): t is string => typeof t === "string") : undefined,
            }
          })
        return c.json({ plugins: list, root: pluginDir })
      },
    )
    .post(
      "/fabula/plugins",
      describeRoute({
        summary: "Toggle a FABULA plugin",
        description: "Enable or disable a plugin by id; applies on the next engine start.",
        operationId: "fabula.plugins.toggle",
        responses: { 200: { description: "Toggle result" } },
      }),
      validator("json", z.object({ id: z.string(), enabled: z.boolean() })),
      async (c) => {
        const body = c.req.valid("json")
        const statePath = nodePath.join(Global.Path.config, "fabula-state.json")
        const state = await Bun.file(statePath)
          .json()
          .catch(() => ({ disabled: [] as string[], enabled: [] as string[] }))
        const disabled = new Set<string>(Array.isArray(state?.disabled) ? state.disabled.map(String) : [])
        if (body.enabled) disabled.delete(body.id)
        else disabled.add(body.id)
        const next = {
          ...state,
          disabled: [...disabled],
          enabled: Array.isArray(state?.enabled) ? state.enabled : [],
        }
        await Bun.write(statePath, JSON.stringify(next, null, 2))
        return c.json({ ok: true, id: body.id, enabled: body.enabled })
      },
    )
    // FABULA: permission mode (default | acceptEdits | plan | bypass) — same
    // fabula-permissions.json the security plugin's guards read (lib/permissions.ts).
    .get(
      "/fabula/pmode",
      describeRoute({
        summary: "Get FABULA permission mode",
        operationId: "fabula.pmode.get",
        responses: { 200: { description: "Mode" } },
      }),
      async (c) => {
        const p = nodePath.join(Global.Path.config, "fabula-permissions.json")
        const state = await Bun.file(p)
          .json()
          .catch(() => ({ mode: "default" }))
        const mode = ["default", "acceptEdits", "plan", "bypass"].includes(state?.mode) ? state.mode : "default"
        const allow = Object.entries((state?.allow ?? {}) as Record<string, boolean>)
          .filter(([, on]) => on)
          .map(([key]) => key)
        return c.json({ mode, allow })
      },
    )
    .post(
      "/fabula/pmode",
      describeRoute({
        summary: "Set FABULA permission mode / allow-list",
        operationId: "fabula.pmode.set",
        responses: { 200: { description: "Result" } },
      }),
      validator(
        "json",
        z.object({
          mode: z.enum(["default", "acceptEdits", "plan", "bypass"]).optional(),
          allowAdd: z.string().optional(),
          allowRemove: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const p = nodePath.join(Global.Path.config, "fabula-permissions.json")
        const state = (await Bun.file(p)
          .json()
          .catch(() => ({}))) as { mode?: string; modeOrigin?: string; allow?: Record<string, boolean> }
        if (body.mode) {
          state.mode = body.mode
          // This route IS the owner — it is only reachable from Settings ▸ Permissions and the CLI.
          // Stamping the origin is load-bearing: the guards honour `bypass` only when the owner set it,
          // and without this line an earlier agent-set origin stayed on the record forever. One harmless
          // agent call was enough to kill the owner's own bypass switch, with the UI still showing it on
          // and no error anywhere.
          state.modeOrigin = "owner"
        }
        if (body.allowAdd?.trim()) state.allow = { ...state.allow, [body.allowAdd.trim()]: true }
        if (body.allowRemove) {
          const allow = { ...state.allow }
          delete allow[body.allowRemove]
          state.allow = allow
        }
        await Bun.write(p, JSON.stringify(state, null, 2))
        return c.json({ ok: true, mode: state.mode ?? "default" })
      },
    )
        // FABULA: MCP connectors of the launch config — Settings > Connectors. Add takes a full JSON
    // entry (the engine's mcp schema); changes apply on the next engine start.
    .get(
      "/fabula/mcp",
      describeRoute({
        summary: "List MCP connectors from the launch config",
        operationId: "fabula.mcp.list",
        responses: { 200: { description: "Connectors" } },
      }),
      async (c) => {
        const cfgPath = process.env["MIMOCODE_CONFIG"]
        const cfg = cfgPath
          ? await Bun.file(cfgPath)
              .json()
              .catch(() => ({}))
          : {}
        const mcp = ((cfg as { mcp?: Record<string, Record<string, unknown>> }).mcp ?? {}) as Record<
          string,
          Record<string, unknown>
        >
        return c.json({
          servers: Object.entries(mcp).map(([name, spec]) => ({
            name,
            type: (spec["type"] as string) ?? "local",
            enabled: spec["enabled"] !== false,
            command: Array.isArray(spec["command"]) ? (spec["command"] as string[]).join(" ") : undefined,
            url: (spec["url"] as string) ?? undefined,
          })),
        })
      },
    )
    .post(
      "/fabula/mcp",
      describeRoute({
        summary: "Add/remove/toggle an MCP connector",
        operationId: "fabula.mcp.write",
        responses: { 200: { description: "Result" } },
      }),
      validator(
        "json",
        z.object({
          action: z.enum(["add", "remove", "toggle"]),
          name: z.string().min(1),
          config: z.string().optional(),
          enabled: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const cfgPath = process.env["MIMOCODE_CONFIG"]
        if (!cfgPath) return c.json({ ok: false, error: "no MIMOCODE_CONFIG" }, 400)
        const cfg = (await Bun.file(cfgPath)
          .json()
          .catch(() => undefined)) as Record<string, unknown> | undefined
        if (!cfg) return c.json({ ok: false, error: "config unreadable" }, 500)
        const mcp = { ...((cfg["mcp"] as Record<string, unknown>) ?? {}) }
        if (body.action === "add") {
          let spec: unknown
          try {
            spec = JSON.parse(body.config ?? "")
          } catch {
            return c.json({ ok: false, error: "config must be valid JSON" }, 400)
          }
          if (!spec || typeof spec !== "object" || Array.isArray(spec))
            return c.json({ ok: false, error: "config must be a JSON object" }, 400)
          mcp[body.name] = spec
        }
        if (body.action === "remove") delete mcp[body.name]
        if (body.action === "toggle") {
          const entry = mcp[body.name] as Record<string, unknown> | undefined
          if (!entry) return c.json({ ok: false, error: "unknown connector" }, 400)
          mcp[body.name] = { ...entry, enabled: body.enabled ?? entry["enabled"] === false }
        }
        await Bun.write(cfgPath, JSON.stringify({ ...cfg, mcp }, null, 2))
        return c.json({ ok: true })
      },
    )
    // FABULA: default model of the launch config (fabula.config.json). Reading/writing the same
    // file the server was started with; new sessions pick the new default up.
    .get(
      "/fabula/model",
      describeRoute({
        summary: "Get FABULA default model",
        operationId: "fabula.model.get",
        responses: { 200: { description: "Model" } },
      }),
      async (c) => {
        const cfgPath = process.env["MIMOCODE_CONFIG"]
        if (!cfgPath) return c.json({ model: undefined })
        const cfg = await Bun.file(cfgPath)
          .json()
          .catch(() => ({}))
        return c.json({ model: (cfg as { model?: string }).model })
      },
    )
    .post(
      "/fabula/model",
      describeRoute({
        summary: "Set FABULA default model",
        operationId: "fabula.model.set",
        responses: { 200: { description: "Result" } },
      }),
      validator("json", z.object({ model: z.string().min(1) })),
      async (c) => {
        const body = c.req.valid("json")
        const cfgPath = process.env["MIMOCODE_CONFIG"]
        if (!cfgPath) return c.json({ ok: false, error: "no MIMOCODE_CONFIG" }, 400)
        const cfg = await Bun.file(cfgPath)
          .json()
          .catch(() => undefined)
        if (!cfg || typeof cfg !== "object") return c.json({ ok: false, error: "config unreadable" }, 400)
        await Bun.write(cfgPath, JSON.stringify({ ...cfg, model: body.model }, null, 2))
        return c.json({ ok: true, model: body.model })
      },
    )
    // FABULA: the Buddy companion — the SAME identity + per-project state the fabula-buddy plugin uses, so
    // the composer pet matches the awarded companion. userId mirrors the plugin (FABULA_BUDDY_USER || os
    // username); state (xp / statBumps / legendary / hatched name) is read from <dir>/.fabula/buddy/state.json.
    .get(
      "/fabula/buddy",
      describeRoute({
        summary: "Get the FABULA Buddy companion identity + per-project state",
        operationId: "fabula.buddy.get",
        responses: { 200: { description: "Companion" } },
      }),
      async (c) => {
        const dir = c.req.query("dir")
        const envUser = process.env["FABULA_BUDDY_USER"]?.trim()
        const userId = envUser || (() => { try { return nodeOs.userInfo().username } catch { return "" } })() || "anon"
        const state = dir
          ? ((await Bun.file(nodePath.join(dir, ".fabula", "buddy", "state.json")).json().catch(() => null)) as
              | { xp?: number; legendaryEarned?: boolean; statBumps?: Record<string, number>; soul?: { name?: string } }
              | null)
          : null
        return c.json({
          userId,
          xp: typeof state?.xp === "number" && isFinite(state.xp) ? state.xp : 0,
          legendaryEarned: !!state?.legendaryEarned,
          statBumps: state?.statBumps && typeof state.statBumps === "object" && !Array.isArray(state.statBumps) ? state.statBumps : {},
          name: state?.soul?.name && typeof state.soul.name === "string" ? state.soul.name : null,
        })
      },
    )
    // FABULA: usage statistics from local session history (reuses the CLI `stats` aggregator).
    .get(
      "/fabula/usage",
      describeRoute({
        summary: "Get FABULA usage stats",
        operationId: "fabula.usage.get",
        responses: { 200: { description: "Usage stats" } },
      }),
      validator("query", z.object({ days: z.coerce.number().optional() })),
      async (c) => {
        const { days } = c.req.valid("query")
        const imported = await fabulaImportedSessionIds()
        const dirs = fabulaParseDirs(c.req.query("dirs"))
        const { aggregateSessionStats } = await import("@/cli/cmd/stats")
        const stats = await aggregateSessionStats(
          days && days > 0 ? days : undefined,
          undefined,
          (session) =>
            !imported.has(session.id) &&
            fabulaDirMatch(session.directory, dirs) &&
            instanceDirectoryAllowed(session.directory),
        )
        // FABULA: Home-widget extras — daily activity (heatmap), streaks, peak hour, git user name.
        const { Database } = await import("@/storage")
        const { MessageTable, SessionTable, PartTable } = await import("@/session/session.sql")
        const allowedSessions = Database.use((db) =>
          db.select({ id: SessionTable.id, directory: SessionTable.directory }).from(SessionTable).all(),
        )
        const allowed = new Set(
          allowedSessions
            .filter(
              (row) =>
                !imported.has(row.id) && fabulaDirMatch(row.directory, dirs) && instanceDirectoryAllowed(row.directory),
            )
            .map((r) => r.id),
        )
        // The extras must honour the selected range too — "active days: 44" under a 7-day
        // filter was nonsense (they were computed over the whole history).
        const MS_DAY = 24 * 60 * 60 * 1000
        const cutoff = (() => {
          if (!days || days <= 0) return 0
          return Date.now() - days * MS_DAY
        })()
        // FABULA workspace messages, imported/foreign excluded. `allTimes` = full history (drives
        // the always-26-week heatmap so it never shows false zeros); `times` = range-scoped (drives
        // activeDays / streaks / peak hour so a 7d filter reports only the last 7 days).
        const allTimes = Database.use((db) =>
          db.select({ t: MessageTable.time_created, s: MessageTable.session_id }).from(MessageTable).all(),
        ).filter((row) => allowed.has(row.s))
        const times = allTimes.filter((row) => row.t >= cutoff)
        const MS = 24 * 60 * 60 * 1000
        const dayKey = (ms: number) => {
          const d = new Date(ms)
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
        }
        const byDay = new Map<string, number>()
        const byHour = new Array(24).fill(0) as number[]
        for (const row of times) {
          const key = dayKey(row.t)
          byDay.set(key, (byDay.get(key) ?? 0) + 1)
          byHour[new Date(row.t).getHours()]++
        }
        const byDayAll = new Map<string, number>()
        for (const row of allTimes) byDayAll.set(dayKey(row.t), (byDayAll.get(dayKey(row.t)) ?? 0) + 1)
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        let currentStreak = 0
        for (let i = 0; i < 3660; i++) {
          if (byDay.has(dayKey(today.getTime() - i * MS))) {
            currentStreak++
            continue
          }
          if (i === 0) continue // an empty "today" does not break the streak yet
          break
        }
        let longestStreak = 0
        let run = 0
        let prev = 0
        for (const key of [...byDay.keys()].sort()) {
          const t = new Date(`${key}T00:00:00`).getTime()
          run = prev && Math.round((t - prev) / MS) === 1 ? run + 1 : 1
          prev = t
          if (run > longestStreak) longestStreak = run
        }
        const peakHour = byHour.indexOf(Math.max(...byHour))
        const daily: { date: string; count: number }[] = []
        for (let i = 26 * 7 - 1; i >= 0; i--) {
          const key = dayKey(today.getTime() - i * MS)
          daily.push({ date: key, count: byDayAll.get(key) ?? 0 })
        }
        const userName = await (async () => {
          const res = await runGit(Global.Path.home, ["config", "--global", "user.name"])
          return res.code === 0 && res.out ? res.out : undefined
        })()
        // FABULA: Verified-Autonomy telemetry — counted from the actual verify_done tool parts, so the
        // numbers are the checks themselves, not the model's claims. LIKE prefilter keeps the scan cheap,
        // and the per-(days, dirs) TTL cache keeps the unavoidable full-table LIKE scan off the hot path.
        const verified = await (async () => {
          const cacheKey = `${days && days > 0 ? days : 0}|${dirs ? JSON.stringify(dirs) : ""}`
          const hit = fabulaVerifiedCache.get(cacheKey)
          if (hit && Date.now() - hit.at < FABULA_VERIFIED_TTL_MS) return hit.value
          const { like, or } = await import("drizzle-orm")
          const rows = Database.use((db) =>
            db
              .select({ s: PartTable.session_id, t: PartTable.time_created, data: PartTable.data })
              .from(PartTable)
              .where(
                or(
                  like(PartTable.data, '%"tool":"verify_done"%'),
                  like(PartTable.data, '%"tool":"mint_receipt"%'),
                  like(PartTable.data, '%"tool":"escalate_to_cloud"%'),
                  // Receipts auto-minted on a quiz PASS land on the change_quiz part (the receipt
                  // plugin stores a pending green verify and mints when the quiz clears it), so the
                  // change_quiz parts must be in the scan or those real receipts are invisible.
                  like(PartTable.data, '%"tool":"change_quiz"%'),
                ),
              )
              .all(),
          )
          const out: FabulaVerifiedStats = { verifiedRuns: 0, failedVerifies: 0, notDoneVerdicts: 0, autoRewinds: 0, receiptsMinted: 0, secondOpinions: 0 }
          // The receipt plugin sets metadata.receipt to the written file's path — but on an fs
          // failure the path degrades to "(unwritten)", which is a mint attempt, not a receipt.
          const receiptWritten = (meta: Record<string, unknown>) =>
            typeof meta["receipt"] === "string" && meta["receipt"] !== "(unwritten)"
          for (const row of rows) {
            if (!allowed.has(row.s) || row.t < cutoff) continue
            const d = row.data as { type?: string; tool?: string; state?: { status?: string; output?: string; metadata?: Record<string, unknown> } }
            if (d?.type !== "tool" || d?.state?.status !== "completed") continue
            const meta = d.state.metadata ?? {}
            const text = typeof d.state.output === "string" ? d.state.output : ""
            // mint_receipt returns its failures as plain completed strings (empty diff, or fs error
            // → "…→ (unwritten)") — only an output naming a written file is a minted receipt.
            if (d.tool === "mint_receipt") {
              if (text.startsWith("📄 Receipt written → ") && !text.startsWith("📄 Receipt written → (unwritten)")) out.receiptsMinted++
              continue
            }
            // escalate_to_cloud reports "no cloud provider" / "could not reach" as completed strings
            // too — only an actual answer (the SECOND OPINION prefix) is a second opinion.
            if (d.tool === "escalate_to_cloud") {
              if (text.startsWith("💡 SECOND OPINION")) out.secondOpinions++
              continue
            }
            if (d.tool === "change_quiz") {
              // A green verify_done gated on the quiz mints its receipt on the change_quiz part once the
              // quiz PASSes — that deferred mint IS the verified run (the raw verify_done was 'steered',
              // counted nowhere), so credit both here or it undercounts every quiz-gated success.
              if (receiptWritten(meta)) { out.receiptsMinted++; out.verifiedRuns++ }
              continue
            }
            if (d.tool !== "verify_done") continue
            // A written receipt is a fact regardless of how the run itself is classified below.
            if (receiptWritten(meta)) out.receiptsMinted++
            const steered = meta["reproduceGate"] === "steered" || meta["changeQuiz"] === "steered"
            if (meta["passed"] === true && !steered) {
              // A true green check (all gates cleared) — a verified run whether or not the receipt wrote.
              out.verifiedRuns++
            } else if (meta["passed"] === false) {
              // Only a genuinely RED check is a failed verify. A gate-downgraded green (passed:true but
              // steered) is PENDING, not a failure — it becomes a verified run when its receipt mints on
              // the quiz part above; counting it here would both overcount failures and undercount success.
              out.failedVerifies++
            }
            if (meta["notDone"]) out.notDoneVerdicts++
            if (meta["autoRewind"]) out.autoRewinds++
          }
          if (fabulaVerifiedCache.size >= FABULA_VERIFIED_CACHE_MAX) fabulaVerifiedCache.clear()
          fabulaVerifiedCache.set(cacheKey, { at: Date.now(), value: out })
          return out
        })().catch((e) => {
          // Resilient but not silent: the route must still answer, but a vanished `verified` block
          // with no trace is the "silent stop" failure mode the canon forbids.
          log.warn("fabula verified telemetry failed", { error: e })
          return undefined
        })
        return c.json({
          ...stats,
          daily,
          byHour,
          currentStreak,
          longestStreak,
          peakHour,
          activeDays: byDay.size,
          userName,
          verified,
        })
      },
    )
        // FABULA: launch-config provider catalog (the Settings > Providers Edit form reads and
    // writes the MIMOCODE_CONFIG file — /global/config does NOT include launch-file providers).
    .get(
      "/fabula/providers-config",
      describeRoute({
        summary: "Providers from the launch config",
        operationId: "fabula.providersConfig.get",
        responses: { 200: { description: "Providers" } },
      }),
      async (c) => {
        const cfgPath = process.env["MIMOCODE_CONFIG"]
        const cfg = cfgPath
          ? await Bun.file(cfgPath)
              .json()
              .catch(() => ({}))
          : {}
        const providers = (cfg as {
          provider?: Record<
            string,
            { name?: string; npm?: string; options?: { baseURL?: string }; models?: Record<string, { name?: string }> }
          >
        }).provider
        const out: Record<string, { name?: string; npm?: string; baseURL?: string; models: Record<string, { name?: string }> }> = {}
        for (const [id, p] of Object.entries(providers ?? {})) {
          out[id] = { name: p.name, npm: p.npm, baseURL: p.options?.baseURL, models: p.models ?? {} }
        }
        return c.json({ providers: out })
      },
    )
    .post(
      "/fabula/providers-config",
      describeRoute({
        summary: "Update a launch-config provider",
        operationId: "fabula.providersConfig.update",
        responses: { 200: { description: "Update result" } },
      }),
      validator(
        "json",
        z.object({
          providerID: z.string().min(1),
          name: z.string().optional(),
          baseURL: z.string().optional(),
          models: z
            .record(
              z.string(),
              z.object({
                name: z.string().optional(),
                // Model limits must carry BOTH fields or none (engine refuses partial limits).
                limit: z.object({ context: z.number(), output: z.number() }).optional(),
              }),
            )
            .optional(),
          // Merge a single model into the existing map instead of replacing the whole map.
          modelPatch: z
            .object({
              id: z.string().min(1),
              name: z.string().optional(),
              limit: z.object({ context: z.number(), output: z.number() }).optional(),
              remove: z.boolean().optional(),
            })
            .optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const cfgPath = process.env["MIMOCODE_CONFIG"]
        if (!cfgPath) return c.json({ ok: false, error: "no MIMOCODE_CONFIG" }, 400)
        const cfg = (await Bun.file(cfgPath)
          .json()
          .catch(() => undefined)) as
          | { provider?: Record<string, { name?: string; options?: Record<string, unknown>; models?: unknown }> }
          | undefined
        if (!cfg) return c.json({ ok: false, error: "config unreadable" }, 500)
        const prov = cfg.provider?.[body.providerID]
        if (!prov) return c.json({ ok: false, error: "provider not in launch config" }, 404)
        if (body.name !== undefined) prov.name = body.name
        if (body.baseURL !== undefined) prov.options = { ...(prov.options ?? {}), baseURL: body.baseURL }
        if (body.models !== undefined) prov.models = body.models
        if (body.modelPatch) {
          const models = (prov.models ?? {}) as Record<string, { name?: string; limit?: unknown }>
          if (body.modelPatch.remove) {
            delete models[body.modelPatch.id]
          } else {
            const prev = models[body.modelPatch.id] ?? {}
            models[body.modelPatch.id] = {
              ...prev,
              ...(body.modelPatch.name !== undefined ? { name: body.modelPatch.name } : {}),
              ...(body.modelPatch.limit !== undefined ? { limit: body.modelPatch.limit } : {}),
            }
          }
          prov.models = models
        }
        await Bun.write(cfgPath, JSON.stringify(cfg, null, 2))
        return c.json({ ok: true })
      },
    )
    // FABULA: connectivity probe for a configured provider — GET {baseURL}/models with the
        // resolved key, classified for the Settings > Providers "Check" button.
    .post(
      "/fabula/provider-test",
      describeRoute({
        summary: "Test a provider connection",
        operationId: "fabula.provider.test",
        responses: { 200: { description: "Probe result" } },
      }),
      validator("json", z.object({ providerID: z.string().min(1) })),
      async (c) => {
        const body = c.req.valid("json")
        const cfgPath = process.env["MIMOCODE_CONFIG"]
        const cfg = cfgPath
          ? await Bun.file(cfgPath)
              .json()
              .catch(() => ({}))
          : {}
        const prov = ((cfg as { provider?: Record<string, { options?: { baseURL?: string; apiKey?: string } }> })
          .provider ?? {})[body.providerID]
        const baseURL = prov?.options?.baseURL
        if (!baseURL) return c.json({ ok: false, kind: "config", error: "no baseURL in launch config" })
        const resolveKey = async (raw?: string): Promise<string> => {
          if (!raw) return "x"
          const file = raw.match(/^\{file:(.+)\}$/)
          if (file)
            return (
              (
                await Bun.file(file[1].trim())
                  .text()
                  .catch(() => "")
              ).trim() || "x"
            )
          const env = raw.match(/^\{env:(.+)\}$/) || raw.match(/^\$\{?([A-Z0-9_]+)\}?$/)
          if (env) return (process.env[env[1].trim()] || "x").trim()
          return raw
        }
        const apiKey = await resolveKey(prov?.options?.apiKey)
        try {
          const resp = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
            headers: { authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5000),
          })
          if (resp.ok) {
            const data = (await resp.json().catch(() => ({}))) as { data?: unknown[] }
            return c.json({ ok: true, kind: "ok", models: Array.isArray(data.data) ? data.data.length : undefined })
          }
          if (resp.status === 401 || resp.status === 403)
            return c.json({ ok: false, kind: "auth", error: `HTTP ${resp.status}` })
          if (resp.status >= 500) return c.json({ ok: false, kind: "server", error: `HTTP ${resp.status}` })
          return c.json({ ok: false, kind: "http", error: `HTTP ${resp.status}` })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          const kind = /abort|timeout/i.test(msg) ? "timeout" : "network"
          return c.json({ ok: false, kind, error: msg })
        }
      },
    )
    // FABULA: refine a prompt draft with the configured default model (ZCode «prompt enhance»).
    // Uses the model's OpenAI-compatible endpoint from the launch config; non-streaming.
    .post(
      "/fabula/enhance",
      describeRoute({
        summary: "Enhance a prompt draft",
        operationId: "fabula.enhance",
        responses: { 200: { description: "Enhanced prompt" } },
      }),
      validator("json", z.object({ text: z.string().min(1), model: z.string().optional() })),
      async (c) => {
        const body = c.req.valid("json")
        const cfgPath = process.env["MIMOCODE_CONFIG"]
        const cfg = (cfgPath ? await Bun.file(cfgPath).json().catch(() => ({})) : {}) as {
          model?: string
          provider?: Record<string, { options?: { baseURL?: string; apiKey?: string } }>
          // Optional PER-MODEL tuning for the Enhance button, keyed by the SELECTED model ref
          // ("provider/model"), plus a "_default" applied to every model. Each entry may set request
          // params (temperature, max_tokens, reasoning flags …) merged into the /chat/completions body,
          // an optional "timeout_ms", and an optional "model" to run enhance with a DIFFERENT model for
          // that selected model. With no entry, enhance uses EXACTLY the selected model.
          enhance?: Record<string, { model?: string; timeout_ms?: number; [k: string]: unknown }>
        }
        const providers = cfg.provider ?? {}
        // Resolve the config apiKey reference the way the engine does: {file:PATH}, {env:VAR}, ${VAR}, or literal.
        const resolveKey = async (raw?: string): Promise<string> => {
          if (!raw) return "x"
          const file = raw.match(/^\{file:(.+)\}$/)
          if (file) return (await Bun.file(file[1].trim()).text().catch(() => "")).trim() || "x"
          const env = raw.match(/^\{env:(.+)\}$/) || raw.match(/^\$\{?([A-Z0-9_]+)\}?$/)
          if (env) return (process.env[env[1].trim()] || "x").trim()
          return raw
        }
        // Use the SELECTED model — the one the user picked in the composer (`body.model`). Never
        // auto-swap it. The optional per-model `enhance` config can tune params / timeout / (if you
        // choose) redirect enhance to a different model for a given selected model, but the DEFAULT is
        // exactly what's selected. The timeout is generous (45s) so a slow reasoning model (e.g.
        // DeepSeek-V4-Pro ~38s) actually completes instead of failing — that's what made it feel broken.
        const selected = body.model || cfg.model || ""
        if (!selected) return c.json({ ok: false, error: "no model selected" }, 400)
        const tuning = { ...(cfg.enhance?.["_default"] ?? {}), ...(cfg.enhance?.[selected] ?? {}) }
        const { model: modelOverride, timeout_ms, ...extraParams } = tuning
        const ref = (typeof modelOverride === "string" && modelOverride) || selected
        const timeout = typeof timeout_ms === "number" ? timeout_ms : 45000

        const slash = ref.indexOf("/")
        const providerID = slash > 0 ? ref.slice(0, slash) : ref
        const modelID = slash > 0 ? ref.slice(slash + 1) : ref
        const baseURL = providers[providerID]?.options?.baseURL
        if (!baseURL) return c.json({ ok: false, error: `no baseURL for provider "${providerID}"` }, 400)
        const apiKey = await resolveKey(providers[providerID]?.options?.apiKey)

        const system =
          "You rewrite a user's rough coding-assistant prompt to be clearer and more specific, preserving " +
          "their intent and language. Return ONLY the improved prompt text, no preamble, no quotes, no explanation."
        const resp = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: modelID,
            messages: [
              { role: "system", content: system },
              { role: "user", content: body.text },
            ],
            temperature: 0.4,
            stream: false,
            max_tokens: 1024,
            ...extraParams,
          }),
          signal: AbortSignal.timeout(timeout),
        }).catch(() => undefined)
        if (!resp || !resp.ok)
          return c.json(
            { ok: false, error: `model "${ref}" call failed${resp ? ` (HTTP ${resp.status})` : " (timeout or network)"}` },
            502,
          )
        const data = (await resp.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[] }
        const out = (data.choices?.[0]?.message?.content ?? "")
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .replace(/^\s*(?:improved prompt|enhanced prompt|critique|rewrite|prompt)\s*:\s*/i, "")
          .replace(/^["'`]|["'`]$/g, "")
          .trim()
        if (!out) return c.json({ ok: false, error: `model "${ref}" returned only reasoning, no text` }, 502)
        return c.json({ ok: true, text: out, model: ref })
      },
    )
    // FABULA: import an external (.claude-plugin) plugin directory. Delegates to the repo's
    // scripts/import-external-plugin.ts (resolved via the config-dir plugin symlink → repo root).
    .post(
      "/fabula/import-plugin",
      describeRoute({
        summary: "Import an external plugin directory",
        operationId: "fabula.import.plugin",
        responses: { 200: { description: "Import result" } },
      }),
      validator("json", z.object({ dir: z.string().min(1), dryRun: z.boolean().optional() })),
      async (c) => {
        const body = c.req.valid("json")
        // repo root = dirname(realpath(<config>/plugin))
        const pluginLink = nodePath.join(Global.Path.config, "plugin")
        const repoRoot = nodePath.dirname(await nodeFs.promises.realpath(pluginLink).catch(() => pluginLink))
        const script = nodePath.join(repoRoot, "scripts", "import-external-plugin.ts")
        if (!(await Bun.file(script).exists())) return c.json({ ok: false, error: "import script not found" }, 400)
        const args = [script, body.dir]
        if (body.dryRun) args.push("--dry-run")
        const cfg = process.env["MIMOCODE_CONFIG"]
        if (cfg) args.push("--config", cfg)
        const PATH = `${process.env["HOME"]}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:${process.env["PATH"] ?? ""}`
        const proc = Bun.spawn(["bun", ...args], {
          cwd: repoRoot,
          env: { ...process.env, PATH },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        return c.json({ ok: code === 0, code, output: (out + err).slice(-4000) })
      },
    )
        // FABULA: the flat cross-project session list for the sidebar "All chats". Reads the DB
    // directly: the instance-scoped GET /session only covers ONE project, which broke the
    // global list as soon as real (non-global) project ids appeared.
    .get(
      "/fabula/sessions",
      describeRoute({
        summary: "List sessions across all projects",
        operationId: "fabula.sessions.list",
        responses: { 200: { description: "Sessions" } },
      }),
      async (c) => {
        const { Database } = await import("@/storage")
        const { SessionTable } = await import("@/session/session.sql")
        const imported = await fabulaImportedSessionIds()
        const dirs = fabulaParseDirs(c.req.query("dirs"))
        const rows = Database.use((db) =>
          db
            .select({
              id: SessionTable.id,
              parent_id: SessionTable.parent_id,
              directory: SessionTable.directory,
              title: SessionTable.title,
              time_created: SessionTable.time_created,
              time_updated: SessionTable.time_updated,
              time_archived: SessionTable.time_archived,
            })
            .from(SessionTable)
            .all(),
        )
        return c.json(
          rows
            // The engine's background memory sessions are plumbing, not user chats.
            .filter((row) => !(row.title ?? "").startsWith("checkpoint-writer:"))
            .filter((row) => !imported.has(row.id) && fabulaDirMatch(row.directory, dirs))
            // Hide sessions the app can never open (their directory would be denied by the
            // instance middleware — e.g. CLI test runs under /private/tmp): listing them makes
            // the frontend bootstrap the dir and error-toast on every Home load.
            .filter((row) => instanceDirectoryAllowed(row.directory))
            .map((row) => ({
              id: row.id,
              parentID: row.parent_id ?? undefined,
              directory: row.directory,
              title: row.title ?? "",
              time: {
                created: row.time_created,
                updated: row.time_updated,
                archived: row.time_archived ?? undefined,
              },
            })),
        )
      },
    )
        // FABULA: full-text search over message text parts (palette "Chats" scope snippets).
    .get(
      "/fabula/search",
      describeRoute({
        summary: "Full-text search across chat messages",
        operationId: "fabula.search",
        responses: { 200: { description: "Matches with snippets" } },
      }),
      async (c) => {
        const q = (c.req.query("q") ?? "").trim()
        if (q.length < 2) return c.json({ results: [] })
        const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 50)
        const { Database } = await import("@/storage")
        const { sql } = await import("drizzle-orm")
        // LIKE over the JSON text field; escape LIKE wildcards in the needle.
        const needle = `%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`
        const rows = Database.use(
          (db) =>
            db.all(
              sql`SELECT p.session_id AS sessionID, s.directory AS directory, s.title AS title,
                         json_extract(p.data,'$.text') AS text, p.time_created AS created
                  FROM part p JOIN session s ON s.id = p.session_id
                  WHERE json_extract(p.data,'$.type') = 'text'
                    AND s.parent_id IS NULL
                    AND json_extract(p.data,'$.text') LIKE ${needle} ESCAPE '\\'
                  ORDER BY p.time_created DESC
                  LIMIT ${limit * 3}`,
            ) as { sessionID: string; directory: string; title: string; text: string; created: number }[],
        )
        const imported = await fabulaImportedSessionIds()
        const dirs = fabulaParseDirs(c.req.query("dirs"))
        // One snippet per session (freshest match), ±60 chars around the hit.
        const seen = new Set<string>()
        const results: { sessionID: string; directory: string; title: string; snippet: string; created: number }[] = []
        for (const row of rows) {
          if (seen.has(row.sessionID)) continue
          if (imported.has(row.sessionID) || !fabulaDirMatch(row.directory, dirs)) continue
          if (!instanceDirectoryAllowed(row.directory)) continue
          const text = row.text ?? ""
          const at = text.toLowerCase().indexOf(q.toLowerCase())
          const from = Math.max(0, at - 60)
          const snippet =
            (from > 0 ? "…" : "") +
            text.slice(from, at + q.length + 60).replace(/\s+/g, " ") +
            (at + q.length + 60 < text.length ? "…" : "")
          seen.add(row.sessionID)
          results.push({ sessionID: row.sessionID, directory: row.directory, title: row.title ?? "", snippet, created: row.created })
          if (results.length >= limit) break
        }
        return c.json({ results })
      },
    )
        // FABULA: file-based registries for Settings > Skills / Subagents / Commands.
    .get(
      "/fabula/registry",
      describeRoute({
        summary: "List a fabula registry (skills/agents/commands)",
        operationId: "fabula.registry.list",
        responses: { 200: { description: "Registry items" } },
      }),
      async (c) => {
        const kind = c.req.query("kind") as RegistryKind
        if (kind !== "skills" && kind !== "agents" && kind !== "commands")
          return c.json({ root: "", items: [], builtins: [] })
        const scope = c.req.query("scope")
        const dir = c.req.query("dir")
        const root = registryRoot(kind, scope, dir)
        // Builtins are a global concept; project scope lists only the project's own files.
        const builtins = scope === "project" ? [] : REGISTRY_BUILTINS[kind]
        return c.json({ root, items: await listRegistry(kind, root), builtins })
      },
    )
    .post(
      "/fabula/registry",
      describeRoute({
        summary: "Create/update/delete a fabula registry item",
        operationId: "fabula.registry.write",
        responses: { 200: { description: "Write result" } },
      }),
      validator(
        "json",
        z.object({
          kind: z.enum(["skills", "agents", "commands"]),
          action: z.enum(["create", "update", "delete", "toggle"]),
          name: z.string().optional(),
          location: z.string().optional(),
          content: z.string().optional(),
          enabled: z.boolean().optional(),
          scope: z.enum(["global", "project"]).optional(),
          dir: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const root = nodePath.resolve(registryRoot(body.kind, body.scope, body.dir))
        if (body.action === "create") {
          const name = (body.name ?? "").replace(/[\\/:*?"<>|]/g, "").trim()
          if (!name) return c.json({ ok: false, error: "name required" }, 400)
          const target =
            body.kind === "skills" ? nodePath.join(root, name, "SKILL.md") : nodePath.join(root, `${name}.md`)
          if (await Bun.file(target).exists()) return c.json({ ok: false, error: "already exists" }, 400)
          await nodeFs.promises.mkdir(nodePath.dirname(target), { recursive: true })
          const content = body.content?.trim() ? body.content : registryTemplate(body.kind, name)
          await Bun.write(target, content)
          return c.json({ ok: true, file: target })
        }
        // update/delete/toggle address an existing file; refuse anything outside the registry root.
        const location = nodePath.resolve(body.location ?? "")
        if (!location.startsWith(root + nodePath.sep)) return c.json({ ok: false, error: "outside registry root" }, 400)
        if (body.action === "update") {
          if (typeof body.content !== "string" || !body.content.trim())
            return c.json({ ok: false, error: "content required" }, 400)
          await Bun.write(location, body.content)
          return c.json({ ok: true })
        }
        if (body.action === "toggle") {
          // The rename is the switch: `.md` ↔ `.md.disabled` (skills toggle their SKILL.md).
          const on = location.endsWith(".md")
          if (!on && !location.endsWith(".md.disabled")) return c.json({ ok: false, error: "not a registry file" }, 400)
          const next = on ? `${location}.disabled` : location.replace(/\.disabled$/, "")
          // Already in the requested state → no-op (idempotent toggle).
          if (typeof body.enabled === "boolean" && body.enabled === on) return c.json({ ok: true, file: location })
          await nodeFs.promises.rename(location, next)
          return c.json({ ok: true, file: next })
        }
        const target = body.kind === "skills" ? nodePath.dirname(location) : location
        await nodeFs.promises.rm(target, { recursive: true, force: true })
        return c.json({ ok: true })
      },
    )
    // FABULA: git operations for the Review panel (branch / commit with AI message / push).
    .get(
      "/fabula/git/state",
      describeRoute({
        summary: "Git state for a directory",
        operationId: "fabula.git.state",
        responses: { 200: { description: "Git state" } },
      }),
      async (c) => {
        const dir = c.req.query("dir") ?? ""
        if (!dir) return c.json({ ok: false })
        const head = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => undefined)
        if (!head || head.code !== 0) return c.json({ ok: false })
        const [status, branches, counts, user] = await Promise.all([
          runGit(dir, ["status", "--porcelain"]),
          runGit(dir, ["branch", "--format=%(refname:short)"]),
          runGit(dir, ["rev-list", "--count", "--left-right", "@{upstream}...HEAD"]),
          runGit(dir, ["config", "user.name"]),
        ])
        const [behind, ahead] = counts.code === 0 ? counts.out.split(/\s+/).map((n) => Number(n) || 0) : [0, 0]
        // Porcelain XY per file: staged (X set), unstaged (Y set), untracked (??).
        // Parse the RAW output — the X column of the first line is a significant space.
        const files = status.raw
          .split("\n")
          .filter((line) => line.length > 3)
          .map((line) => {
          const x = line[0] ?? " "
          const y = line[1] ?? " "
          const path = line.slice(3).replace(/^"|"$/g, "")
          return {
            path,
            staged: x !== " " && x !== "?",
            unstaged: y !== " " && y !== "?",
            untracked: x === "?" && y === "?",
          }
        })
        return c.json({
          ok: true,
          branch: head.out,
          changes: files.length,
          files,
          branches: branches.out ? branches.out.split("\n") : [],
          ahead,
          behind,
          hasUpstream: counts.code === 0,
          user: user.code === 0 && user.out ? user.out : undefined,
        })
      },
    )
    .post(
      "/fabula/git/commit",
      describeRoute({
        summary: "Stage all and commit (AI message when none given)",
        operationId: "fabula.git.commit",
        responses: { 200: { description: "Commit result" } },
      }),
      validator("json", z.object({ dir: z.string().min(1), message: z.string().optional() })),
      async (c) => {
        const body = c.req.valid("json")
        const add = await runGit(body.dir, ["add", "-A"])
        if (add.code !== 0) return c.json({ ok: false, error: add.err || add.out })
        const files = await runGit(body.dir, ["diff", "--cached", "--name-status"])
        if (!files.out) return c.json({ ok: false, error: "no changes" })
        let message = body.message?.trim()
        if (!message) {
          const stat = await runGit(body.dir, ["diff", "--cached", "--stat"])
          const generated = await fabulaModelCall(
            "You write a git commit message: one imperative summary line (max 72 chars), optionally a short body. " +
              "Write it in the language of the change content (Russian is fine). Return ONLY the message.",
            `Changed files:\n${files.out}\n\nDiffstat:\n${stat.out}`.slice(0, 6000),
          )
          message =
            generated.ok && generated.text
              ? generated.text.split("\n").slice(0, 6).join("\n").trim()
              : `Update ${files.out.split("\n").length} file(s)`
        }
        const commit = await runGit(body.dir, ["commit", "-m", message])
        if (commit.code !== 0) return c.json({ ok: false, error: (commit.err || commit.out).slice(-2000) })
        return c.json({ ok: true, message })
      },
    )
    .post(
      "/fabula/git/stage",
      describeRoute({
        summary: "Stage or unstage specific files",
        operationId: "fabula.git.stage",
        responses: { 200: { description: "Stage result" } },
      }),
      validator(
        "json",
        z.object({ dir: z.string().min(1), files: z.array(z.string().min(1)).min(1), stage: z.boolean() }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const args = body.stage ? ["add", "--", ...body.files] : ["restore", "--staged", "--", ...body.files]
        const res = await runGit(body.dir, args)
        return c.json({ ok: res.code === 0, error: res.code === 0 ? undefined : (res.err || res.out).slice(-2000) })
      },
    )
    .post(
      "/fabula/git/discard",
      describeRoute({
        summary: "Discard working-tree changes for specific files (destructive)",
        operationId: "fabula.git.discard",
        responses: { 200: { description: "Discard result" } },
      }),
      validator(
        "json",
        z.object({
          dir: z.string().min(1),
          files: z.array(z.string().min(1)).optional(),
          untracked: z.array(z.string().min(1)).optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const errors: string[] = []
        if (body.files?.length) {
          const res = await runGit(body.dir, ["restore", "--staged", "--worktree", "--", ...body.files])
          if (res.code !== 0) errors.push(res.err || res.out)
        }
        if (body.untracked?.length) {
          // Untracked files have nothing to restore — remove them (scoped to the given paths only).
          const res = await runGit(body.dir, ["clean", "-f", "--", ...body.untracked])
          if (res.code !== 0) errors.push(res.err || res.out)
        }
        return c.json({ ok: errors.length === 0, error: errors.join("\n").slice(-2000) || undefined })
      },
    )
    .post(
      "/fabula/git/push",
      describeRoute({
        summary: "Push the current branch (sets upstream when missing)",
        operationId: "fabula.git.push",
        responses: { 200: { description: "Push result" } },
      }),
      validator("json", z.object({ dir: z.string().min(1) })),
      async (c) => {
        const body = c.req.valid("json")
        let push = await runGit(body.dir, ["push"])
        if (push.code !== 0 && /set-upstream|no upstream/i.test(push.err)) {
          const branch = (await runGit(body.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).out
          push = await runGit(body.dir, ["push", "-u", "origin", branch])
        }
        return c.json({ ok: push.code === 0, output: `${push.out}\n${push.err}`.trim().slice(-2000) })
      },
    )
    .post(
      "/fabula/git/switch",
      describeRoute({
        summary: "Switch (or create) a branch",
        operationId: "fabula.git.switch",
        responses: { 200: { description: "Switch result" } },
      }),
      validator(
        "json",
        z.object({ dir: z.string().min(1), branch: z.string().min(1), create: z.boolean().optional() }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const args = body.create ? ["switch", "-c", body.branch] : ["switch", body.branch]
        const res = await runGit(body.dir, args)
        return c.json({ ok: res.code === 0, output: `${res.out}\n${res.err}`.trim().slice(-2000) })
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose all engine instances, releasing all resources.",
        operationId: "global.dispose",
        responses: {
          200: {
            description: "Global disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.disposeAll()
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: GlobalDisposedEvent.type,
            properties: {},
          },
        })
        return c.json(true)
      },
    )
    .post(
      "/upgrade",
      describeRoute({
        summary: "Upgrade the engine",
        description: "Upgrade the engine to the specified version or latest if not specified.",
        operationId: "global.upgrade",
        responses: {
          200: {
            description: "Upgrade result",
            content: {
              "application/json": {
                schema: resolver(
                  z.union([
                    z.object({
                      success: z.literal(true),
                      version: z.string(),
                    }),
                    z.object({
                      success: z.literal(false),
                      error: z.string(),
                    }),
                  ]),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          target: z.string().optional(),
        }),
      ),
      async (c) => {
        // FABULA: this build is source-managed; pulling upstream release binaries would
        // overwrite the fork. The endpoint stays for API compatibility but always declines.
        return c.json({ success: false, error: "Upgrade is disabled in FABULA (source-managed build)" }, 400)
      },
    )
    .get(
      "/import/scan",
      describeRoute({
        summary: "Scan external session sources",
        description:
          "Detect availability and session counts of external AI tool session stores (Claude Code, Codex, opencode). Read-only.",
        operationId: "global.import.scan",
        responses: {
          200: {
            description: "Per-source availability and counts",
            content: {
              "application/json": {
                schema: resolver(
                  z.record(
                    z.enum(["cc", "codex", "opencode"]),
                    z.object({ available: z.boolean(), sessions: z.number(), imported: z.number() }),
                  ),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await ExternalImport.scan())
      },
    )
    .post(
      "/import/run",
      describeRoute({
        summary: "Import external sessions",
        description:
          "Import sessions from external AI tools (Claude Code, Codex, opencode) into mimocode. Idempotent; pass force to re-sync. Per-source failures are not thrown as HTTP errors — they are collected into the corresponding stats.errors[] while other sources continue.",
        operationId: "global.import.run",
        responses: {
          200: {
            description: "Per-source import stats",
            content: {
              "application/json": {
                schema: resolver(
                  z.record(
                    z.enum(["cc", "codex", "opencode"]),
                    z.object({
                      scanned: z.number(),
                      imported: z.number(),
                      resynced: z.number(),
                      skipped: z.number(),
                      errors: z.array(z.string()),
                    }),
                  ),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          sources: z.array(z.enum(["cc", "codex", "opencode"])).optional(),
          force: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const { sources, force } = c.req.valid("json")
        return c.json(await ExternalImport.runAll({ sources, force }))
      },
    ),
)
