// Pure-core unit coverage for W2 (diagnose / sidefx / convrewind). The full hook-driven behavior is
// exercised by the frozen wiring suite; here we pin the deterministic decision cores.
import { test, expect } from "bun:test"
import { classifyError, diagnose } from "./diagnose"
import { nonIdempotentEffect, renderLedger } from "./sidefx"
import { collapseFailedSpan, type Msg } from "./convrewind"

// ── diagnose (#2) ────────────────────────────────────────────────────────────────────────────────────
test("classifyError maps the common failure classes", () => {
  expect(classifyError("AssertionError: expected 5 got 3")).toBe("assertion")
  expect(classifyError("ImportError: no module named foo")).toBe("import")
  expect(classifyError("TypeError: x is not a function")).toBe("type")
  expect(classifyError("TimeoutError: exceeded time")).toBe("timeout")
  expect(classifyError("SyntaxError: invalid syntax")).toBe("syntax")
  expect(classifyError("eslint: prefer-const")).toBe("lint")
  expect(classifyError("Segmentation fault (core dumped)")).toBe("runtime")
  expect(classifyError("all good")).toBe("unknown")
})
test("diagnose: same signature across the streak → grounded root-cause naming the sig + file", () => {
  const s = diagnose(["AssertionError: expected 5 got 3", "AssertionError: expected 5 got 3"], ["signals.py"])
  expect(s).toMatch(/root cause/i)
  expect(s).toMatch(/same/i)
  expect(s).toContain("expected 5 got 3")
  expect(s).toContain("signals.py")
  expect(s).not.toMatch(/DIFFERENT approach/i) // NOT the old generic steer
})
test("diagnose: varied signatures → lists distinct, no single wrong root", () => {
  const s = diagnose(["AssertionError: expected 5 got 3", "ImportError: no module named x"], ["a.py"])
  expect(s).toMatch(/different/i)
  expect(s).toMatch(/assertion/i)
  expect(s).toMatch(/import/i)
})
test("diagnose: empty notes → safe generic", () => {
  expect(diagnose([], [])).toMatch(/failed verify|failing line/i)
})

// ── sidefx (#3) ──────────────────────────────────────────────────────────────────────────────────────
test("nonIdempotentEffect flags installs / migrations / network / push / service; safe calls → null", () => {
  const e = (cmd: string) => nonIdempotentEffect("bash", { command: cmd })
  expect(e("pip install evil")?.kind).toBe("package-install")
  expect(e("npm install left-pad")?.kind).toBe("package-install")
  expect(e("alembic upgrade head")?.kind).toBe("db-migration")
  expect(e("python manage.py migrate")?.kind).toBe("db-migration")
  expect(e("curl -X POST https://x/y -d @b")?.kind).toBe("network-mutation")
  expect(e("git push origin main")?.kind).toBe("vcs-push")
  expect(e("docker run -d img")?.kind).toBe("service-start")
  expect(e("echo hi && ls")).toBeNull()
  expect(e("sed -i 's/a/b/' f.py")).toBeNull()      // a file edit — reverted by the checkpoint, not a side effect
  expect(nonIdempotentEffect("str_replace", { file_path: "x" })).toBeNull()
})
test("renderLedger: empty → no line; non-empty → the double-apply warning vocabulary", () => {
  expect(renderLedger([])).toBe("")
  const s = renderLedger([{ kind: "package-install", detail: "pip install evil" }])
  expect(s).toMatch(/did NOT undo/i)
  expect(s).toMatch(/double.apply/i)
  expect(s).toMatch(/idempotent/i)
  expect(s).toContain("pip install evil")
})

// ── convrewind (#1) ──────────────────────────────────────────────────────────────────────────────────
function msgs(): Msg[] {
  return [
    { info: { id: "0001", role: "user", sessionID: "s1" }, parts: [{ type: "text", text: "task" }] },
    { info: { id: "0002", role: "assistant", sessionID: "s1" }, parts: [{ type: "text", text: "green work" }] },
    { info: { id: "0003", role: "assistant", sessionID: "s1" }, parts: [{ type: "tool", tool: "str_replace" }] },
    { info: { id: "0004", role: "tool", sessionID: "s1" }, parts: [{ type: "tool-result", text: "RED" }] },
    { info: { id: "0005", role: "assistant", sessionID: "s1" }, parts: [{ type: "tool", tool: "str_replace" }] },
    { info: { id: "0006", role: "tool", sessionID: "s1" }, parts: [{ type: "tool-result", text: "RED" }] },
  ]
}
test("collapseFailedSpan drops the span > boundary in place + injects ONE summary; pairs never split", () => {
  const m = msgs()
  const r = collapseFailedSpan(m, "0002", "🔄 reverted 2 attempts; files are back at green")
  expect(r.applied).toBe(true)
  expect(r.dropped).toBe(4)                         // 0003..0006 gone
  expect(m.filter((x) => (x.info.id as string) > "0002" && x.parts?.[0]?.type !== "text").length).toBe(0)
  const summaries = m.filter((x) => x.parts?.some((p: any) => typeof p.text === "string" && p.text.includes("back at green")))
  expect(summaries.length).toBe(1)                  // exactly one summary injected
  expect(m.length).toBe(3)                          // 0001, 0002, + summary
})
test("collapseFailedSpan degrades honestly with no boundary → array UNCHANGED", () => {
  const m = msgs(); const before = m.length
  const r = collapseFailedSpan(m, undefined, "x")
  expect(r.applied).toBe(false)
  expect(m.length).toBe(before)
})
test("collapseFailedSpan: empty span (nothing past boundary) → no-op", () => {
  const m = msgs()
  const r = collapseFailedSpan(m, "0006", "x")
  expect(r.applied).toBe(false)
  expect(m.length).toBe(6)
})
