import { describe, expect, test } from "bun:test"
import {
  EDIT_TOOLS,
  FORCE_VERIFY_REMINDER,
  hasUnverifiedSourceEdits,
  hasVerifyCommand,
  isRealUserBoundary,
  needsForcedVerify,
  answerIsTerminal,
  goalStopLayerFires,
  turnEvents,
  type ScanMessage,
  type TurnEvent,
} from "../../src/session/verify-gate"

const E = (type: TurnEvent["type"]): TurnEvent => ({ type }) as TurnEvent

describe("hasUnverifiedSourceEdits (core scan)", () => {
  test("no events → false (nothing edited)", () => {
    expect(hasUnverifiedSourceEdits([])).toBe(false)
  })
  test("a lone edit → true (unverified)", () => {
    expect(hasUnverifiedSourceEdits([E("edit")])).toBe(true)
  })
  test("edit then green verify → false (verified)", () => {
    expect(hasUnverifiedSourceEdits([E("edit"), E("verify-green")])).toBe(false)
  })
  test("green verify then a NEW edit → true (re-dirtied)", () => {
    expect(hasUnverifiedSourceEdits([E("edit"), E("verify-green"), E("edit")])).toBe(true)
  })
  test("edit/verify/edit/verify → false (last edit was verified)", () => {
    expect(hasUnverifiedSourceEdits([E("edit"), E("verify-green"), E("edit"), E("verify-green")])).toBe(false)
  })
  test("a real user boundary resets the dirty flag", () => {
    // edit in a PRIOR turn, then a fresh user turn with no edits → not gated
    expect(hasUnverifiedSourceEdits([E("edit"), E("boundary")])).toBe(false)
  })
  test("edit before boundary is forgotten; edit after boundary counts", () => {
    expect(hasUnverifiedSourceEdits([E("edit"), E("verify-green"), E("boundary"), E("edit")])).toBe(true)
  })
})

describe("isRealUserBoundary", () => {
  test("user with a non-synthetic part = real boundary", () => {
    expect(isRealUserBoundary({ role: "user", parts: [{ type: "text", synthetic: false }] })).toBe(true)
  })
  test("user with ONLY synthetic parts (continuation reminder) = NOT a boundary", () => {
    expect(isRealUserBoundary({ role: "user", parts: [{ type: "text", synthetic: true }] })).toBe(false)
  })
  test("assistant message is never a boundary", () => {
    expect(isRealUserBoundary({ role: "assistant", parts: [{ type: "text" }] })).toBe(false)
  })
})

describe("turnEvents (extract from transcript)", () => {
  const userReal: ScanMessage = { role: "user", parts: [{ type: "text", synthetic: false }] }
  const userSynthetic: ScanMessage = { role: "user", parts: [{ type: "text", synthetic: true }] }
  const asstEdit: ScanMessage = { role: "assistant", parts: [{ type: "tool", tool: "edit" }] }
  const asstRead: ScanMessage = { role: "assistant", parts: [{ type: "tool", tool: "read" }] }
  const asstVerifyGreen: ScanMessage = {
    role: "assistant",
    parts: [{ type: "tool", tool: "verify_done", metadata: { passed: true } }],
  }
  const asstVerifyRed: ScanMessage = {
    role: "assistant",
    parts: [{ type: "tool", tool: "verify_done", metadata: { passed: false } }],
  }

  test("real user → boundary; synthetic user → ignored", () => {
    expect(turnEvents([userReal, userSynthetic])).toEqual([{ type: "boundary" }])
  })
  test("edit tool → edit event; read/grep → ignored", () => {
    expect(turnEvents([asstEdit, asstRead])).toEqual([{ type: "edit" }])
  })
  test("bash: a tree-mutating command is an edit; a read-only command is ignored", () => {
    const bashEdit: ScanMessage = { role: "assistant", parts: [{ type: "tool", tool: "bash", input: { command: "sed -i 's/a/b/' src/x.py" } }] }
    const bashApply: ScanMessage = { role: "assistant", parts: [{ type: "tool", tool: "bash_tool", input: { command: "git apply /tmp/fix.diff" } }] }
    const bashRead: ScanMessage = { role: "assistant", parts: [{ type: "tool", tool: "bash", input: { command: "python -m pytest -q" } }] }
    expect(turnEvents([bashEdit])).toEqual([{ type: "edit" }])
    expect(turnEvents([bashApply])).toEqual([{ type: "edit" }])
    expect(turnEvents([bashRead])).toEqual([])
    // the exact bench hole: model patches source via the shell, stops, never verifies → force-verify fires
    expect(needsForcedVerify([userReal, bashEdit])).toBe(true)
    expect(needsForcedVerify([userReal, bashEdit, asstVerifyGreen])).toBe(false)
  })
  test("green verify → verify-green; RED verify → not counted as green", () => {
    expect(turnEvents([asstVerifyGreen])).toEqual([{ type: "verify-green" }])
    expect(turnEvents([asstVerifyRed])).toEqual([]) // red verify does NOT clear dirty
  })
  test("end-to-end: edit + red verify still needs forced verify; + green clears it", () => {
    expect(needsForcedVerify([userReal, asstEdit, asstVerifyRed])).toBe(true)
    expect(needsForcedVerify([userReal, asstEdit, asstVerifyGreen])).toBe(false)
  })
  test("read-only turn (no edits) is never gated", () => {
    expect(needsForcedVerify([userReal, asstRead])).toBe(false)
  })
})

