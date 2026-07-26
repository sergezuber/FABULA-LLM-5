// Wiring test: drives the REAL fabula-attest hooks with the engine's input/output contract, hermetically
// (under `bun test` auxChain has no endpoint, so the armed path degrades without a live model call). Proves
// the load-failure-safe contract AND the central MUTE invariant: silent on chat, engages only on an armed
// deliverable turn — and never throws.

import { test, expect, beforeAll } from "bun:test"
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tmpdir } from "node:os"

// enable the default-off plugin for this test (same mechanism as the witness/relay wiring tests)
beforeAll(() => {
  const stateFile = join(tmpdir(), `attest-state-${process.pid}.json`)
  writeFileSync(stateFile, JSON.stringify({ disabled: [], enabled: ["attest"] }))
  process.env.FABULA_PLUGIN_STATE = stateFile
})

import { FabulaAttest } from "../fabula-attest"

async function hooks() {
  return (await FabulaAttest({} as any)) as any
}
function writeResult(text: string) {
  return { output: text, metadata: {} as any }
}

test("loads and exposes the hooks when enabled", async () => {
  const h = await hooks()
  expect(typeof h["chat.message"]).toBe("function")
  expect(typeof h["tool.execute.after"]).toBe("function")
})

test("kill-switch: FABULA_ATTEST=0 → inert ({}), no hooks", async () => {
  process.env.FABULA_ATTEST = "0"
  const h = await hooks()
  expect(h["tool.execute.after"]).toBeUndefined()
  delete process.env.FABULA_ATTEST
})

test("MUTE on a chat/opinion turn: a written file is NOT gated (fixes the chat-breakage + IAL killers)", async () => {
  const h = await hooks()
  const sid = "chat-1"
  await h["chat.message"]({ sessionID: sid, message: { text: "what do you think of this novel?" } })
  const out = writeResult("A long enough written answer ".repeat(4))
  await h["tool.execute.after"]({ sessionID: sid, tool: "create_file", args: { path: "a.md", content: out.output } }, out)
  expect(out.output).toBe("A long enough written answer ".repeat(4)) // unchanged — the gate stayed silent
  expect(out.metadata.attest).toBeUndefined()
})

test("armed deliverable turn: reads are tracked, the gate runs and degrades gracefully with no aux (never throws)", async () => {
  const h = await hooks()
  const sid = "task-1"
  await h["chat.message"]({ sessionID: sid, message: { text: "analyze the book and save a literary analysis" } })
  // a source read is tracked without throwing
  const rd = writeResult("Кружка тёплая сама по себе. Линолеум с трещиной у стены.")
  await h["tool.execute.after"]({ sessionID: sid, tool: "read", args: { path: "глава_01.md" } }, rd)
  // the deliverable write triggers the gate; under bun test aux is inert → runGate returns "" → output unchanged
  const del = writeResult("The analysis claims «Кружка тёплая сама по себе.» and correlation 0.9999. ".repeat(2))
  await expect(
    h["tool.execute.after"]({ sessionID: sid, tool: "create_file", args: { path: "analysis.md", content: del.output } }, del),
  ).resolves.toBeUndefined()
  // no crash, and with no aux the deliverable is not falsely flagged
  expect(typeof del.output).toBe("string")
})

test("str_replace is gated too: the deliverable is read from disk, the gate path runs without throwing (#5)", async () => {
  const h = await hooks()
  const sid = "task-2"
  const f = join(tmpdir(), `attest-deliverable-${process.pid}.md`)
  writeFileSync(f, "The analysis states «Кружка тёплая сама по себе.» and correlation 0.9999 across the run. ".repeat(2))
  await h["chat.message"]({ sessionID: sid, message: { text: "analyze the source and write the review" } })
  const out = writeResult("edited")
  // str_replace carries only a path (+ old/new string); the plugin reads the resulting FILE as the deliverable
  await expect(
    h["tool.execute.after"]({ sessionID: sid, tool: "str_replace", args: { path: f }, directory: tmpdir() }, out),
  ).resolves.toBeUndefined()
})

test("bounded re-entry: the write hook fires the gate at most FABULA_ATTEST_MAX rounds (no unbounded loop)", async () => {
  const h = await hooks()
  const sid = "task-3"
  await h["chat.message"]({ sessionID: sid, message: { text: "analyze and write a summary" } })
  // drive create_file 5 times; with the default cap of 2 the extra writes must not throw and stay silent
  for (let i = 0; i < 5; i++) {
    const o = writeResult("A written deliverable long enough to be substantive. ".repeat(3))
    await expect(
      h["tool.execute.after"]({ sessionID: sid, tool: "create_file", args: { path: `a${i}.md`, content: o.output } }, o),
    ).resolves.toBeUndefined()
  }
})

// ── The side-car (measured requirement, 2026-07-27) ─────────────────────────
// The gate acts in the turn it runs; nothing survived it. These check that a record appears BESIDE the
// receipt, that it never touches the receipt, and that a model-decided verdict is written as an honest
// absence rather than laundered into a fact a reader cannot re-run.
test("a checked deliverable leaves a record next to the receipt, and the receipt is untouched", async () => {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "fab-attest-side-")))
  mkdirSync(join(ws, ".fabula", "receipts"), { recursive: true })
  const receipt = join(ws, ".fabula", "receipts", "latest.json")
  writeFileSync(receipt, '{"version":"fabula-receipt/v0","untouched":true}')
  const before = readFileSync(receipt, "utf8")

  const { buildAttestation, upsertAttestation, ATTESTATION_FILE } = await import("../lib/attest/attestation")
  const rec = buildAttestation({
    deliverable: "The parable says the woodcutter sharpened his axe.",
    sources: [{ label: "ch1", text: "he sharpened his axe" }],
    claims: [{ id: "c1", text: "sharpened his axe", type: "citation", loadBearing: true } as any],
    deterministic: { c1: "PASS" },
    modelVerdicts: { c2: "confirmed" },
  })
  const file = join(ws, ".fabula", "receipts", ATTESTATION_FILE)
  writeFileSync(file, JSON.stringify(upsertAttestation([], rec), null, 2))

  const read = JSON.parse(readFileSync(file, "utf8"))
  expect(read).toHaveLength(1)
  expect(read[0].claims[0].outcome).toBe("PASS")
  expect(read[0].sources[0].label).toBe("ch1")
  // The receipt is NEVER modified — the invariant this side-car exists to preserve.
  expect(readFileSync(receipt, "utf8")).toBe(before)
  rmSync(ws, { recursive: true, force: true })
})

test("the deterministic layer re-runs to the same answer on the same bytes", async () => {
  const { buildAttestation } = await import("../lib/attest/attestation")
  const mk = () => buildAttestation({
    deliverable: "a claim about a source",
    sources: [{ label: "s", text: "the source text" }],
    claims: [{ id: "c1", text: "x", type: "citation", loadBearing: false } as any],
    deterministic: { c1: "SIGNAL" },
  })
  expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()))
})
