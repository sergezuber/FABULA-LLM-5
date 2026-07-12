// Wiring tests for fabula-toolrouter.ts — the chat.message router hook end-to-end (real hook
// invocation, real route(), real channel map; no mocks of our own logic).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { FabulaToolRouter } from "../fabula-toolrouter"
import { decideBelt, taskTextFrom } from "../lib/beltwire"

const CHANNEL_KEY = "__FABULA_SESSION_BELT__"
const channel = () => (globalThis as any)[CHANNEL_KEY] as Map<string, any> | undefined

const SID = "ses_router_wiring"

// the plugin is defaultEnabled:false in the manifest — enable it for the wiring test the same
// way the other default-off plugins do (hermetic FABULA_PLUGIN_STATE override)
const stateDir = mkdtempSync(path.join(tmpdir(), "fab-router-"))
const stateFile = path.join(stateDir, "pstate.json")
writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["tool-router"] }))
const savedState = process.env.FABULA_PLUGIN_STATE

beforeEach(() => {
  process.env.FABULA_PLUGIN_STATE = stateFile
  process.env.FABULA_TOOL_ROUTER = "1"
  channel()?.delete(SID)
})
afterEach(() => {
  if (savedState === undefined) delete process.env.FABULA_PLUGIN_STATE
  else process.env.FABULA_PLUGIN_STATE = savedState
  delete process.env.FABULA_TOOL_ROUTER
  channel()?.delete(SID)
})

function msg(text: string, synthetic = false) {
  return { message: {}, parts: [{ type: "text", text, synthetic }] }
}

