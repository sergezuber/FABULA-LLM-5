// W3 — trajectory features + hard-veto for the auto-goal judge (pure). Guards the deterministic core that
// grounds the judge and refuses an overconfident ok:true when the dynamics are self-evidently not-done.
import { describe, expect, test } from "bun:test"
import {
  trajectoryFeatures,
  badDynamicsSignature,
  renderFeatureBlock,
  type ScanMessage,
} from "../../src/session/verify-gate"

const U = (): ScanMessage => ({ role: "user", parts: [{ type: "text" }] })
const synthU = (): ScanMessage => ({ role: "user", parts: [{ type: "text", synthetic: true }] })
const tool = (t: string, metadata?: any): ScanMessage => ({ role: "assistant", parts: [{ type: "tool", tool: t, metadata }] })
const vGreen = () => tool("verify_done", { passed: true })
const vRed = () => tool("verify_done", { passed: false })
const edit = () => tool("str_replace")
const rewindRed = () => tool("verify_done", { passed: false, autoRewind: { toCheckpoint: "c" } })
const notDoneP = () => tool("verify_done", { notDone: { reason: "x" } })

describe("trajectoryFeatures", () => {
  test("counts greens/reds, tracks last verify, edits", () => {
    const f = trajectoryFeatures([U(), edit(), vRed(), edit(), vGreen()])
    expect(f).toMatchObject({ verifyGreen: 1, verifyRed: 1, lastVerify: "green", edits: 2, unverifiedEdits: false })
  })
  test("resets at a REAL user boundary; a synthetic user turn does NOT reset", () => {
    const f = trajectoryFeatures([U(), vRed(), vRed(), U(), vGreen()])
    expect(f).toMatchObject({ verifyRed: 0, verifyGreen: 1, lastVerify: "green" }) // only the post-boundary turn
    const g = trajectoryFeatures([U(), vRed(), synthU(), vRed()])
    expect(g.verifyRed).toBe(2) // synthetic continuation keeps counting
  })
  test("rewind (metadata.autoRewind on a red) and notDone counted; notDone leaves verify counts intact", () => {
    expect(trajectoryFeatures([U(), rewindRed()])).toMatchObject({ verifyRed: 1, rewinds: 1, lastVerify: "red" })
    expect(trajectoryFeatures([U(), notDoneP()])).toMatchObject({ notDone: 1, verifyRed: 0, verifyGreen: 0, lastVerify: "none" })
  })
})

describe("badDynamicsSignature — HARD VETO on self-evident not-done", () => {
  const veto = (t: ScanMessage[]) => badDynamicsSignature(trajectoryFeatures(t))
  test("vetoes: last verify red / repeated red / notdone / unverified edits", () => {
    expect(veto([U(), vGreen(), vRed()]).veto).toBe(true)       // last red
    expect(veto([U(), vRed(), vRed()]).veto).toBe(true)         // repeated red
    expect(veto([U(), notDoneP()]).veto).toBe(true)             // terminal not-done
    expect(veto([U(), edit()]).veto).toBe(true)                 // unverified source edit
  })
  test("does NOT veto a clean/recovered green trajectory or a pure-chat turn (never traps a real done)", () => {
    expect(veto([U(), edit(), vGreen()]).veto).toBe(false)      // edited then verified green
    expect(veto([U(), vRed(), vGreen()]).veto).toBe(false)      // recovered: last is green
    expect(veto([U(), tool("read"), tool("grep")]).veto).toBe(false) // pure Q&A, no edits/verifies
  })
  test("reason names the specific signal and never mislabels non-red scenarios as red", () => {
    expect(veto([U(), vGreen(), vRed()]).reason).toMatch(/red/i)
    const nd = veto([U(), notDoneP()]).reason.toLowerCase()
    expect(nd).toMatch(/not.?done|terminal/); expect(nd).not.toContain("red")
    const uv = veto([U(), edit()]).reason.toLowerCase()
    expect(uv).toMatch(/unverif|never verif|edit/); expect(uv).not.toContain("red")
  })
})

test("the unverified-edits veto stands down where there is NO verify command (mirrors the arming layer)", () => {
  const edited = trajectoryFeatures([U(), edit()]) // source edited, never verified
  expect(badDynamicsSignature(edited).veto).toBe(true) // default (unknown project) stays strict
  expect(badDynamicsSignature(edited, { hasVerifyCommand: true }).veto).toBe(true) // verifiable repo: veto
  // A docs/prompts repo can never make verify_done green — vetoing there would burn the whole re-entry
  // budget demanding an impossible green, which is exactly what the arming layer refuses to do.
  expect(badDynamicsSignature(edited, { hasVerifyCommand: false }).veto).toBe(false)
  // …but a REAL failing verify still vetoes even there: a red is a red.
  expect(badDynamicsSignature(trajectoryFeatures([U(), edit(), vRed()]), { hasVerifyCommand: false }).veto).toBe(true)
})

test("renderFeatureBlock carries the measured counts + last verify for the judge context", () => {
  const s = renderFeatureBlock(trajectoryFeatures([U(), edit(), vRed()]))
  expect(s).toMatch(/1 red/); expect(s).toMatch(/last:\s*red/i); expect(s).toMatch(/edit/i)
})
