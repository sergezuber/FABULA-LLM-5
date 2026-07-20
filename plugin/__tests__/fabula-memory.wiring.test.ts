// Wiring guard for fabula-memory — the plugin, not the libraries under it.
//
// This file exists because an independent verifier broke the wiring FOUR ways in a sandbox and every one
// of them passed the tracked library tests, the full plugin suite, and both halves of the frozen
// acceptance suite. The pure cores are well covered; the two lines that CONNECT them to a real turn were
// covered by nothing at all. The libraries can be perfect and the plugin can still deliver nothing.
//
// The four mutations, and what each does if nobody is watching:
//   1. drop the `anchorFor` call        — and it is WORSE than having no anchor code at all: an
//                                         anchorless record is marked "not about code", so it is served
//                                         unconditionally, forever, with no freshness check ever applied.
//   2. always set `claimsCode: false`   — every record served, the whole anchor mechanism bypassed.
//   3. drop the `admitMemory` call      — the gate returns to declared-but-not-wired.
//   4. pass `helped` instead of `verified` — the gate runs, journals, and is structurally incapable of
//                                         admitting anything, while looking entirely alive.
//
// So the assertions below are deliberately about OBSERVABLE CONSEQUENCES on a real turn — what reaches
// the model, what stops reaching it, and what the gate wrote down — not about which functions were called.
import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const REPO = path.join(import.meta.dir, "..", "..")
let ws: string
let data: string
let savedXdg: string | undefined
let savedStore: string | undefined
let savedState: string | undefined
let savedPromote: string | undefined

const SRC = "src/lexer.ts"
const BODY = `export function tokenize(input: string) {
  return input.split(" ")
}

export function unrelated() {
  return "untouched"
}
`

beforeEach(() => {
  ws = mkdtempSync(path.join(os.tmpdir(), "memwire-ws-"))
  data = mkdtempSync(path.join(os.tmpdir(), "memwire-data-"))
  savedXdg = process.env.XDG_DATA_HOME
  savedStore = process.env.FABULA_MEM_STORE
  process.env.XDG_DATA_HOME = data
  delete process.env.FABULA_MEM_STORE
  savedPromote = process.env.FABULA_MEM_PROMOTE
  delete process.env.FABULA_MEM_PROMOTE
  // The plugin ships OFF (an unproven wave should not arrive enabled), so a test that wants to exercise
  // it has to say so. Worth stating rather than hiding in a fixture: this file failed 9/9 the first time
  // it ran, because the factory correctly returned no hooks at all — which is also the shape every one of
  // these assertions would take on a machine where the owner has the plugin disabled.
  savedState = process.env.FABULA_PLUGIN_STATE
  const stateFile = path.join(data, "fabula-state.json")
  writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["memory"] }))
  process.env.FABULA_PLUGIN_STATE = stateFile
  mkdirSync(path.join(ws, "src"), { recursive: true })
  writeFileSync(path.join(ws, SRC), BODY)
})
afterEach(() => {
  savedXdg === undefined ? delete process.env.XDG_DATA_HOME : (process.env.XDG_DATA_HOME = savedXdg)
  savedStore === undefined ? delete process.env.FABULA_MEM_STORE : (process.env.FABULA_MEM_STORE = savedStore)
  savedState === undefined ? delete process.env.FABULA_PLUGIN_STATE : (process.env.FABULA_PLUGIN_STATE = savedState)
  // Deleted in beforeEach without saving, this leaked a cleared switch into every later test in the
  // same process — a test that quietly changes the environment for its neighbours.
  savedPromote === undefined ? delete process.env.FABULA_MEM_PROMOTE : (process.env.FABULA_MEM_PROMOTE = savedPromote)
  for (const d of [ws, data]) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
})

/** Drive the REAL plugin factory and its REAL hooks: an edit, then a verify, then a system build. */
async function turn(opts: { green?: boolean; session?: string } = {}) {
  const { FabulaMemory } = await import(path.join(REPO, "plugin/fabula-memory.ts"))
  const h: any = await FabulaMemory({ directory: ws, sessionID: opts.session ?? "w1" })
  await h["tool.execute.after"]({ tool: "str_replace", sessionID: opts.session ?? "w1", args: { path: path.join(ws, SRC) } }, {})
  await h["tool.execute.after"](
    { tool: "verify_done", sessionID: opts.session ?? "w1" },
    { title: "suite green", metadata: { passed: opts.green ?? true } },
  )
  return h
}