describe("EDIT_TOOLS coverage", () => {
  test("mutating tools are edits", () => {
    for (const t of ["edit", "multiedit", "write", "apply_patch", "str_replace"]) expect(EDIT_TOOLS.has(t)).toBe(true)
  })
  test("read-only tools are NOT edits", () => {
    for (const t of ["read", "grep", "glob", "bash", "list", "webfetch"]) expect(EDIT_TOOLS.has(t)).toBe(false)
  })
})

describe("hasVerifyCommand (no-test-project guard)", () => {
  test("FABULA_VERIFY_CMD override → always true", () => {
    expect(hasVerifyCommand([], "docker exec cid pytest")).toBe(true)
  })
  test("python/js/go/rust/make projects → true", () => {
    expect(hasVerifyCommand(["pyproject.toml"])).toBe(true)
    expect(hasVerifyCommand(["package.json"])).toBe(true)
    expect(hasVerifyCommand(["go.mod"])).toBe(true)
    expect(hasVerifyCommand(["Cargo.toml"])).toBe(true)
    expect(hasVerifyCommand(["Makefile"])).toBe(true)
  })
  test("a project with no recognizable verify (e.g. docs repo) → false → gate stays off", () => {
    expect(hasVerifyCommand(["README.md", "LICENSE", "notes.txt"])).toBe(false)
    expect(hasVerifyCommand([], "")).toBe(false)
  })
})

describe("reminder text", () => {
  test("names verify_done and is a system-reminder", () => {
    expect(FORCE_VERIFY_REMINDER).toContain("verify_done")
    expect(FORCE_VERIFY_REMINDER.startsWith("<system-reminder>")).toBe(true)
  })
})

import { FORCE_VERIFY_NOT_DONE } from "../../src/session/verify-gate"
describe("cap-exhausted marker", () => {
  test("NOT DONE marker is a real, honest, non-empty message", () => {
    expect(FORCE_VERIFY_NOT_DONE).toContain("NOT DONE")
    expect(FORCE_VERIFY_NOT_DONE).toContain("unverified")
    expect(FORCE_VERIFY_NOT_DONE.length).toBeGreaterThan(40)
  })
})

// ── Change 1 (PRIMARY, stop-layer): the goal judge should NOT be called when
// the turn has no verifiable artifact — a pure-conversational / Q&A answer is
// terminal (SOTA: Agentic Abstention — ANSWER ∈ {ANSWER, ABSTAIN, ACT} is
// terminal and must not re-enter a verify loop). Pure predicate the goalGate
// short-circuits on BEFORE the (expensive ~14s on a 200k local context) judge
// call. It composes needsForcedVerify: a turn that needs forcing has a
// verifiable artifact → not terminal; a turn with no edits since the last real
// user boundary → terminal.
describe("answerIsTerminal (Change 1 — goalGate short-circuit on a verifiable artifact)", () => {
  // helper: a turn shaped as ScanMessage[], scoped to one real user boundary.
  const turn = (parts: ScanMessage["parts"]): ScanMessage[] => [
    { role: "user", parts: [{ type: "text" }] }, // real boundary (non-synthetic)
    { role: "assistant", parts },
  ]
  const editPart = (): ScanMessage["parts"][number] => ({ type: "tool", tool: "edit" })
  const verifyGreenPart = (): ScanMessage["parts"][number] => ({
    type: "tool",
    tool: "verify_done",
    metadata: { passed: true },
  })

  test("Q&A turn — only text, no edits → TERMINAL (the bug: conversation answer must stop)", () => {
    expect(answerIsTerminal(turn([{ type: "text" }]))).toBe(true)
  })
  test("turn with an unverified source edit → NOT terminal (work to prove)", () => {
    expect(answerIsTerminal(turn([editPart()]))).toBe(false)
  })
  test("turn with edit + green verify → TERMINAL (work was verified, answer stands)", () => {
    expect(answerIsTerminal(turn([editPart(), verifyGreenPart()]))).toBe(true)
  })
  test("empty turn (no assistant parts) → TERMINAL (nothing to verify)", () => {
    expect(answerIsTerminal(turn([]))).toBe(true)
  })

  // The stop-layer short-circuit must fire ONLY for AUTO goals. An explicit /goal
  // is the user opting into the loop and must always reach the judge — otherwise a
  // no-artifact answer silently satisfies a user-stated condition (regression).
  test("AUTO goal + terminal Q&A answer → short-circuit FIRES (kills the auto-loop)", () => {
    expect(goalStopLayerFires({ auto: true, messages: turn([{ type: "text" }]) })).toBe(true)
  })
  test("AUTO goal + unverified edit → does NOT fire (real work to prove → judge runs)", () => {
    expect(goalStopLayerFires({ auto: true, messages: turn([editPart()]) })).toBe(false)
  })
  test("EXPLICIT /goal + terminal answer → does NOT fire (user opted in; judge must run)", () => {
    expect(goalStopLayerFires({ auto: false, messages: turn([{ type: "text" }]) })).toBe(false)
  })
  test("EXPLICIT /goal + verified edit → does NOT fire (explicit goal always reaches judge)", () => {
    expect(goalStopLayerFires({ auto: false, messages: turn([editPart(), verifyGreenPart()]) })).toBe(false)
  })
})