describe("taskTextFrom", () => {
  test("joins non-synthetic text parts only", () => {
    expect(
      taskTextFrom([
        { type: "text", text: "a", synthetic: false },
        { type: "text", text: "steer", synthetic: true },
        { type: "file", text: "x" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb")
    expect(taskTextFrom(undefined)).toBe("")
    expect(taskTextFrom([])).toBe("")
  })
})

describe("decideBelt — pure routing to the closed registry", () => {
  test("coding task → coding profile with the non-coding hide set", () => {
    const { entry } = decideBelt("почини баг в prompt.ts и прогони тесты через bash")
    expect(entry.profileId).toBe("coding")
    expect(entry.hide).toContain("weather_fetch")
    expect(entry.hide).not.toContain("verify_done") // gate floor
  })
  test("ambiguous task falls back to full (never block)", () => {
    const { entry, reason } = decideBelt("сделай красиво")
    expect(entry.profileId).toBe("full")
    expect(reason).toBe("fallback-widest")
    expect(entry.hide).toEqual([])
  })
  test("verbatim pin survives the profile hide (weather_fetch mentioned → not hidden)", () => {
    const { entry } = decideBelt("запусти weather_fetch для Москвы и вставь результат в код")
    expect(entry.hide).not.toContain("weather_fetch")
  })
})

describe("chat.message hook wiring", () => {
  test("stamps a per-session entry; same profile re-route is a no-op; off-flag is inert", async () => {
    const plugin: any = await FabulaToolRouter()
    expect(typeof plugin["chat.message"]).toBe("function")

    // 1) real user message → entry stamped for THIS session only
    await plugin["chat.message"]({ sessionID: SID, agent: "main", messageID: "m1" }, msg("почини баг и прогони тесты"))
    const e1 = channel()!.get(SID)
    expect(e1?.profileId).toBe("coding")
    expect(e1?.watermark).toBe("m1")

    // 2) same-profile task → no-op (watermark unchanged → prefix bytes unchanged)
    await plugin["chat.message"]({ sessionID: SID, agent: "main", messageID: "m2" }, msg("поправь ещё один файл"))
    expect(channel()!.get(SID)?.watermark).toBe("m1")

    // 3) synthetic-only parts (goal/verify steer) never re-route
    await plugin["chat.message"]({ sessionID: SID, agent: "main", messageID: "m3" }, msg("steer", true))
    expect(channel()!.get(SID)?.watermark).toBe("m1")

    // 4) flag off → hook inert
    delete process.env.FABULA_TOOL_ROUTER
    channel()!.delete(SID)
    await plugin["chat.message"]({ sessionID: SID, agent: "main", messageID: "m4" }, msg("почини баг"))
    expect(channel()!.get(SID)).toBeUndefined()
  })

  test("subagent-scoped messages don't re-route the root", async () => {
    const plugin: any = await FabulaToolRouter()
    await plugin["chat.message"]({ sessionID: SID, agent: "main", messageID: "m1" }, msg("почини баг в коде"))
    const before = channel()!.get(SID)?.profileId
    await plugin["chat.message"]({ sessionID: SID, agent: "explore", messageID: "m2" }, msg("поищи в интернете погоду"))
    expect(channel()!.get(SID)?.profileId).toBe(before)
  })

  test("hook never throws on malformed payloads", async () => {
    const plugin: any = await FabulaToolRouter()
    await plugin["chat.message"](undefined, undefined)
    await plugin["chat.message"]({}, { parts: "not-an-array" })
    // no entry, no crash
    expect(channel()?.get(SID as any)).toBeUndefined()
  })
})

describe("resident catalog (§4.5 — mandatory for attempt-dispatch)", () => {
  test("catalogBlock lists hidden names sorted; empty entry → empty string", async () => {
    const { catalogBlock } = await import("../lib/beltwire")
    expect(catalogBlock(undefined)).toBe("")
    expect(catalogBlock({ profileId: "full", hide: [], hideGlobs: [] })).toBe("")
    const s = catalogBlock({ profileId: "coding", hide: ["weather_fetch", "image_search"], hideGlobs: ["srv_*"] })
    expect(s).toContain("[FABULA TOOL CATALOG")
    expect(s).toContain("- image_search")
    expect(s.indexOf("- image_search")).toBeLessThan(s.indexOf("- weather_fetch")) // sorted
    expect(s).toContain("srv (server: all its tools)")
  })
  test("byte-stable: same entry → identical bytes (cache-safe within a segment)", async () => {
    const { catalogBlock } = await import("../lib/beltwire")
    const e = { profileId: "coding", hide: ["b", "a"], hideGlobs: [] }
    expect(catalogBlock(e)).toBe(catalogBlock({ ...e, hide: ["a", "b"] }))
  })
  test("fabula-context system.transform appends the catalog for the session's belt", async () => {
    const { beltChannel } = await import("../lib/beltwire")
    const { FabulaContext } = await import("../fabula-context")
    beltChannel().set("ses_cat", { profileId: "coding", hide: ["weather_fetch"], hideGlobs: [] })
    try {
      const plugin: any = await (FabulaContext as any)({ directory: process.cwd() })
      const output: any = { system: ["base"] }
      await plugin["experimental.chat.system.transform"]({ sessionID: "ses_cat" }, output)
      const merged = output.system.join("\n\n")
      expect(merged).toContain("[FABULA TOOL CATALOG")
      expect(merged).toContain("- weather_fetch")
      expect(output.system.length).toBe(1) // collapse invariant intact
    } finally {
      beltChannel().delete("ses_cat")
    }
  })
})

describe("expand_tools — the escape-hatch dispatcher (§4.4)", () => {
  const SHADOW_KEY = "__FABULA_SESSION_SHADOW__"
  const shadowCh = () => {
    const g = globalThis as any
    if (!(g[SHADOW_KEY] instanceof Map)) g[SHADOW_KEY] = new Map()
    return g[SHADOW_KEY] as Map<string, Map<string, any>>
  }
  const SID2 = "ses_expand_test"
  afterEach(() => shadowCh().delete(SID2))

  async function getTool() {
    const plugin: any = await FabulaToolRouter()
    expect(plugin.tool?.expand_tools).toBeDefined()
    return plugin.tool.expand_tools
  }

  test("executes a hidden tool through its real shadow executor", async () => {
    const calls: any[] = []
    shadowCh().set(SID2, new Map([["weather_fetch", {
      description: "weather",
      inputSchema: { jsonSchema: { type: "object", properties: { place: { type: "string" } } } },
      execute: async (args: any) => (calls.push(args), { output: "sunny +25" }),
    }]]))
    const t = await getTool()
    const out = await t.execute({ tool: "weather_fetch", args: { place: "Moscow" } }, { sessionID: SID2, callID: "c1" })
    expect(out).toBe("sunny +25")
    expect(calls).toEqual([{ place: "Moscow" }])
  })

  test("schema mode: args omitted → returns the tool's JSON schema + how to execute", async () => {
    shadowCh().set(SID2, new Map([["weather_fetch", {
      description: "Get the weather",
      inputSchema: { jsonSchema: { type: "object", properties: { place: { type: "string" } } } },
      execute: async () => "never",
    }]]))
    const t = await getTool()
    const out = await t.execute({ tool: "weather_fetch" }, { sessionID: SID2 })
    expect(out).toContain("Schema for hidden tool")
    expect(out).toContain('"place"')
    expect(out).toContain("execute it")
  })

  test("unknown name → helpful message listing the session's hidden set", async () => {
    shadowCh().set(SID2, new Map([["weather_fetch", { execute: async () => "x" }]]))
    const t = await getTool()
    const out = await t.execute({ tool: "nonexistent_tool" }, { sessionID: SID2 })
    expect(out).toContain("not in this session's hidden set")
    expect(out).toContain("weather_fetch")
  })

  test("no hidden tools at all → clear message", async () => {
    const t = await getTool()
    const out = await t.execute({ tool: "whatever" }, { sessionID: SID2 })
    expect(out).toContain("No tools are hidden")
  })
})