async function systemText(h: any, session = "w1"): Promise<string> {
  const out: any = { system: [] }
  await h["experimental.chat.system.transform"]({ sessionID: session }, out)
  return out.system.join("\n")
}

const journal = () => {
  const p = path.join(data, "fabula", "memstore", "promotion_decisions.jsonl")
  return existsSync(p) ? readFileSync(p, "utf8") : ""
}

test("a verified turn produces memory that actually REACHES the model", async () => {
  const h = await turn()
  const sys = await systemText(h)
  expect(sys.length).toBeGreaterThan(0)
  expect(sys).toContain("GREEN")
})

test("when the anchored code changes, that memory STOPS reaching the model", async () => {
  // Mutation 1 and 2 both survive without this: an unanchored or always-exempt record keeps being served
  // after the code it describes has moved on, which is the precise failure the anchor exists to prevent.
  const h = await turn()
  expect((await systemText(h)).length).toBeGreaterThan(0)
  writeFileSync(path.join(ws, SRC), BODY.replace('input.split(" ")', "input.split(/\\s+/)"))
  expect(await systemText(h)).toBe("")
})

test("the record written on a real turn CARRIES an anchor", async () => {
  await turn()
  const raw = readFileSync(path.join(data, "fabula", "memstore", "raw.jsonl"), "utf8")
  const rec = raw.trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.kind === "episode")
  expect(rec).toBeTruthy()
  expect(rec.anchor).toBeTruthy()
  expect(String(rec.anchor.path)).toContain("lexer.ts")
  // …and it does NOT take the no-code-claim exemption, which would make the anchor decorative
  expect(rec.claimsCode).not.toBe(false)
})

test("the admission gate RUNS on the real path and records a decision", async () => {
  // Mutation 3: no gate call at all — the journal simply never appears.
  await turn()
  expect(journal().length).toBeGreaterThan(0)
})

test("the gate is given the outcome key it actually reads", async () => {
  // Mutation 4: passing a key the gate does not read leaves it running, journalling, and structurally
  // incapable of ever admitting anything — a disconnected gate wearing a verdict.
  await turn({ green: true })
  const last = journal().trim().split("\n").pop()!
  const d = JSON.parse(last)
  expect(d.decision).toBe("admit")
  expect(d.basis).toBe("verified-outcome")
})

test("a RED turn is recorded but never admitted", async () => {
  await turn({ green: false, session: "w2" })
  const d = JSON.parse(journal().trim().split("\n").pop()!)
  expect(d.decision).toBe("refuse")
})

test("promotion is OFF by default and the journal says so", async () => {
  await turn()
  const d = JSON.parse(journal().trim().split("\n").pop()!)
  expect(d.shadow).toBe(true)
  const raw = readFileSync(path.join(data, "fabula", "memstore", "raw.jsonl"), "utf8")
  expect(raw).not.toContain('"kind":"promoted"')
})

test("a turn that edited nothing declares it makes no claim about code", async () => {
  const { FabulaMemory } = await import(path.join(REPO, "plugin/fabula-memory.ts"))
  const h: any = await FabulaMemory({ directory: ws, sessionID: "w3" })
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: "w3" }, { title: "nothing to do", metadata: { passed: true } })
  const raw = readFileSync(path.join(data, "fabula", "memstore", "raw.jsonl"), "utf8")
  const rec = raw.trim().split("\n").map((l) => JSON.parse(l)).pop()
  expect(rec.claimsCode).toBe(false)
  expect(rec.anchor).toBeUndefined()
})

test("the plugin never throws a turn down, whatever the store does", async () => {
  // Memory is an advantage, never a dependency: a store that cannot be read is a turn without memory,
  // which is survivable; an exception here would not be.
  process.env.FABULA_MEM_STORE = "/proc/definitely-not-writable/nope"
  const { FabulaMemory } = await import(path.join(REPO, "plugin/fabula-memory.ts"))
  const h: any = await FabulaMemory({ directory: ws, sessionID: "w4" })
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: "w4" }, { title: "x", metadata: { passed: true } })
  const out: any = { system: [] }
  await h["experimental.chat.system.transform"]({ sessionID: "w4" }, out)
  expect(Array.isArray(out.system)).toBe(true)
})

