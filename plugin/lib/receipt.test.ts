import { test, expect } from "bun:test"
import {
  newReceiptState, classifyHost, gateFromMarker, recordGate, recordEdit, recordModel, recordTask,
  buildReceipt, buildReplay, countDiffFiles, scrubProse, renderReceiptMarkdown, renderReceiptJSON,
  receiptSummary,
} from "./receipt"

const VERIFY = { cmd: "python -m pytest -q", label: "pytest", exitCode: 0, passed: true, outputTail: "2 passed in 0.4s" }
const DIFF = `diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n+def f(): return 1\ndiff --git a/y.py b/y.py\n--- a/y.py\n+++ b/y.py\n+ok`

test("classifyHost: local hints, cloud vendors, unknown", () => {
  expect(classifyHost("lmstudio")).toBe("local")
  expect(classifyHost("ollama")).toBe("local")
  expect(classifyHost("", "qwen3.6-35b-mlx")).toBe("local")
  expect(classifyHost("openai")).toBe("cloud")
  expect(classifyHost("nvidia", "deepseek-v4")).toBe("cloud")
  expect(classifyHost("")).toBe("unknown")
  expect(classifyHost("some-random-proxy")).toBe("unknown")
})

test("gateFromMarker: known markers map to protocol gates; unknown -> null", () => {
  expect(gateFromMarker("verify")?.id).toBe("verify")
  expect(gateFromMarker("reproduce")?.id).toBe("reproduce")
  expect(gateFromMarker("comprehension")?.id).toBe("comprehension")
  expect(gateFromMarker("second-opinion")?.id).toBe("second-opinion")
  expect(gateFromMarker("nope")).toBeNull()
})

test("auto-rewind marker carries the revert count when present", () => {
  const g = gateFromMarker("auto-rewind", { autoRewind: { reverted: 3 } })
  expect(g?.id).toBe("auto-rewind")
  expect(g?.forced).toContain("3")
  const g2 = gateFromMarker("auto-rewind", {})
  expect(g2?.forced).toContain("repeated")
})

test("countDiffFiles: counts diff --git headers", () => {
  expect(countDiffFiles(DIFF)).toBe(2)
  expect(countDiffFiles("")).toBe(0)
  expect(countDiffFiles("+++ b/only.py\n+x")).toBe(1)
})

test("buildReplay: with and without a patch path", () => {
  expect(buildReplay("/tmp/repo", "pytest", ".fabula/receipts/r.patch")).toBe("git apply .fabula/receipts/r.patch && pytest")
  // No patch recorded → the run is not replayable; the text must say so, not point at a nonexistent diff.
  expect(buildReplay("/tmp/repo", "pytest")).toContain("not replayable")
})

test("buildReplay with a base commit is a deterministic worktree replay", () => {
  const r = buildReplay("/tmp/repo", "pytest", ".fabula/receipts/r.patch", "a".repeat(40), 123)
  expect(r).toContain("git worktree add --detach /tmp/fabula-replay-123 aaaaaaaaaaaa")
  expect(r).not.toContain("/tmp/repo") // portable: no machine path baked into the printed command
  expect(r).toContain('apply "$(pwd)/.fabula/receipts/r.patch"')
  expect(r).toContain("&& pytest")
})

test("buildReplay re-runs the check from the recorded subdirectory (the demo/ live bug)", () => {
  // A bare `bun test` recorded in a subproject must not sweep the whole worktree on replay.
  const r = buildReplay("/tmp/repo/demo", "bun test", ".fabula/receipts/r.patch", "a".repeat(40), 123, "demo")
  expect(r).toContain("cd /tmp/fabula-replay-123/demo && bun test")
  // Root-recorded receipts keep the old shape.
  const root = buildReplay("/tmp/repo", "bun test", ".fabula/receipts/r.patch", "a".repeat(40), 123)
  expect(root).toContain("cd /tmp/fabula-replay-123 && bun test")
})

test("verification.cwd lands in the receipt JSON and drives the replay", () => {
  const s = newReceiptState()
  const r = buildReceipt({
    state: s, verify: { ...VERIFY, cwd: "demo" }, diff: DIFF, workdir: "/tmp/r/demo",
    mintedAt: 7, patchPath: "p.patch", base: "c".repeat(40),
  })
  expect(r.verification.cwd).toBe("demo")
  expect(r.replay).toContain("/demo && ")
  expect(JSON.parse(renderReceiptJSON(r)).verification.cwd).toBe("demo")
})

