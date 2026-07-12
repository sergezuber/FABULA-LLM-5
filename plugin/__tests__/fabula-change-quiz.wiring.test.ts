// Wiring test: the change-quiz gate must FIRE ITSELF — a green verify_done with an unexplained source
// change is downgraded and steered to change_quiz. Tool grading hits the aux model (network); here we
// prove the deterministic gate glue.
import { test, expect } from "bun:test"
import { FabulaChangeQuiz } from "../fabula-change-quiz"

async function plugin() { return (await FabulaChangeQuiz({} as any)) as any }
const GREEN = "✅ VERIFIED DONE — `pytest` (pytest) passed.\n\n--- output ---\nok"

test("exposes change_quiz tool + gate hooks", async () => {
  const p = await plugin()
  expect(p.tool?.change_quiz).toBeDefined()
  expect(typeof p["chat.message"]).toBe("function")
  expect(typeof p["tool.execute.after"]).toBe("function")
})

test("green verify AFTER a source edit → downgraded + change-quiz steer", async () => {
  const p = await plugin()
  const sid = "cq-src"
  await p["chat.message"]({ sessionID: sid })
  await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "src/store.ts" } }, { output: "ok", metadata: {} })
  const o = { output: GREEN, metadata: { passed: true } }
  await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
  expect(o.output).toContain("NOT YET DONE (change-quiz gate)")
  expect(o.output).toContain("change_quiz")
  expect(o.output).not.toContain("✅ VERIFIED DONE")
  expect(o.metadata.changeQuiz).toBe("steered")
})

test("green verify with NO source edit → untouched (nothing to quiz)", async () => {
  const p = await plugin()
  const sid = "cq-nosrc"
  await p["chat.message"]({ sessionID: sid })
  await p["tool.execute.after"]({ tool: "create_file", sessionID: sid, args: { file_path: "README.md" } }, { output: "ok", metadata: {} })
  const o = { output: GREEN, metadata: { passed: true } }
  await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o)
  expect(o.output).toBe(GREEN)
})

test("gate fires only once per task", async () => {
  const p = await plugin()
  const sid = "cq-once"
  await p["chat.message"]({ sessionID: sid })
  await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "a.ts" } }, { output: "ok", metadata: {} })
  const o1 = { output: GREEN, metadata: { passed: true } }
  await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o1)
  expect(o1.output).toContain("change-quiz gate")
  const o2 = { output: GREEN, metadata: { passed: true } }
  await p["tool.execute.after"]({ tool: "verify_done", sessionID: sid, args: {} }, o2)
  expect(o2.output).toBe(GREEN) // already steered → quiet
})

test("2nd trigger (strong): the change-quiz requirement is planted RIGHT ON the source-edit result — no verify_done needed", async () => {
  const p = await plugin()
  const sid = "cq-inject"
  await p["chat.message"]({ sessionID: sid })
  // model edits source (may never call verify_done) → the edit RESULT carries the requirement
  const edit = { output: "Edited calc.py (1 replacement).", metadata: {} }
  await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "calc.py" } }, edit)
  expect(edit.output).toContain("change_quiz")
  expect(edit.output).toContain("Edited calc.py") // original result preserved
  expect(edit.metadata.changeQuiz).toBe("reminded")
  // fires once — a later edit is not re-steered
  const edit2 = { output: "Edited calc.py again.", metadata: {} }
  await p["tool.execute.after"]({ tool: "str_replace", sessionID: sid, args: { path: "calc.py" } }, edit2)
  expect(edit2.output).toBe("Edited calc.py again.")
})

test("2nd trigger: no reminder on a non-source edit", async () => {
  const p = await plugin()
  const sid = "cq-noinject"
  await p["chat.message"]({ sessionID: sid })
  const edit = { output: "Created README.md", metadata: {} }
  await p["tool.execute.after"]({ tool: "create_file", sessionID: sid, args: { file_path: "README.md" } }, edit)
  expect(edit.output).toBe("Created README.md")
})

test("kill-switch FABULA_CHANGE_QUIZ=0 disables the whole plugin", async () => {
  const prev = process.env.FABULA_CHANGE_QUIZ
  process.env.FABULA_CHANGE_QUIZ = "0"
  try {
    const p = (await FabulaChangeQuiz({} as any)) as any
    expect(p.tool).toBeUndefined()
    expect(p["tool.execute.after"]).toBeUndefined()
  } finally {
    if (prev === undefined) delete process.env.FABULA_CHANGE_QUIZ
    else process.env.FABULA_CHANGE_QUIZ = prev
  }
})