// ── the narrowing games ────────────────────────────────────────────────────────────────────────────
//
// The three cases above catch a REMOVED call. They do not catch a NARROWED one, and narrowing is the
// easier mistake: shrink the edit-tool list, shrink the source-extension list, or require an absolute
// path, and edits stop being recognised. Nothing goes red, because an unrecognised edit produces an
// unanchored record — which then takes the `claimsCode: false` exemption and is served FOREVER with no
// freshness check. That is fail-OPEN: the narrowing does not lose memory, it converts checkable memory
// into unfalsifiable memory. Each assertion below is one of those doors.

test("an edit made with create_file anchors, not only str_replace", async () => {
  const { FabulaMemory } = await import(path.join(REPO, "plugin/fabula-memory.ts"))
  const h: any = await FabulaMemory({ directory: ws, sessionID: "n1" })
  await h["tool.execute.after"]({ tool: "create_file", sessionID: "n1", args: { path: path.join(ws, SRC) } }, {})
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: "n1" }, { title: "ok", metadata: { passed: true } })
  const raw = readFileSync(path.join(data, "fabula", "memstore", "raw.jsonl"), "utf8")
  const rec = raw.trim().split("\n").map((l) => JSON.parse(l)).pop()
  expect(rec.anchor).toBeTruthy()
  expect(rec.claimsCode).not.toBe(false)
})

test("a non-TypeScript source edit anchors", async () => {
  // A `.py` or `.go` memory losing its anchor is the same fail-open door with a different key.
  writeFileSync(path.join(ws, "src", "tool.py"), "def run():\n    return 1\n")
  const { FabulaMemory } = await import(path.join(REPO, "plugin/fabula-memory.ts"))
  const h: any = await FabulaMemory({ directory: ws, sessionID: "n2" })
  await h["tool.execute.after"]({ tool: "str_replace", sessionID: "n2", args: { path: path.join(ws, "src", "tool.py") } }, {})
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: "n2" }, { title: "ok", metadata: { passed: true } })
  const raw = readFileSync(path.join(data, "fabula", "memstore", "raw.jsonl"), "utf8")
  const rec = raw.trim().split("\n").map((l) => JSON.parse(l)).pop()
  expect(String(rec.anchor?.path ?? "")).toContain("tool.py")
})

test("a RELATIVE edit path anchors — the harness does not always hand over an absolute one", async () => {
  const { FabulaMemory } = await import(path.join(REPO, "plugin/fabula-memory.ts"))
  const h: any = await FabulaMemory({ directory: ws, sessionID: "n3" })
  await h["tool.execute.after"]({ tool: "str_replace", sessionID: "n3", args: { path: SRC } }, {})
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: "n3" }, { title: "ok", metadata: { passed: true } })
  const raw = readFileSync(path.join(data, "fabula", "memstore", "raw.jsonl"), "utf8")
  const rec = raw.trim().split("\n").map((l) => JSON.parse(l)).pop()
  expect(rec.anchor).toBeTruthy()
})

test("the worth counters MOVE on a real turn", async () => {
  // M6's only wiring guard used to be a hidden case asserting that SOME file under the data dir changed
  // — which `appendRaw` alone now satisfies, so that case went vacuous for this property while staying
  // green. Assert the counter file itself.
  await turn({ session: "n4" })
  const worth = path.join(data, "fabula", "memstore", "worth.json")
  expect(existsSync(worth)).toBe(true)
  const parsed = JSON.parse(readFileSync(worth, "utf8"))
  const entries = Object.values(parsed?.entries ?? parsed ?? {})
  expect(entries.length).toBeGreaterThan(0)
})

// ── attribution, not movement ──────────────────────────────────────────────────────────────────────
//
// The counter assertion above rotted the moment it was written: it checks that worth.json MOVED, and the
// freshly-created episode's own counter satisfies that. So an implementation that credits only the new
// episode and never the memories it actually SERVED passes — while measuring nothing about whether a
// served memory helped, which is the entire point of M6. Movement without attribution is what this
// plugin's own comment calls a number nobody can trust.
//
// The fix is to serve a memory into a turn and assert THAT id's counter moved, which also closes the
// mirror door: crediting memories served in OTHER sessions, where co-occurrence stops meaning anything.