test("buildReceipt carries the base commit into receipt + replay", () => {
  const s = newReceiptState()
  const base = "b".repeat(40)
  const r = buildReceipt({ state: s, verify: VERIFY, diff: DIFF, workdir: "/tmp/r", mintedAt: 5, patchPath: "p.patch", base })
  expect(r.base).toBe(base)
  expect(r.replay).toContain("worktree add")
  const md = renderReceiptMarkdown(r)
  expect(md).toContain("**base:** `bbbbbbbbbbbb`")
})

test("scrubProse: strips unearned absolutes from FABULA's own prose", () => {
  expect(scrubProse("this is 100% proven and guaranteed")).toBe("this is the check verified and checked")
  expect(scrubProse("normal text")).toBe("normal text")
})

test("buildReceipt: verify gate always present; gates sorted in protocol order", () => {
  const s = newReceiptState()
  recordModel(s, { providerID: "lmstudio", modelID: "qwen3.6-35b" })
  recordTask(s, "fix the off-by-one in paginate()")
  recordGate(s, "second-opinion")
  recordGate(s, "reproduce")
  recordGate(s, "comprehension")
  const r = buildReceipt({ state: s, verify: VERIFY, diff: DIFF, workdir: "/tmp/repo", mintedAt: 1_700_000_000_000, patchPath: ".fabula/receipts/r.patch" })
  expect(r.model).toEqual({ id: "qwen3.6-35b", host: "local" })
  expect(r.gates.map((g) => g.id)).toEqual(["verify", "reproduce", "comprehension", "second-opinion"])
  expect(r.artifact.files).toBe(2)
  expect(r.artifact.bytes).toBeGreaterThan(0)
  expect(r.verification.passed).toBe(true)
  expect(r.replay).toContain("git apply")
})

test("buildReceipt: missing model/task degrade to explicit unknowns, never throw", () => {
  const r = buildReceipt({ state: newReceiptState(), verify: VERIFY, diff: "", workdir: "/tmp/r", mintedAt: 0 })
  expect(r.model.id).toBe("unknown")
  expect(r.task).toContain("unavailable")
  expect(r.gates.map((g) => g.id)).toEqual(["verify"])
  expect(r.artifact.files).toBe(0)
})

test("recordModel ignores empty modelID; recordTask truncates long text", () => {
  const s = newReceiptState()
  recordModel(s, { providerID: "lmstudio" })
  expect(s.model).toBeUndefined()
  recordTask(s, "x".repeat(1000))
  expect((s.task || "").length).toBeLessThan(700)
  expect(s.task).toContain("…")
})

test("recordEdit dedups; edits are a set", () => {
  const s = newReceiptState()
  recordEdit(s, "a.py"); recordEdit(s, "a.py"); recordEdit(s, "b.py")
  expect(s.edits.size).toBe(2)
})

test("renderReceiptMarkdown: VERIFIED verdict, real output kept, replay block present", () => {
  const s = newReceiptState()
  recordModel(s, { providerID: "lmstudio", modelID: "qwen3.6-35b" })
  recordTask(s, "fix bug")
  const r = buildReceipt({ state: s, verify: VERIFY, diff: DIFF, workdir: "/tmp/repo", mintedAt: 1_700_000_000_000, patchPath: "p.patch" })
  const md = renderReceiptMarkdown(r)
  expect(md).toContain("VERIFIED")
  expect(md).toContain("qwen3.6-35b")
  expect(md).toContain("2 passed in 0.4s")   // real captured evidence retained
  expect(md).toContain("## Replay")
  expect(md).toContain("git apply")
})

test("renderReceiptMarkdown: NOT DONE verdict when verification did not pass", () => {
  const r = buildReceipt({ state: newReceiptState(), verify: { ...VERIFY, passed: false, exitCode: 1 }, diff: DIFF, workdir: "/tmp/r", mintedAt: 0 })
  expect(renderReceiptMarkdown(r)).toContain("NOT DONE")
})

test("renderReceiptJSON: round-trips to a stable object", () => {
  const r = buildReceipt({ state: newReceiptState(), verify: VERIFY, diff: DIFF, workdir: "/tmp/r", mintedAt: 1, patchPath: "p" })
  const parsed = JSON.parse(renderReceiptJSON(r))
  expect(parsed.version).toBe("fabula-receipt/v0")
  expect(parsed.verification.cmd).toBe("python -m pytest -q")
})

test("receiptSummary: one-liner reflects verdict + counts", () => {
  const s = newReceiptState()
  recordModel(s, { providerID: "lmstudio", modelID: "qwen" })
  recordGate(s, "reproduce")
  const r = buildReceipt({ state: s, verify: VERIFY, diff: DIFF, workdir: "/tmp/r", mintedAt: 0 })
  const sum = receiptSummary(r)
  expect(sum).toContain("VERIFIED")
  expect(sum).toContain("qwen")
  expect(sum).toContain("2 file(s)")
})