async function worthEntries(): Promise<Record<string, any>> {
  const p = path.join(data, "fabula", "memstore", "worth.json")
  if (!existsSync(p)) return {}
  const parsed = JSON.parse(readFileSync(p, "utf8"))
  return (parsed?.entries ?? parsed ?? {}) as Record<string, any>
}

test("the outcome is credited to the memory that was SERVED, not only to the new episode", async () => {
  // turn 1 writes an anchored memory; turn 2 serves it and then verifies.
  const h = await turn({ session: "a1" })
  const served = await systemText(h, "a1")
  expect(served.length).toBeGreaterThan(0)
  const raw = readFileSync(path.join(data, "fabula", "memstore", "raw.jsonl"), "utf8")
  const first = raw.trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.kind === "episode")!
  // PRESENCE is not attribution. The first episode is already in worth.json — it was credited as its own
  // turn's episode — so asserting it appears there passes even when serving credits nothing. The claim
  // that actually distinguishes the two is that its counter went UP because it was SERVED into a later
  // verified turn. Written the weaker way first, and it did not fire on the mutation it exists for.
  const countOf = (e: any) => Number(e?.helped ?? e?.good ?? e?.success ?? 0)
  const before = countOf((await worthEntries())[first.id])
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: "a1" }, { title: "second green", metadata: { passed: true } })
  const after = countOf((await worthEntries())[first.id])
  expect(after).toBeGreaterThan(before)
})

test("a memory served in ANOTHER session is not credited for this one's outcome", async () => {
  // Co-occurrence only means something if the memory was in the context that produced the result.
  const h1 = await turn({ session: "b1" })
  await systemText(h1, "b1")
  const raw = readFileSync(path.join(data, "fabula", "memstore", "raw.jsonl"), "utf8")
  const b1Episode = raw.trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.kind === "episode")!
  const before = (await worthEntries())[b1Episode.id]
  const beforeGood = Number(before?.helped ?? before?.good ?? 0)

  // a DIFFERENT session verifies without ever serving b1's memory
  const { FabulaMemory } = await import(path.join(REPO, "plugin/fabula-memory.ts"))
  const h2: any = await FabulaMemory({ directory: ws, sessionID: "b2" })
  await h2["tool.execute.after"]({ tool: "verify_done", sessionID: "b2" }, { title: "unrelated green", metadata: { passed: true } })

  const after = (await worthEntries())[b1Episode.id]
  expect(Number(after?.helped ?? after?.good ?? 0)).toBe(beforeGood)
})

test("a verify reported only as TEXT still forms an episode", async () => {
  // Not every verify tool sets structured metadata; dropping the text fallback silently stops memory
  // forming at all on those, with nothing anywhere going red.
  const { FabulaMemory } = await import(path.join(REPO, "plugin/fabula-memory.ts"))
  const h: any = await FabulaMemory({ directory: ws, sessionID: "c1" })
  await h["tool.execute.after"]({ tool: "str_replace", sessionID: "c1", args: { path: path.join(ws, SRC) } }, {})
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: "c1" }, { title: "✅ PASSED — 12 tests" })
  const raw = readFileSync(path.join(data, "fabula", "memstore", "raw.jsonl"), "utf8")
  expect(raw.split("\n").filter((l) => l.includes('"kind":"episode"')).length).toBeGreaterThan(0)
})

test("a differently-named verify tool still forms an episode", async () => {
  const { FabulaMemory } = await import(path.join(REPO, "plugin/fabula-memory.ts"))
  const h: any = await FabulaMemory({ directory: ws, sessionID: "d1" })
  await h["tool.execute.after"]({ tool: "str_replace", sessionID: "d1", args: { path: path.join(ws, SRC) } }, {})
  await h["tool.execute.after"]({ tool: "run_verify", sessionID: "d1" }, { title: "ok", metadata: { passed: true } })
  const raw = readFileSync(path.join(data, "fabula", "memstore", "raw.jsonl"), "utf8")
  expect(raw.split("\n").filter((l) => l.includes('"kind":"episode"')).length).toBeGreaterThan(0)
})

test("after a green turn, the NEXT turn does not anchor to a file it never touched", async () => {
  // The edit trail must clear on green, or a later memory claims to be about code that turn never saw —
  // an anchor pointing at the wrong file is worse than no anchor, because it looks checkable.
  const h = await turn({ session: "e1" })
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: "e1" }, { title: "second green", metadata: { passed: true } })
  const raw = readFileSync(path.join(data, "fabula", "memstore", "raw.jsonl"), "utf8")
  const episodes = raw.trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "episode")
  expect(episodes.length).toBeGreaterThan(1)
  expect(episodes[episodes.length - 1].claimsCode).toBe(false)
})

// ── the unrecognised-verify direction ──────────────────────────────────────────────────────────────
//
// These three hold today and were held by nothing. The first is the one that matters: when a verify
// arrives as TEXT only, an unrecognised result must never read as GREEN. The tracked red case above sets
// `metadata.passed:false`, and the metadata branch runs first — so it never exercised the text path at
// all, and a one-word mutation there produced a record whose own text says "❌ NOT DONE — 3 tests failed"
// while the gate journalled `admit / verified-outcome`. A memory that contradicts itself is bad; one that
// contradicts itself INTO the journal the promotion default will be argued from is worse.

test("a RED reported only as text is journalled as a refusal, never admitted", async () => {
  const { FabulaMemory } = await import(path.join(REPO, "plugin/fabula-memory.ts"))
  const h: any = await FabulaMemory({ directory: ws, sessionID: "r1" })
  await h["tool.execute.after"]({ tool: "str_replace", sessionID: "r1", args: { path: path.join(ws, SRC) } }, {})
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: "r1" }, { title: "❌ NOT DONE — 3 tests failed" })
  const d = JSON.parse(journal().trim().split("\n").pop()!)
  expect(d.decision).toBe("refuse")
  const raw = readFileSync(path.join(data, "fabula", "memstore", "raw.jsonl"), "utf8")
  const rec = raw.trim().split("\n").map((l) => JSON.parse(l)).pop()
  // …and the record's own words must agree with the verdict it was given
  expect(String(rec.text)).toContain("RED")
})

test("a non-source file does not become an anchor", async () => {
  // Anchoring to a lockfile or a changelog means invalidating on churn that has nothing to do with the
  // memory — fail-closed, but "a signal that fires constantly gets switched off" is the failure the
  // symbol-scope design exists to avoid, and it applies here just as well.
  writeFileSync(path.join(ws, "package-lock.json"), '{"lockfileVersion":3}')
  const { FabulaMemory } = await import(path.join(REPO, "plugin/fabula-memory.ts"))
  const h: any = await FabulaMemory({ directory: ws, sessionID: "s1" })
  await h["tool.execute.after"]({ tool: "str_replace", sessionID: "s1", args: { path: path.join(ws, "package-lock.json") } }, {})
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: "s1" }, { title: "ok", metadata: { passed: true } })
  const raw = readFileSync(path.join(data, "fabula", "memstore", "raw.jsonl"), "utf8")
  const rec = raw.trim().split("\n").map((l) => JSON.parse(l)).pop()
  expect(String(rec.anchor?.path ?? "")).not.toContain("package-lock")
})

test("the anchor binds to the LAST file the turn changed, not the first", async () => {
  // The last edit is the one the verify actually exercised. Binding to the first means a change to the
  // code the memory is really about does not invalidate it — every anchor test stays green while the
  // anchor points somewhere harmless.
  writeFileSync(path.join(ws, "src", "second.ts"), "export function later() {\n  return 2\n}\n")
  const { FabulaMemory } = await import(path.join(REPO, "plugin/fabula-memory.ts"))
  const h: any = await FabulaMemory({ directory: ws, sessionID: "t1" })
  await h["tool.execute.after"]({ tool: "str_replace", sessionID: "t1", args: { path: path.join(ws, SRC) } }, {})
  await h["tool.execute.after"]({ tool: "str_replace", sessionID: "t1", args: { path: path.join(ws, "src", "second.ts") } }, {})
  await h["tool.execute.after"]({ tool: "verify_done", sessionID: "t1" }, { title: "ok", metadata: { passed: true } })
  const raw = readFileSync(path.join(data, "fabula", "memstore", "raw.jsonl"), "utf8")
  const rec = raw.trim().split("\n").map((l) => JSON.parse(l)).pop()
  expect(String(rec.anchor?.path ?? "")).toContain("second.ts")
})
